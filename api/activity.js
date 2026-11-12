import { timingSafeEqual } from 'node:crypto';

const envClean = v => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
let URL_ = envClean(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
if (URL_ && !/^https?:\/\//i.test(URL_)) URL_ = 'https://' + URL_;
URL_ = URL_.replace(/\/+$/, '');
const TOK = envClean(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
const NOW_TTL = 6 * 3600;

const redis = async cmds => {
  let r;
  try { r = await fetch(URL_ + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${TOK}` }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(8000) }); }
  catch (e) { throw new Error(`redis unreachable (${URL_ ? new URL(URL_).host : 'no URL'}): ${e?.cause?.code || e?.message}`); }
  if (!r.ok) throw new Error(`redis ${r.status}: ${(await r.text()).slice(0, 140)}`);
  const out = await r.json();
  const bad = out.find(x => x.error);
  if (bad) throw new Error('redis command error: ' + String(bad.error).slice(0, 140));
  return out.map(x => x.result);
};
const clean = (v, n = 80) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').slice(0, n);
const cover = (src, id) => (/^steam$/i.test(src) && /^\d{1,10}$/.test(id) ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg` : null);
const coverMemo = new Map();
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const steamIdOf = url => (String(url || '').match(/\/steam\/apps\/(\d{1,10})\//) || [])[1] || null;

const KNOWN_COVERS = {
  payday3: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1272080/header.jpg',
  needforspeedmostwanted: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1262560/header.jpg',
  needforspeedmostwanted510: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1262560/header.jpg',
  approximatelyup: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3904850/d91f2e97c92cb98f97b3c773ff1e2d84bf6bc127/header.jpg',
  lemansultimate: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2399420/header.jpg',
  efootballpes2021seasonupdate: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1259970/header.jpg',
  efootballpes2021: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1259970/header.jpg',
  assettocorsa: 'https://cdn.cloudflare.steamstatic.com/steam/apps/244210/header.jpg',
  assettocorsacompetizione: 'https://cdn.cloudflare.steamstatic.com/steam/apps/805550/header.jpg',
  residentevilrequiem: 'https://cdn2.steamgriddb.com/grid/956adefb0eb473d0cd054107659ab6fd.jpg',
  thelegendofzeldaocarinaoftime: 'https://cdn2.steamgriddb.com/grid/f711cc70dbdab88f32389ec84e56a242.png',
  residentevil0: 'https://cdn.cloudflare.steamstatic.com/steam/apps/339340/header.jpg'
};

const SGDB_KEY = envClean(process.env.STEAMGRIDDB_API_KEY || process.env.SGDB_API_KEY);
const SGDB_BASE = 'https://www.steamgriddb.com/api/v2';
const COVER_VER = 'v3';
const BAD_STEAM_ID = '3764200';
const GRID_QUERY = 'dimensions=600x900,342x482,660x930&types=static&nsfw=false&humor=false';
const coverMiss = new Map();

async function headOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'uWaazy-hub/2.0' }, signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}
async function jsonGet(url, ms = 3000) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'uWaazy-hub/2.0', Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function sgdbGet(path) {
  if (!SGDB_KEY) return null;
  try {
    const r = await fetch(SGDB_BASE + path, { headers: { Authorization: `Bearer ${SGDB_KEY}`, 'User-Agent': 'uWaazy-hub/2.0' }, signal: AbortSignal.timeout(3500) });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.success === false ? null : j?.data || null;
  } catch { return null; }
}
async function sgdbSearch(name) {
  const want = normName(name);
  const plain = String(name || '').replace(/[™®]/g, '').replace(/\s*[:–—-]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  for (const term of [...new Set([plain, String(name || '').trim()])].filter(Boolean)) {
    const hits = await sgdbGet('/search/autocomplete/' + encodeURIComponent(term));
    if (!Array.isArray(hits) || !hits.length) continue;
    const exact = hits.find(h => normName(h.name) === want);
    if (exact) return { id: exact.id, exact: true };
    const close = hits.find(h => { const n = normName(h.name); return want.length >= 5 && n.length >= 5 && (n.startsWith(want) || want.startsWith(n)); });
    return { id: (close || hits[0]).id, exact: false };
  }
  return null;
}
function bestGrid(list) {
  if (!Array.isArray(list)) return null;
  const usable = list.filter(g => g?.url && !g.nsfw && !g.humor && !/webm|mp4/i.test(String(g.mime || g.url)));
  usable.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  return usable[0]?.url || null;
}
async function steamGridDbCover(game) {
  if (!SGDB_KEY || !game?.name) return null;
  const sid = steamIdOf(game.cover);
  const steamId = sid && sid !== BAD_STEAM_ID ? sid : null;
  const found = await sgdbSearch(game.name);
  let url = null;
  if (found?.exact) url = bestGrid(await sgdbGet(`/grids/game/${found.id}?${GRID_QUERY}`));
  if (!url && steamId) url = bestGrid(await sgdbGet(`/grids/steam/${steamId}?${GRID_QUERY}`));
  if (!url && found && !found.exact) url = bestGrid(await sgdbGet(`/grids/game/${found.id}?${GRID_QUERY}`));
  return url && (await headOk(url)) ? url : null;
}
async function steamCover(id) {
  for (const file of ['library_600x900.jpg', 'header.jpg']) {
    const u = `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/${file}`;
    if (await headOk(u)) return u;
  }
  const j = await jsonGet(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`);
  const img = j?.[id]?.data?.header_image;
  return img && (await headOk(img)) ? img : null;
}
async function steamSearchId(name) {
  const plain = String(name || '').replace(/[™®:–—]/g, ' ').replace(/\s+/g, ' ').trim();
  const want = normName(name);
  for (const t of [...new Set([plain, name])].filter(Boolean)) {
    const j = await jsonGet('https://store.steampowered.com/api/storesearch/?cc=us&l=en&term=' + encodeURIComponent(t));
    const items = j?.items || [];
    const hit = items.find(i => normName(i.name) === want)
      || items.find(i => { const n = normName(i.name); return want.length >= 5 && n.length >= 5 && (n.startsWith(want) || want.startsWith(n)); });
    if (hit?.id) return String(hit.id);
  }
  return null;
}
function knownCover(name) {
  const key = normName(name);
  if (KNOWN_COVERS[key]) return KNOWN_COVERS[key];
  for (const [k, url] of Object.entries(KNOWN_COVERS)) {
    if (key.length >= 6 && (key.includes(k) || k.includes(key))) return url;
  }
  return null;
}
async function lookupCover(game) {
  if (!game?.name) return null;
  const viaGrid = await steamGridDbCover(game);
  if (viaGrid) return viaGrid;
  const sid = steamIdOf(game.cover);
  if (sid && sid !== BAD_STEAM_ID) {
    const v = await steamCover(sid);
    if (v) return v;
  }
  const found = await steamSearchId(game.name);
  if (found) {
    const v = await steamCover(found);
    if (v) return v;
  }
  if (game.cover && !game.cover.includes(`apps/${BAD_STEAM_ID}`) && (await headOk(game.cover))) return game.cover;
  return knownCover(game.name);
}
async function resolveCover(game, { force = false } = {}) {
  if (!game?.name) return game?.cover || null;
  const key = normName(game.name);
  const rkey = `hub:cover:${COVER_VER}:${key}`;
  const hit = coverMemo.get(key);
  if (!force && hit && Date.now() - hit.at < 12 * 3600e3) return hit.url;
  if (!force && (coverMiss.get(key) || 0) > Date.now()) return knownCover(game.name) || game.cover || null;
  if (!force && URL_ && TOK) {
    try {
      const [c] = await redis([['GET', rkey]]);
      if (c && c !== '-') { coverMemo.set(key, { at: Date.now(), url: c }); return c; }
    } catch {}
  }
  const url = await lookupCover(game);
  if (url) {
    coverMemo.set(key, { at: Date.now(), url });
    coverMiss.delete(key);
    if (URL_ && TOK) { try { await redis([['SET', rkey, url, 'EX', 30 * 86400]]); } catch {} }
    return url;
  }
  coverMiss.set(key, Date.now() + 10 * 60e3);
  return game.cover || null;
}
const ok = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

const YGP_USER = (process.env.YGP_USER || 'uWaazy').trim();
const YGP_URL = (process.env.YGP_GAMES_URL || '').trim();
const YGP_COOKIE = (process.env.YGP_COOKIE || '').trim();
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
let ygpCache = { at: 0, value: [], diag: null };

const pick = (o, keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== '') return v; } return null; };
const DATE_KEYS = ['occurredAt', 'happenedAt', 'eventDate', 'date', 'timestamp', 'time', 'lastPlayedAt', 'lastPlayed', 'last_played', 'playedAt', 'lastActivityAt', 'lastActivity', 'updatedAt', 'updated_at', 'modifiedAt', 'endedAt', 'completedAt', 'startedAt', 'addedAt', 'createdAt'];
const NAME_KEYS = ['gameTitle', 'name', 'title', 'gameName', 'game.name', 'game.title'];
const COVER_KEYS = ['gameCoverUrl', 'gameImageUrl', 'cover', 'coverUrl', 'coverImage', 'image', 'imageUrl', 'headerImage', 'header', 'poster', 'thumbnail', 'artwork', 'game.cover', 'game.coverUrl', 'game.image', 'game.imageUrl', 'game.headerImage'];
const MIN_KEYS = ['playtimeMinutes', 'minutesPlayed', 'minutes', 'playtime', 'timePlayed', 'totalMinutes'];
const HRS_KEYS = ['hoursPlayed', 'hours', 'playtimeHours'];

function normGame(o, origin) {
  const name = pick(o, NAME_KEYS);
  if (typeof name !== 'string') return null;
  let cover = pick(o, COVER_KEYS);
  if (cover && typeof cover === 'object') cover = pick(cover, ['url', 'src', 'large', 'medium']);
  cover = typeof cover === 'string' ? (cover.startsWith('//') ? 'https:' + cover : cover.startsWith('/') ? origin + cover : cover) : null;
  if (cover && !/^https?:\/\//i.test(cover)) cover = null;
  let date = null;
  for (const k of DATE_KEYS) { const v = pick(o, [k]); const t = v ? new Date(v) : null; if (t && !Number.isNaN(t.getTime())) { date = t.toISOString(); break; } }
  const mins = Number(pick(o, MIN_KEYS)), hrs = Number(pick(o, HRS_KEYS));
  const hours = Number.isFinite(hrs) && hrs > 0 ? hrs : Number.isFinite(mins) && mins > 0 ? mins / 60 : null;
  return { name: clean(name), cover, endedAt: date, hours: hours ? Math.round(hours * 10) / 10 : null };
}
function findGameLists(node, origin, out = [], depth = 0) {
  if (!node || depth > 12) return out;
  if (Array.isArray(node)) {
    const games = node.map(x => (x && typeof x === 'object' ? normGame(x, origin) : null)).filter(Boolean);
    if (games.length >= 1 && games.length >= node.length * 0.6) out.push(games);
    node.forEach(x => findGameLists(x, origin, out, depth + 1));
  } else if (typeof node === 'object') {
    for (const v of Object.values(node)) findGameLists(v, origin, out, depth + 1);
  }
  return out;
}
function bestList(lists) {
  if (!lists.length) return [];
  const score = l => l.length + l.filter(g => g.endedAt).length * 3 + l.filter(g => g.cover).length;
  return lists.sort((a, b) => score(b) - score(a))[0];
}
function jsonBlobsFromHtml(html) {
  const blobs = [];
  const nd = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nd) { try { blobs.push(JSON.parse(nd[1])); } catch {} }
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\[\s\S])*")\]\)/g)) { try { flight += JSON.parse(m[1]); } catch {} }
  for (const line of flight.split('\n')) {
    const m = line.match(/^[0-9a-zA-Z]+:(?:I|HL|T[0-9a-f]+,)?([\[{][\s\S]*)$/);
    if (m) { try { blobs.push(JSON.parse(m[1])); } catch {} }
  }
  for (const m of html.matchAll(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/gi)) { try { blobs.push(JSON.parse(m[1])); } catch {} }
  return blobs;
}
async function fetchYgp() {
  if (Date.now() - ygpCache.at < 60e3) return ygpCache;
  const diag = { tried: [] };
  let games = [];
  const urls = YGP_URL ? [YGP_URL] : [`https://yourgamerprofile.com/${encodeURIComponent(YGP_USER)}?view=games&dir=desc`, `https://yourgamerprofile.com/${encodeURIComponent(YGP_USER)}?view=games`, `https://yourgamerprofile.com/${encodeURIComponent(YGP_USER)}`];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': `https://yourgamerprofile.com/${encodeURIComponent(YGP_USER)}?view=games`, ...(YGP_COOKIE ? { Cookie: YGP_COOKIE } : {}) }, signal: AbortSignal.timeout(8000) });
      const body = await r.text();
      const origin = new URL(url).origin;
      const info = { url, status: r.status, bytes: body.length, type: r.headers.get('content-type') || '', blocked: /Just a moment|cf-chl|Attention Required|captcha/i.test(body.slice(0, 4000)) };
      diag.tried.push(info);
      if (!r.ok) continue;
      let blobs;
      if (/json/i.test(info.type) || /^\s*[\[{]/.test(body)) { try { blobs = [JSON.parse(body)]; } catch { blobs = []; } }
      else blobs = jsonBlobsFromHtml(body);
      info.blobs = blobs.length;
      const list = bestList(blobs.flatMap(b => findGameLists(b, origin)));
      info.games = list.length;
      if (list.length) {
        const dated = list.some(g => g.endedAt);
        games = (dated ? [...list].sort((a, b) => (Date.parse(b.endedAt || 0) || 0) - (Date.parse(a.endedAt || 0) || 0)) : list).slice(0, 40);
        diag.sorted = dated ? 'by date' : 'page order';
        break;
      }
    } catch (e) { diag.tried.push({ url, error: String(e?.message || e) }); }
  }
  const allBlocked = !games.length && diag.tried.length && diag.tried.every(t => t.blocked || t.status === 403);
  ygpCache = { at: Date.now() + (allBlocked ? 14 * 60e3 : 0), value: games, diag };
  return ygpCache;
}
const sameName = (a, b) => a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === b.name.toLowerCase().replace(/[^a-z0-9]/g, '');
function mergeRecent(...lists) {
  const isBad = u => !u || u.includes('apps/3764200');
  const out = [];
  for (const g of lists.flat()) {
    const i = out.findIndex(x => sameName(x, g));
    if (i < 0) out.push({ ...g });
    else {
      const a = out[i], newer = (Date.parse(g.endedAt || 0) || 0) > (Date.parse(a.endedAt || 0) || 0);
      const pickCover = !isBad(g.cover) ? g.cover : (!isBad(a.cover) ? a.cover : null);
      out[i] = { ...(newer ? { ...a, ...g } : { ...g, ...a }), cover: pickCover, hours: (newer ? g.hours : a.hours) || a.hours || g.hours };
    }
  }
  const dated = out.filter(g => g.endedAt).sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
  return [...dated, ...out.filter(g => !g.endedAt)].slice(0, 3);
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
      let now = null, pushed = [], redisError = null;
      if (URL_ && TOK) {
        try {
          const values = await redis([['GET', 'hub:now'], ['GET', 'hub:recent']]);
          now = values[0] ? JSON.parse(values[0]) : null;
          pushed = values[1] ? JSON.parse(values[1]) : [];
        } catch (e) { redisError = String(e?.message || e); }
      }
      const ygp = await fetchYgp();
      const recent = mergeRecent(pushed, ygp.value);
      let healedAny = false;
      await Promise.race([
        Promise.all([...recent, ...(now ? [now] : [])].map(async g => {
          const resolved = await resolveCover(g);
          if (resolved) {
            if (!g.cover || g.cover !== resolved) healedAny = true;
            g.cover = resolved;
          }
        })),
        new Promise(r => setTimeout(r, 4500))
      ]);
      if (healedAny && pushed.length && URL_ && TOK) {
        try {
          const healed = pushed.map(p => {
            const match = recent.find(r => sameName(r, p));
            return match && match.cover ? { ...p, cover: match.cover } : p;
          });
          await redis([['SET', 'hub:recent', JSON.stringify(healed)]]);
        } catch {}
      }
      const source = now ? 'playnite-live' : pushed.length ? 'playnite-history' : ygp.value.length ? 'ygp' : 'empty';
      return res.json({ now, recent, source, ...(req.query?.debug === '1' ? { _debug: { ygp: ygp.diag, redis: !(URL_ && TOK) ? 'not configured' : redisError ? 'ERROR: ' + redisError : 'ok', pushed: pushed.length } } : {}) });
    }
    if (!URL_ || !TOK) return res.status(500).json({ error: 'Redis (Upstash) env vars missing for Playnite live updates' });
    if (req.method !== 'POST') return res.status(405).end();

    const secret = process.env.HUB_SECRET || '';
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (secret.length < 16 || !ok(given, secret)) return res.status(401).json({ error: 'unauthorized' });

    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const name = clean(b.name);
    if (!name) return res.status(400).json({ error: 'name required' });
    const isBadCover = id => !id || id === '3764200';
    const initialCover = isBadCover(clean(b.sourceId, 12)) ? null : cover(clean(b.source, 20), clean(b.sourceId, 12));
    const game = { name, cover: initialCover };
    game.cover = await resolveCover(game, { force: true });

    if (b.state === 'playing') {
      const startedAt = new Date(b.startedAt).toString() === 'Invalid Date' ? new Date().toISOString() : new Date(b.startedAt).toISOString();
      await redis([['SET', 'hub:now', JSON.stringify({ ...game, startedAt }), 'EX', NOW_TTL]]);
    } else if (b.state === 'idle') {
      const [cur] = await redis([['GET', 'hub:recent']]);
      const hours = Math.max(0, Math.round(Number(b.totalHours) * 10) / 10) || null;
      const list = [{ ...game, endedAt: new Date().toISOString(), hours }, ...(cur ? JSON.parse(cur) : []).filter(g => g.name !== name)].slice(0, 3);
      await redis([['DEL', 'hub:now'], ['SET', 'hub:recent', JSON.stringify(list)]]);
    } else return res.status(400).json({ error: 'state must be playing|idle' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
