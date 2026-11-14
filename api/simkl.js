import { timingSafeEqual } from 'node:crypto';

const UA = 'uWaazy-hub/1.6 (https://github.com/uWaazy/uWaazy)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const APP_NAME = 'wagner-hub';
const APP_VERSION = '1.6';
const LIVE_CACHE_MS = 10e3;
const META_CACHE_MS = 6 * 36e5;

const envClean = v => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
const TMDB_KEY = envClean(process.env.TMDB_API_KEY || '');
const TOP_POSTERS_KEY = envClean(process.env.TOP_POSTERS_KEY || process.env.RPDB_API_KEY || '');

let R_URL = envClean(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
if (R_URL && !/^https?:\/\//i.test(R_URL)) R_URL = 'https://' + R_URL;
R_URL = R_URL.replace(/\/+$/, '');
const R_TOK = envClean(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
const rcmd = async (...cmds) => {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}` }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(4500) });
    return r.ok ? (await r.json()).map(x => x.result) : null;
  } catch { return null; }
};
const jparse = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const okSecret = (a, b) => {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const memo = new Map();
const cached = async (key, ttl, fn) => {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
};
const pad2 = n => String(n).padStart(2, '0');
const sxe = (s, e) => (s != null && e != null ? `S${pad2(s)}E${pad2(e)}` : e != null ? `E${pad2(e)}` : null);
const toIso = v => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const ts = v => Date.parse(v || 0) || 0;
const posterUrl = key => key ? `https://simkl.net/posters/${key}_0.jpg` : null;

const decode = s => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const stripTags = s => decode(String(s || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const toSeconds = txt => {
  const m = String(txt || '').match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
};

const isGenericEpName = name => !name || /^(?:Epis[oó]dio|Episode|Cap[ií]tulo|Ep\.?)\s*\d+$/i.test(String(name).trim());

async function tmdbGet(path, params = {}) {
  if (!TMDB_KEY) return null;
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('api_key', TMDB_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function parseEpisodeCode(epStr, season, number) {
  if (number != null) return { season: season ?? 1, number: Number(number) };
  if (!epStr) return { season: null, number: null };
  const m1 = String(epStr).match(/S(\d{1,2})E(\d{1,4})/i);
  if (m1) return { season: +m1[1], number: +m1[2] };
  const m2 = String(epStr).match(/(?:Ep\.?|E)\s*(\d{1,4})/i);
  if (m2) return { season: 1, number: +m2[1] };
  return { season: null, number: null };
}

async function resolveTmdbI18n({ title, type, imdbId, tmdbId, season, number, fallbackEpTitle, fallbackPoster }) {
  if (!title && !imdbId && !tmdbId) return null;
  const { season: sNum, number: eNum } = parseEpisodeCode(null, season, number);
  const key = `tmdb:${type}:${imdbId || ''}:${tmdbId || ''}:${title}:${sNum || ''}:${eNum || ''}`;
  return cached(key, META_CACHE_MS, async () => {
    let kind = type === 'movie' ? 'movie' : 'tv';
    let tid = tmdbId ? Number(tmdbId) : null;

    if (!tid && imdbId) {
      const found = await tmdbGet(`/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id', language: 'en-US' });
      const list = (kind === 'movie' ? found?.movie_results : found?.tv_results) || found?.tv_results || found?.movie_results || [];
      if (list.length) {
        tid = list[0].id;
        if (!found?.movie_results?.length && found?.tv_results?.length) kind = 'tv';
      }
    }
    if (!tid && title) {
      const srch = await tmdbGet(`/search/${kind}`, { query: title, language: 'en-US' });
      if (srch?.results?.length) tid = srch.results[0].id;
    }
    if (!tid) return null;

    const langs = [['pt', 'pt-BR'], ['en', 'en-US'], ['es', 'es-ES']];
    const i18n = {};
    let tmdbRuntimeMin = null;

    await Promise.all(langs.map(async ([short, full]) => {
      let locTitle = title;
      let locEp = fallbackEpTitle || null;
      let locPoster = fallbackPoster || null;

      const det = await tmdbGet(`/${kind}/${tid}`, { language: full });
      if (det) {
        locTitle = det.title || det.name || title;
        if (det.poster_path) locPoster = `https://image.tmdb.org/t/p/w500${det.poster_path}`;
        const rt = Number(det.runtime) || Number(det.episode_run_time?.[0]) || 0;
        if (rt > 0 && !tmdbRuntimeMin) tmdbRuntimeMin = rt;
      }
      if (TOP_POSTERS_KEY && imdbId) {
        locPoster = `https://api.ratingposterdb.com/${encodeURIComponent(TOP_POSTERS_KEY)}/imdb/poster-default/${encodeURIComponent(imdbId)}.jpg?lang=${short}`;
      }
      if (kind === 'tv' && eNum != null) {
        const epDet = await tmdbGet(`/tv/${tid}/season/${sNum || 1}/episode/${eNum}`, { language: full });
        if (epDet) {
          if (epDet.name && (!isGenericEpName(epDet.name) || !fallbackEpTitle)) locEp = epDet.name;
          if (Number(epDet.runtime) > 0) tmdbRuntimeMin = Number(epDet.runtime);
        }
      }
      i18n[short] = { title: locTitle, episodeTitle: locEp, poster: locPoster };
    }));

    const enEp = i18n.en?.episodeTitle;
    if (enEp && !isGenericEpName(enEp)) {
      for (const s of ['pt', 'es']) {
        if (i18n[s] && isGenericEpName(i18n[s].episodeTitle)) i18n[s].episodeTitle = enEp;
      }
    }

    return { i18n, tmdbId: tid, tmdbRuntimeMin };
  });
}

export function parseNowWatching(html) {
  if (!html) return null;
  const barIdx = html.search(/id=["']simklScrobbleBar["']/i);
  if (barIdx >= 0) {
    const startTagStart = Math.max(0, html.lastIndexOf('<div', barIdx));
    const chunk = html.slice(startTagStart, barIdx + 5500);
    const openTag = chunk.match(/^<div[^>]*>/i)?.[0] || '';
    const dsStarted = Number(openTag.match(/data-started=["'](\d+)["']/i)?.[1] || 0);
    const dsRuntime = Number(openTag.match(/data-runtime=["'](\d+)["']/i)?.[1] || 0);
    const dsProgStart = Number(openTag.match(/data-progress-at-start=["']([\d.]+)["']/i)?.[1] || 0);

    const titleRaw = chunk.match(/<span[^>]*class=["'][^"']*SimklScrobbleTitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
    const title = stripTags(titleRaw);
    if (title) {
      const linkMatch = chunk.match(/<a[^>]*class=["'][^"']*SimklScrobbleBarLink[^"']*["'][^>]*href=["']([^"']+)["']/i)
        || chunk.match(/<a[^>]*href=["'](\/(?:movies|tv|anime)\/[^"']+)["'][^>]*class=["'][^"']*SimklScrobbleBarLink/i);
      const href = linkMatch?.[1] || null;
      let type = href?.startsWith('/anime/') ? 'anime' : href?.startsWith('/tv/') ? 'show' : 'movie';
      const sid = href?.match(/\/(?:movies|tv|anime)\/(\d+)/i)?.[1] || null;

      const posterMatch = chunk.match(/<img[^>]*class=["'][^"']*SimklScrobblePosterImg[^"']*["'][^>]*src=["']([^"']+)["']/i)
        || chunk.match(/<img[^>]*src=["']([^"']+)["'][^>]*class=["'][^"']*SimklScrobblePosterImg/i)
        || chunk.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
      let poster = posterMatch?.[1] || null;
      if (poster && poster.startsWith('//')) poster = 'https:' + poster;

      let episode = null, episodeTitle = null, season = null, number = null;
      const titlesBlock = chunk.match(/<div[^>]*class=["'][^"']*SimklScrobbleTitles\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
      const afterH3 = titlesBlock.split(/<\/h3>/i)[1] || '';
      const subText = stripTags(afterH3);
      if (subText) {
        const sxeMatch = subText.match(/^(?:S(\d{1,2})\s*E(\d{1,4})|(\d{1,2})x(\d{1,4}))\b\s*[-–·:]?\s*(.*)$/i);
        const epMatch = !sxeMatch && subText.match(/^(?:Ep\.?|Episode)\s*(\d{1,4})\b\s*[-–·:]?\s*(.*)$/i);
        if (sxeMatch) {
          season = +(sxeMatch[1] ?? sxeMatch[3]);
          number = +(sxeMatch[2] ?? sxeMatch[4]);
          episode = sxe(season, number);
          episodeTitle = sxeMatch[5]?.trim() || null;
          if (type === 'movie') type = 'show';
        } else if (epMatch) {
          season = 1;
          number = Number(epMatch[1]);
          episode = `Ep. ${number}`;
          episodeTitle = epMatch[2]?.trim() || null;
          if (type === 'movie') type = 'anime';
        } else {
          episodeTitle = subText;
        }
      }

      const pctMatch = chunk.match(/class=["'][^"']*(?:SimklScrobbleSidePercent|SimklScrobbleBigPercent)[^"']*["'][^>]*>\s*(\d{1,3})\s*%/i);
      const startedAgoTxt = stripTags(chunk.match(/class=["'][^"']*SimklScrobbleStartedAgo[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '');
      const agoSec = toSeconds(startedAgoTxt);
      const nowSec = Math.floor(Date.now() / 1000);
      const startedAtMs = dsStarted > 1e9 && dsStarted <= nowSec + 60
        ? dsStarted * 1000
        : agoSec > 0 ? Date.now() - agoSec * 1000 : Date.now();
      const runtimeMin = dsRuntime > 0 ? dsRuntime : (type === 'movie' ? 105 : 25);
      const durationSec = runtimeMin * 60;
      const elapsedSec = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
      const computedPct = durationSec > 0 ? Math.min(99, Math.round(dsProgStart + (elapsedSec / durationSec) * 100)) : 0;
      const progress = pctMatch ? Math.max(computedPct, Number(pctMatch[1])) : computedPct;

      return {
        live: true,
        paused: false,
        title,
        type,
        sid,
        season,
        number,
        episode,
        episodeTitle,
        watchedAt: new Date(startedAtMs).toISOString(),
        startedAt: startedAtMs,
        startProgress: dsProgStart,
        runtimeMin,
        durationSec,
        elapsedSec,
        progress: Math.max(0, Math.min(99, progress)),
        poster,
        url: href ? (href.startsWith('http') ? href : 'https://simkl.com' + href) : null,
        source: 'simkl-scrobble-bar'
      };
    }
  }

  const idx = html.search(/NOW\s+WATCHING/i);
  if (idx < 0) return null;
  const after = html.slice(idx, idx + 4000);
  const text = stripTags(after);
  const m = text.match(/NOW WATCHING\s+(?:Started\s+(.+?)\s+ago\s+)?(.+?)\s+(?:\(\d{4}[^)]*\)\s+)?(\d{1,3})\s*%\s*WATCHED(?:\s+(.+?)\s+LEFT)?/i);
  if (!m) return null;

  let title = m[2].trim(), episode = null, episodeTitle = null, type = 'movie', season = null, number = null;
  const ep = title.match(/^(.*?)\s+(?:S(\d{1,2})\s*E(\d{1,4})|Ep\.?\s*(\d{1,4}))\b\s*[-–·:]?\s*(.*)$/i);
  if (ep) {
    title = ep[1].trim();
    type = ep[4] ? 'anime' : 'show';
    season = ep[4] ? 1 : +ep[2];
    number = ep[4] ? +ep[4] : +ep[3];
    episode = ep[4] ? `Ep. ${number}` : sxe(season, number);
    episodeTitle = ep[5].replace(/^["'“”]|["'“”]$/g, '').trim() || null;
  }
  const elapsed = toSeconds(m[1]);
  const left = toSeconds(m[4]);
  const progress = Math.max(0, Math.min(100, Number(m[3])));
  let runtimeMin = null;
  if (left && progress < 100) runtimeMin = Math.round(left / 60 / (1 - progress / 100));
  else if (elapsed && progress > 0) runtimeMin = Math.round(elapsed / 60 / (progress / 100));
  const finalRuntimeMin = runtimeMin || (type === 'movie' ? 105 : 25);

  const around = html.slice(Math.max(0, idx - 3500), idx + 800);
  const posters = [...around.matchAll(/(?:https?:)?\/\/[^"'\s)]*\/posters\/[^"'\s)]+?\.(?:jpg|jpeg|webp|png)/gi)].map(x => x[0]);
  const poster = posters.length ? (posters[posters.length - 1].startsWith('//') ? 'https:' + posters[posters.length - 1] : posters[posters.length - 1]) : null;
  const link = around.match(/href=["'](\/(?:movies|tv|anime)\/(\d+)[^"']*)["']/i);
  const startedAtMs = Date.now() - elapsed * 1000;

  return {
    live: true, paused: false, title, type, sid: link?.[2] || null, season, number, episode, episodeTitle,
    watchedAt: new Date(startedAtMs).toISOString(),
    startedAt: startedAtMs,
    startProgress: 0,
    runtimeMin: finalRuntimeMin,
    durationSec: finalRuntimeMin * 60,
    elapsedSec: elapsed,
    progress, poster,
    url: link ? 'https://simkl.com' + link[1] : null,
    source: 'simkl-live'
  };
}

let scrapeBlockedUntil = 0;
async function scrapeLive(uid, diag) {
  if (Date.now() < scrapeBlockedUntil) { diag.live = 'skipped: cloudflare cooldown'; return null; }
  return cached('live:' + uid, LIVE_CACHE_MS, async () => {
    const pages = [
      `https://simkl.com/${encodeURIComponent(uid)}/dashboard/`,
      `https://simkl.com/${encodeURIComponent(uid)}/`
    ];
    diag.live = [];
    for (const url of pages) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
          signal: AbortSignal.timeout(6500), redirect: 'follow'
        });
        const html = await r.text();
        const found = r.ok ? parseNowWatching(html) : null;
        diag.live.push({ url, status: r.status, bytes: html.length, hasBanner: /simklScrobbleBar|NOW\s+WATCHING/i.test(html), parsed: !!found,
          blocked: /cf-chl|Just a moment|Attention Required/i.test(html) });
        if (found) return found;
      } catch (e) { diag.live.push({ url, error: String(e?.message || e) }); }
    }
    if (diag.live.length && diag.live.every(x => x.status === 403 || x.blocked)) scrapeBlockedUntil = Date.now() + 15 * 60e3;
    return null;
  });
}

function hydratePushedLive(liveObj) {
  if (!liveObj || !liveObj.title) return null;
  const startedAt = Number(liveObj.startedAt) || Date.parse(liveObj.watchedAt || 0) || Date.now();
  const pushedAt = Number(liveObj.pushedAt) || startedAt;
  if (Date.now() - pushedAt > 180e3) return null;
  const runtimeMin = Number(liveObj.runtimeMin) || (liveObj.type === 'movie' ? 105 : 25);
  const totalSec = Number(liveObj.durationSec) > 0 ? Number(liveObj.durationSec) : runtimeMin * 60;
  const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (elapsedSec > totalSec + 900) return null;
  const baseProg = Number(liveObj.startProgress) || 0;
  const calcProg = totalSec > 0 ? Math.min(99, Math.round(baseProg + (elapsedSec / totalSec) * 100)) : (Number(liveObj.progress) || 0);
  const progress = liveObj.durationSec ? calcProg : Math.max(Number(liveObj.progress) || 0, calcProg);
  return {
    live: true,
    paused: false,
    title: liveObj.title,
    type: liveObj.type || 'movie',
    sid: liveObj.simklId || liveObj.sid || null,
    imdbId: liveObj.imdbId || null,
    tmdbId: liveObj.tmdbId || null,
    season: liveObj.season ?? null,
    number: liveObj.number ?? null,
    episode: liveObj.episode || null,
    episodeTitle: liveObj.episodeTitle || null,
    watchedAt: new Date(startedAt).toISOString(),
    startedAt,
    runtimeMin: Math.max(1, Math.round(totalSec / 60)),
    durationSec: totalSec,
    elapsedSec,
    progress: Math.min(99, progress),
    poster: liveObj.poster || null,
    i18n: liveObj.i18n || null,
    url: liveObj.url || 'https://simkl.com/8094166/dashboard/',
    source: liveObj.source || 'simkl-live-sync'
  };
}

async function saveLast(item) {
  const prev = jparse((await rcmd(['GET', 'hub:simkl:last']))?.[0]);
  if (prev && ts(prev.watchedAt) > ts(item.watchedAt) + 1000) return false;
  S.out = item;
  await rcmd(['SET', 'hub:simkl:last', JSON.stringify(item), 'EX', 7 * 86400]);
  return true;
}

const NUVIO_WEAK_GRACE_MS = 45e3;
const NUVIO_UNCONFIRMED_MS = 180e3;
const NUVIO_PAUSE_HOLD_MS = Math.max(1, Number(process.env.NUVIO_PAUSE_HOLD_MIN) || 3) * 60e3;

const S = { acts: null, actsAt: 0, sig: '', P: 0, addonLast: null, paused: null, lastDone: null, prevPaused: null, live: null, pushedLive: null, out: null, blockedUntil: 0 };
const BACKOFF_MS = 20 * 60e3;

const TRAKT_TTL_MS = 5000;
let traktMemo = { at: 0, val: null };

function mapTraktWatching(d, uid) {
  const started = Date.parse(d?.started_at || 0);
  const expires = Date.parse(d?.expires_at || 0);
  if (!started || !expires || expires <= Date.now()) return null;
  const isMovie = d.type === 'movie';
  const media = isMovie ? d.movie : d.show;
  if (!media?.title) return null;
  const ep = isMovie ? null : d.episode;
  const durationSec = Math.max(60, Math.round((expires - started) / 1000));
  const elapsedSec = Math.max(0, Math.round((Date.now() - started) / 1000));
  return {
    live: true,
    paused: false,
    title: media.title,
    type: isMovie ? 'movie' : 'show',
    imdbId: media.ids?.imdb || null,
    tmdbId: media.ids?.tmdb || null,
    season: ep?.season ?? null,
    number: ep?.number ?? null,
    episode: ep ? sxe(ep.season, ep.number) : null,
    episodeTitle: ep?.title || null,
    watchedAt: new Date(started).toISOString(),
    startedAt: started,
    runtimeMin: Math.max(1, Math.round(durationSec / 60)),
    durationSec,
    elapsedSec,
    progress: Math.min(99, Math.round((elapsedSec / durationSec) * 100)),
    poster: null,
    url: `https://simkl.com/${uid}/dashboard/`,
    source: 'trakt-live'
  };
}

async function traktLive(uid) {
  const clientId = envClean(process.env.TRAKT_CLIENT_ID || '');
  const user = envClean(process.env.TRAKT_USER || '');
  if (!clientId || !user) return null;
  if (Date.now() - traktMemo.at < TRAKT_TTL_MS) return traktMemo.val ? mapTraktWatching(traktMemo.raw, uid) : null;
  let raw = null;
  try {
    const r = await fetch(`https://api.trakt.tv/users/${encodeURIComponent(user)}/watching`, {
      headers: { 'trakt-api-key': clientId, 'trakt-api-version': '2', 'Content-Type': 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(3500)
    });
    if (r.status === 200) raw = await r.json();
  } catch {}
  const val = raw ? mapTraktWatching(raw, uid) : null;
  traktMemo = { at: Date.now(), val, raw };
  return val;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const id = (process.env.SIMKL_CLIENT_ID || '').trim();
  const token = (process.env.SIMKL_TOKEN || '').trim();
  const uid = (process.env.SIMKL_USER_ID || '8094166').trim();
  const secret = (process.env.HUB_SECRET || '').trim();

  if (req.method === 'POST') {
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const validAuth = (secret.length >= 16 && okSecret(given, secret)) || (token && okSecret(given, token));
    if (!validAuth) return res.status(401).json({ error: 'unauthorized' });

    const body = typeof req.body === 'string' ? jparse(req.body) : (req.body || {});
    if (body?.state === 'watching' && body?.item?.title) {
      const payload = {
        ...body.item,
        live: true,
        paused: false,
        startedAt: Number(body.item.startedAt) || Date.parse(body.item.watchedAt || 0) || Date.now(),
        pushedAt: Date.now()
      };
      S.pushedLive = payload;
      await rcmd(['SET', 'hub:simkl:live', JSON.stringify(payload), 'EX', 150]);
      return res.status(200).json({ ok: true, state: 'watching', title: payload.title });
    }
    if (body?.state === 'idle' || body?.state === 'last_watched') {
      const itemToSave = body?.lastItem || body?.item;
      let saved = false;
      if (itemToSave && itemToSave.title) {
        saved = await saveLast({
          ...itemToSave,
          live: false,
          paused: false,
          watchedAt: toIso(itemToSave.watchedAt) || new Date().toISOString()
        });
      }
      S.pushedLive = null;
      S.live = null;
      S.sig = '';
      const [curRaw, histRaw] = (await rcmd(['GET', 'hub:nuvio:cur'], ['GET', 'hub:nuvio:hist'])) || [];
      const cur = jparse(curRaw);
      const cmds = [['DEL', 'hub:simkl:live'], ['DEL', 'hub:nuvio:cur']];
      if (cur?.imdbId) {
        const hist = jparse(histRaw) || [];
        const nextHist = [{ ...cur, endedAt: Date.now() }, ...hist.filter(h => h.key !== cur.key)].slice(0, 10);
        cmds.push(['SET', 'hub:nuvio:hist', JSON.stringify(nextHist), 'EX', 30 * 86400]);
      }
      await rcmd(...cmds);
      return res.status(200).json({ ok: true, state: body?.state, title: itemToSave?.title || null, saved });
    }
    return res.status(400).json({ error: 'invalid state or item' });
  }

  const debug = req.query?.debug === '1';
  const rawLang = String(req.query?.lang || req.headers['accept-language'] || 'en').slice(0, 2).toLowerCase();
  const reqLang = ['pt', 'en', 'es'].includes(rawLang) ? rawLang : 'en';
  const diag = { lang: reqLang, v: '2026-11-09-v2' };

  res.setHeader('Cache-Control', debug ? 'no-store' : 'public, s-maxage=6, stale-while-revalidate=15');
  if (req.method !== 'GET') return res.status(405).end();
  if (!id) return res.status(500).json({ error: 'SIMKL_CLIENT_ID is missing in Vercel Environment Variables.' });

  const headers = { 'User-Agent': UA, 'simkl-api-key': id, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let apiCalls = 0;
  async function simklGet(path, params = {}, withAuth = true) {
    const url = new URL(`https://api.simkl.com${path}`);
    url.searchParams.set('client_id', id);
    url.searchParams.set('app-name', APP_NAME);
    url.searchParams.set('app-version', APP_VERSION);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    apiCalls++;
    const callHeaders = {
      'User-Agent': UA,
      'simkl-api-key': id,
      'Content-Type': 'application/json',
      ...(withAuth && token ? { Authorization: `Bearer ${token}` } : {})
    };
    const r = await fetch(url, { headers: callHeaders, signal: AbortSignal.timeout(9000) });
    const body = await r.text();
    let data; try { data = body ? JSON.parse(body) : null; } catch { data = body; }
    if (!r.ok) {
      const detail = typeof data === 'object' && data ? (data.message || data.error || data.description) : data;
      const err = new Error(`Simkl HTTP ${r.status}${detail ? `: ${String(detail).slice(0, 120)}` : ''}`);
      err.status = r.status;
      throw err;
    }
    return data;
  }
  async function getPublicRecent() {
    try {
      const recent = await simklGet(`/users/recently-watched-background/${encodeURIComponent(uid)}`, {}, false);
      const media = recent?.movie || recent?.show || recent?.anime || recent;
      if (!media?.title) return null;
      const type = recent?.movie ? 'movie' : recent?.anime ? 'anime' : 'show';
      const rtMin = Number(media.runtime) || (type === 'movie' ? 110 : 25);
      return {
        live: false,
        paused: false,
        title: media.title,
        type,
        sid: media?.ids?.simkl,
        imdbId: media?.ids?.imdb,
        tmdbId: media?.ids?.tmdb,
        season: recent?.episode?.season ?? null,
        number: recent?.episode?.number ?? null,
        episode: recent?.episode ? sxe(recent.episode.season, recent.episode.number) : null,
        episodeTitle: recent?.episode?.title || null,
        watchedAt: toIso(recent?.last_watched_at || recent?.watched_at),
        runtimeMin: rtMin,
        durationSec: rtMin * 60,
        poster: posterUrl(media.poster),
        url: recent?.url || simklUrl(type, media),
        source: 'public-recent'
      };
    } catch (e) {
      diag.publicRecentError = e?.message;
      return null;
    }
  }
  const simklUrl = (type, media) => {
    const sid = media?.ids?.simkl || media?.ids?.simkl_id;
    return sid ? `https://simkl.com/${type === 'movie' ? 'movies' : type === 'anime' ? 'anime' : 'tv'}/${sid}` : `https://simkl.com/${encodeURIComponent(uid)}/`;
  };
  const details = (type, sid) => !sid ? null : cached(`d:${type}:${sid}`, META_CACHE_MS, async () => {
    try {
      const d = await simklGet(type === 'movie' ? `/movies/${sid}` : type === 'anime' ? `/anime/${sid}` : `/tv/${sid}`, { extended: 'full' });
      return { poster: d?.poster || null, runtime: Number(d?.runtime) || null, ids: d?.ids || null };
    } catch (e) { if (e.status === 429) throw e; return null; }
  });
  const episodeName = async (type, sid, season, number) => {
    if (!sid || number == null || type === 'movie') return null;
    const list = await cached(`e:${type}:${sid}`, META_CACHE_MS, async () => {
      try { const l = await simklGet(type === 'anime' ? `/anime/episodes/${sid}` : `/tv/episodes/${sid}`); return Array.isArray(l) ? l : []; }
      catch (e) { if (e.status === 429) throw e; return []; }
    });
    const hit = list.find(e => Number(e.episode ?? e.number) === Number(number) && (type === 'anime' || season == null || e.season == null || Number(e.season) === Number(season)));
    return hit?.title || null;
  };

  async function enrichLocalization(obj) {
    if (!obj || !obj.title) return obj;
    let i18n = obj.i18n || null;
    let imdbId = obj.imdbId || obj.media?.ids?.imdb || null;
    let tmdbId = obj.tmdbId || obj.media?.ids?.tmdb || null;
    const sid = obj.sid || obj.simklId || obj.media?.ids?.simkl || obj.url?.match(/\/(?:movies|tv|anime)\/(\d+)/i)?.[1] || null;
    const { season, number } = parseEpisodeCode(obj.episode, obj.season, obj.number);

    if (!i18n) {
      if (!imdbId && !tmdbId && sid) {
        const det = await details(obj.type || 'movie', sid);
        imdbId = det?.ids?.imdb || null;
        tmdbId = det?.ids?.tmdb || null;
      }
      const resolved = await resolveTmdbI18n({
        title: obj.title,
        type: obj.type || 'movie',
        imdbId,
        tmdbId,
        season,
        number,
        fallbackEpTitle: obj.episodeTitle,
        fallbackPoster: obj.poster
      });
      if (resolved?.i18n) {
        i18n = resolved.i18n;
        if (!obj.durationSec && resolved.tmdbRuntimeMin) {
          obj.runtimeMin = resolved.tmdbRuntimeMin;
          obj.durationSec = resolved.tmdbRuntimeMin * 60;
        }
      }
    }

    const out = { ...obj };
    delete out.media;
    delete out.sid;
    if (i18n) {
      out.i18n = i18n;
      const loc = i18n[reqLang] || i18n.en || {};
      if (loc.title) out.title = loc.title;
      if (loc.episodeTitle) out.episodeTitle = loc.episodeTitle;
      if (loc.poster) out.poster = loc.poster;
    }
    if (!out.durationSec && out.runtimeMin) out.durationSec = out.runtimeMin * 60;
    return out;
  }

  const reply = async (obj, remember = true) => {
    const localized = await enrichLocalization(obj);
    if (remember && localized && localized.title) {
      S.out = localized;
      await rcmd(['SET', 'hub:simkl:last', JSON.stringify(localized), 'EX', 7 * 86400]);
    }
    return res.status(200).json(debug ? { ...localized, _debug: diag } : localized);
  };

  const getPaused = async () => {
    const playback = await simklGet('/sync/playback');
    const list = Array.isArray(playback) ? playback : (playback?.data || []);
    diag.playbackCount = list.length;
    return list.map(entry => {
      const media = entry.movie || entry.show || entry.anime;
      if (!media?.title) return null;
      const type = entry.movie ? 'movie' : entry.anime ? 'anime' : 'show';
      const season = entry.episode?.season ?? null, number = entry.episode?.number ?? entry.episode?.episode ?? null;
      return { title: media.title, type, season, number, episode: sxe(season, number), episodeTitle: entry.episode?.title || null,
        sid: media?.ids?.simkl, imdbId: media?.ids?.imdb || null, tmdbId: media?.ids?.tmdb || null, media,
        watchedAt: toIso(entry.paused_at || entry.watched_at), progress: Number(entry.progress), paused: true, source: 'sync-playback' };
    }).filter(Boolean).sort((a, b) => ts(b.watchedAt) - ts(a.watchedAt))[0] || null;
  };
  const rowsFromItems = (data, needDate) => {
    const rows = [];
    for (const [list, key, type] of [['shows', 'show', 'show'], ['anime', 'show', 'anime'], ['movies', 'movie', 'movie']]) {
      for (const entry of data?.[list] || []) {
        const media = entry?.[key] || entry?.show || entry?.anime || entry?.movie || {};
        let watchedAt = toIso(entry.last_watched_at || entry.last_watched || entry.watched_at);
        let newestEp = 0;
        for (const sn of entry.seasons || []) {
          for (const ep of sn.episodes || []) {
            const s = ts(ep.watched_at);
            if (s && s > newestEp) newestEp = s;
          }
        }
        if (newestEp && (!watchedAt || newestEp > ts(watchedAt))) {
          watchedAt = new Date(newestEp).toISOString();
        }
        const addedAt = toIso(entry.added_to_watchlist_at);
        if (media.title && (watchedAt || !needDate)) rows.push({ entry, media, type, watchedAt, addedAt, newestEp });
      }
    }
    return rows.sort((a, b) => (ts(b.watchedAt) || ts(b.addedAt)) - (ts(a.watchedAt) || ts(a.addedAt)));
  };
  const rowToItem = (top, preferNext = false) => {
    let season = null, number = null, newest = top.newestEp || 0;
    if (preferNext && typeof top.entry.next_to_watch === 'string' && top.entry.next_to_watch) {
      const nm = top.entry.next_to_watch.match(/(?:S(\d+))?E(\d+)/i);
      if (nm) {
        season = nm[1] ? +nm[1] : 1;
        number = +nm[2];
      }
    }
    if (number == null) {
      for (const sn of top.entry.seasons || []) for (const ep of sn.episodes || []) {
        const stamp = ts(ep.watched_at);
        if (stamp && stamp >= newest) { newest = stamp; season = sn.number; number = ep.number; }
      }
    }
    let episode = sxe(season, number);
    if (!episode && typeof top.entry.last_watched === 'string') {
      episode = top.entry.last_watched;
      const m = episode.match(/(?:S(\d+))?E(\d+)/i);
      if (m) { season = m[1] ? +m[1] : 1; number = +m[2]; episode = sxe(season, number); }
    }
    const finalWatchedAt = newest > 0 ? new Date(newest).toISOString() : (top.watchedAt || top.addedAt);
    return { title: top.media.title, type: top.type, season, number, episode, episodeTitle: null, sid: top.media?.ids?.simkl,
      imdbId: top.media?.ids?.imdb || null, tmdbId: top.media?.ids?.tmdb || null,
      media: top.media, watchedAt: finalWatchedAt, paused: false, source: 'sync-history' };
  };
  const getLastDone = async () => {
    const base = { extended: 'full', episode_watched_at: 'yes' };
    const since = new Date(Date.now() - 45 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
    let rows = rowsFromItems(await simklGet('/sync/all-items', { ...base, date_from: since }), true);
    if (!rows.length) rows = rowsFromItems(await simklGet('/sync/all-items', base), true);
    diag.historyCandidates = rows.length;
    return rows[0] ? rowToItem(rows[0], false) : null;
  };
  const getDelta = async (fromMs, preferNext = false) => {
    const since = new Date(fromMs).toISOString().replace(/\.\d+Z$/, 'Z');
    const rows = rowsFromItems(await simklGet('/sync/all-items', { extended: 'full', episode_watched_at: 'yes', date_from: since }), false);
    diag.deltaCount = rows.length;
    return rows.map(r => rowToItem(r, preferNext));
  };

  const finalize = async (item, extra) => {
    if (item.source === 'nuvio-history' || (!item.sid && item.poster)) {
      return { ...item, ...extra };
    }
    const det = await details(item.type, item.sid);
    const epTitle = item.episodeTitle || await episodeName(item.type, item.sid, item.season, item.number);
    const runtimeMin = Number(item.media?.runtime) || det?.runtime || item.runtimeMin || (item.type === 'movie' ? 110 : 25);
    return {
      title: item.title,
      type: item.type,
      sid: item.sid,
      imdbId: item.imdbId || item.media?.ids?.imdb || det?.ids?.imdb || null,
      tmdbId: item.tmdbId || item.media?.ids?.tmdb || det?.ids?.tmdb || null,
      season: item.season ?? null,
      number: item.number ?? null,
      episode: item.episode,
      episodeTitle: epTitle,
      runtimeMin,
      durationSec: runtimeMin * 60,
      poster: item.poster || posterUrl(item.media?.poster) || posterUrl(det?.poster),
      url: item.url || simklUrl(item.type, item.media),
      ...(item.i18n ? { i18n: item.i18n } : {}),
      ...extra
    };
  };
  const nuvioItem = async entry => {
    if (!entry?.imdbId) return null;
    const type = entry.type === 'movie' ? 'movie' : 'show';
    const meta = await resolveTmdbI18n({ title: '', type, imdbId: entry.imdbId, season: entry.season, number: entry.number });
    const title = meta?.i18n?.en?.title || meta?.i18n?.pt?.title || '';
    if (!title) return null;
    const runtimeMin = meta.tmdbRuntimeMin || (type === 'movie' ? 110 : 25);
    return {
      title, type, imdbId: entry.imdbId, tmdbId: meta.tmdbId || null,
      season: entry.season ?? null, number: entry.number ?? null,
      episode: type === 'movie' ? null : sxe(entry.season, entry.number),
      episodeTitle: meta?.i18n?.en?.episodeTitle || meta?.i18n?.pt?.episodeTitle || null,
      runtimeMin, durationSec: runtimeMin * 60,
      poster: meta?.i18n?.en?.poster || meta?.i18n?.pt?.poster || null,
      i18n: meta.i18n, url: `https://simkl.com/${encodeURIComponent(uid)}/dashboard/`, source: 'nuvio-addon'
    };
  };
  const nuvioLive = async cur => {
    if (!cur?.imdbId || !cur.at || cur.endedAt || cur.paused) return null;
    if (cur.kind !== 'subtitles') return null;
    const now = Date.now();
    diag.nuvio = { key: cur.key, kind: cur.kind, ageSec: Math.round((now - cur.at) / 1000) };
    const base = await nuvioItem(cur);
    if (!base) return null;
    const elapsed = (now - cur.at) / 1000;
    if (elapsed > base.durationSec + 120) return null;
    return { ...base, live: true, paused: false, watchedAt: new Date(cur.at).toISOString(), startedAt: cur.at,
      seenAt: cur.seen || cur.at, elapsedSec: Math.round(elapsed), progress: Math.min(99, Math.round(elapsed / base.durationSec * 100)), estimated: true };
  };
  const addonSession = live => {
    const imdbOf = x => x?.imdbId || x?.media?.ids?.imdb || null;
    const same = x => {
      if (!x) return false;
      const sameTitle = (imdbOf(x) && imdbOf(x) === live.imdbId) || (x.tmdbId && live.tmdbId && String(x.tmdbId) === String(live.tmdbId));
      if (!sameTitle) return false;
      return live.type === 'movie' || (Number(x.season) === Number(live.season) && Number(x.number) === Number(live.number));
    };
    const since = live.startedAt - 60e3;
    if (same(S.lastDone) && ts(S.lastDone.watchedAt) >= since) return { state: 'ended', at: ts(S.lastDone.watchedAt) };
    const p = S.paused;
    if (same(p) && ts(p.watchedAt) >= since) {
      if (Date.now() - ts(p.watchedAt) < NUVIO_PAUSE_HOLD_MS) return { state: 'paused', at: ts(p.watchedAt), progress: Number(p.progress) };
      return { state: 'ended', at: ts(p.watchedAt) };
    }
    return null;
  };
  const resolveAddonLive = async () => {
    if (!addonLive) return false;
    const sess = addonSession(addonLive);
    if (!sess) {
      const unconfirmedAge = Date.now() - (addonLive.seenAt || addonLive.startedAt);
      const a = S.acts;
      const simklActivityAt = Math.max(
        ts(a?.tv_shows?.watching), ts(a?.anime?.watching),
        ts(a?.tv_shows?.playback), ts(a?.anime?.playback), ts(a?.movies?.playback)
      );
      const simklConfirmed = Boolean(S.live) || simklActivityAt >= addonLive.startedAt - 60e3;
      if (unconfirmedAge > NUVIO_UNCONFIRMED_MS && (!simklConfirmed || Date.now() < S.blockedUntil || diag.error)) {
        diag.addonEndedUnconfirmed = true;
        return false;
      }
      diag.picked = 'nuvio-addon-live';
      await reply(addonLive, false);
      return true;
    }
    if (sess.state === 'paused') {
      const pr = Number.isFinite(sess.progress) ? sess.progress : addonLive.progress;
      diag.picked = 'nuvio-addon-paused';
      await reply({ ...addonLive, live: true, paused: true, progress: pr, elapsedSec: Math.round(addonLive.durationSec * pr / 100),
        watchedAt: new Date(sess.at).toISOString(), estimated: false }, false);
      return true;
    }
    diag.addonEndedBySimkl = new Date(sess.at).toISOString();
    if (S.addonLast) S.addonLast = { ...S.addonLast, watchedAt: new Date(Math.min(sess.at, Date.now())).toISOString() };
    return false;
  };
  const nuvioLast = async (cur, hist) => {
    const now = Date.now();
    const curUsable = cur?.imdbId && (cur.kind === 'subtitles' || cur.endedAt || now - cur.at >= NUVIO_WEAK_GRACE_MS);
    const top = curUsable ? cur : (Array.isArray(hist) ? hist[0] : null);
    if (!top?.imdbId) return null;
    const base = await nuvioItem(top);
    if (!base) return null;
    const endMs = Math.min(top.endedAt || top.seen || top.at, now);
    return { ...base, live: false, paused: false, watchedAt: new Date(endMs).toISOString() };
  };
  const present = async () => {
    if (S.live) {
      const c = S.live.cand;
      const base = await finalize(c, {});
      const ageSec = (Date.now() - S.live.startedAt) / 1000;
      if (ageSec >= 0 && ageSec < (base.runtimeMin + 10) * 60) {
        const progress = Math.min(99, Math.round(S.live.startProgress + ageSec / (base.runtimeMin * 60) * 100));
        diag.picked = 'inferred-live';
        return { ...base, live: true, paused: false, watchedAt: new Date(S.live.startedAt).toISOString(), elapsedSec: Math.round(ageSec), progress, source: 'simkl-inferred' };
      }
    }
    let validPaused = S.paused;
    if (validPaused) {
      const pausedAgeMs = Date.now() - ts(validPaused.watchedAt);
      if (pausedAgeMs > 6 * 3600e3 || (pausedAgeMs > 2 * 3600e3 && (validPaused.progress || 0) < 5)) {
        validPaused = null;
      }
    }
    const pick = [S.lastDone, validPaused, S.out, S.addonLast].filter(Boolean).sort((a, b) => ts(b.watchedAt) - ts(a.watchedAt))[0];
    diag.picked = pick ? pick.source : null;
    if (!pick) return { live: false, title: null, source: 'empty-history' };
    return { ...(await finalize(pick, {})), live: false, paused: pick.paused, watchedAt: pick.watchedAt,
      progress: pick.paused && Number.isFinite(pick.progress) ? pick.progress : null, source: pick.source };
  };
  const rebuild = async (P, W) => {
    const oldPaused = S.paused;
    const paused = await getPaused();
    let lastDone = await getLastDone();
    const pub = await getPublicRecent();
    if (pub && (!lastDone || ts(pub.watchedAt) >= ts(lastDone.watchedAt) || !lastDone.title)) {
      lastDone = pub;
    }
    if (oldPaused) S.prevPaused = oldPaused;
    S.paused = paused; S.lastDone = lastDone; S.live = null;
    const known = Math.max(ts(paused?.watchedAt), ts(lastDone?.watchedAt));
    diag.P = P ? new Date(P).toISOString() : null; diag.known = known ? new Date(known).toISOString() : null;
    const fromP = !!(P && P > known + 45e3);
    const fromW = !fromP && !!(W && W > known + 45e3);
    const trig = fromP ? P : W;
    diag.trigger = fromP ? 'playback' : fromW ? 'watching-list' : 'none';
    if ((fromP || fromW) && Date.now() - trig < 3 * 3600e3) {
      const delta = await getDelta(trig - 2 * 60e3, true);
      let cand = null, startProgress = 0;
      if (delta.length === 1 && delta[0].sid !== lastDone?.sid) {
        cand = delta[0];
      }
      if (cand) {
        const ref = [paused, S.prevPaused].find(x => x && x.sid && x.sid === cand.sid);
        if (ref) { cand = { ...cand, ...ref, paused: false }; startProgress = Number.isFinite(ref.progress) ? ref.progress : 0; }
        S.live = { cand, startProgress, startedAt: trig };
      }
      diag.liveCandidate = cand ? cand.title : null;
    }
  };

  let addonLive = null;
  try {
    const [rawLive, st, last, bl, nuvioCurRaw, nuvioHistRaw, actsRaw] = (await rcmd(['GET', 'hub:simkl:live'], ['GET', 'hub:simkl:state'], ['GET', 'hub:simkl:last'], ['GET', 'hub:simkl:blocked'], ['GET', 'hub:nuvio:cur'], ['GET', 'hub:nuvio:hist'], ['GET', 'hub:simkl:acts'])) || [];
    const redisLive = hydratePushedLive(jparse(rawLive) || S.pushedLive);
    if (redisLive) {
      diag.picked = 'redis-live-push';
      return reply(redisLive, false);
    }

    const trakt = await traktLive(uid);
    if (trakt) {
      diag.picked = 'trakt-live';
      return reply(trakt, false);
    }

    const nuvioCur = jparse(nuvioCurRaw);
    addonLive = await nuvioLive(nuvioCur);
    S.addonLast = await nuvioLast(nuvioCur, jparse(nuvioHistRaw));

    const scraped = await scrapeLive(uid, diag);
    if (scraped) {
      const enriched = await enrichLocalization(scraped);
      await rcmd(['SET', 'hub:simkl:live', JSON.stringify({ ...enriched, pushedAt: Date.now() }), 'EX', 120]);
      return reply(enriched, false);
    }

    if (!token) {
      if (addonLive) { diag.picked = 'nuvio-addon-live'; return reply(addonLive, false); }
      const pub = await getPublicRecent();
      if (!pub) return reply({ live: false, title: null, source: 'empty-history' });
      return reply(pub, true);
    }

    if (!S.loaded || req.query?.force === '1') {
      S.loaded = true;
      const state = jparse(st);
      if (state) Object.assign(S, { sig: state.sig || '', paused: state.paused || null, lastDone: state.lastDone || null, prevPaused: state.prevPaused || null,
        live: state.live || null });
      if (!S.out || req.query?.force === '1') S.out = jparse(last);
      if (req.query?.force === '1') S.sig = '';
      S.blockedUntil = Math.max(S.blockedUntil, Number(bl) || 0);
      diag.restoredFromRedis = !!(state || S.out);
    }
    const savedLast = jparse(last);
    if (savedLast?.title && ts(savedLast.watchedAt) > ts(S.out?.watchedAt)) S.out = savedLast;
    const sharedState = jparse(st);
    if (sharedState && Number(sharedState.rebuiltAt || 0) > Number(S.rebuiltAt || 0)) {
      Object.assign(S, { sig: sharedState.sig || '', paused: sharedState.paused || null, lastDone: sharedState.lastDone || null,
        prevPaused: sharedState.prevPaused || null, live: sharedState.live || null, rebuiltAt: sharedState.rebuiltAt });
    }
    const sharedActs = jparse(actsRaw);
    if (sharedActs?.data && Number(sharedActs.at || 0) > S.actsAt) { S.acts = sharedActs.data; S.actsAt = sharedActs.at; }
    if (Date.now() < S.blockedUntil) {
      diag.blockedForMin = Math.ceil((S.blockedUntil - Date.now()) / 60e3);
      if (await resolveAddonLive()) return;
      const freshest = [S.out, S.addonLast].filter(Boolean).sort((a, b) => ts(b.watchedAt) - ts(a.watchedAt))[0];
      return freshest ? reply({ ...freshest, stale: true }, false) : res.status(503).json({ error: 'Simkl daily API limit reached; retrying later.', ...(debug ? { _debug: diag } : {}) });
    }

    const actsTtl = addonLive || S.live ? 15e3 : 60e3;
    if (!S.acts || Date.now() - S.actsAt > actsTtl) {
      S.acts = await simklGet('/sync/activities'); S.actsAt = Date.now();
      await rcmd(['SET', 'hub:simkl:acts', JSON.stringify({ at: S.actsAt, data: S.acts }), 'EX', 600]);
    }
    const a = S.acts;
    const P = Math.max(ts(a?.tv_shows?.playback), ts(a?.anime?.playback), ts(a?.movies?.playback));
    const W = Math.max(ts(a?.tv_shows?.watching), ts(a?.anime?.watching));
    const D = Math.max(ts(a?.tv_shows?.watched), ts(a?.anime?.watched), ts(a?.movies?.watched));
    const sig = `${a?.all}|${P}|${W}|${D}`;
    diag.activities = { all: a?.all || null, playback: { movies: a?.movies?.playback || null, shows: a?.tv_shows?.playback || null, anime: a?.anime?.playback || null },
      watching: { shows: a?.tv_shows?.watching || null, anime: a?.anime?.watching || null },
      watched: { shows: a?.tv_shows?.watched || null, anime: a?.anime?.watched || null, movies: a?.movies?.watched || null }, now: new Date().toISOString() };
    const rebuildEvery = (!S.paused && !S.lastDone) ? 60e3 : (addonLive || S.live ? 45e3 : 10 * 60e3);
    if (S.sig !== sig || req.query?.force === '1' || !S.rebuiltAt || Date.now() - S.rebuiltAt > rebuildEvery) {
      await rebuild(P, W); S.sig = sig; S.rebuiltAt = Date.now();
      await rcmd(['SET', 'hub:simkl:state', JSON.stringify({ sig: S.sig, paused: S.paused, lastDone: S.lastDone, prevPaused: S.prevPaused, live: S.live, rebuiltAt: S.rebuiltAt }), 'EX', 30 * 86400]);
    }
    if (await resolveAddonLive()) return;
    const out = await present();
    diag.apiCalls = apiCalls;
    return reply(out);
  } catch (error) {
    diag.error = error?.message || String(error);
    diag.errorStatus = error?.status || null;
    if (error?.status === 429 || error?.status === 412) {
      S.blockedUntil = Date.now() + BACKOFF_MS;
      await rcmd(['SET', 'hub:simkl:blocked', String(S.blockedUntil), 'EX', Math.ceil(BACKOFF_MS / 1000)]);
    }
    diag.apiCalls = apiCalls;
    if (error?.status === 401) diag.tokenExpired = true;
    if (await resolveAddonLive()) return;
    const pub = await getPublicRecent();
    const fallback = [pub, S.out, S.addonLast].filter(Boolean).sort((a, b) => ts(b.watchedAt) - ts(a.watchedAt))[0];
    if (fallback) {
      diag.picked = fallback === pub ? 'public-fallback' : fallback.source;
      return reply(fallback === pub ? fallback : { ...fallback, stale: true }, fallback === pub);
    }
    return res.status(502).json({ error: error?.message || 'Simkl request failed', ...(debug ? { _debug: diag } : {}) });
  }
}
