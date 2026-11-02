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
  const out = [];
  for (const g of lists.flat()) {
    const i = out.findIndex(x => sameName(x, g));
    if (i < 0) out.push({ ...g });
    else {
      const a = out[i], newer = (Date.parse(g.endedAt || 0) || 0) > (Date.parse(a.endedAt || 0) || 0);
      out[i] = { ...(newer ? { ...a, ...g } : { ...g, ...a }), cover: a.cover || g.cover, hours: (newer ? g.hours : a.hours) || a.hours || g.hours };
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
    const game = { name, cover: cover(clean(b.source, 20), clean(b.sourceId, 12)) };

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
