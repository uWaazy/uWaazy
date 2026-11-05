import { timingSafeEqual } from 'node:crypto';

const UA = 'uWaazy-stremio/1.0 (https://github.com/uWaazy/uWaazy)';
const TMDB_KEY = String(process.env.TMDB_API_KEY || 'f852831cea564a90f0f0fda9f0ffc625').trim();
const TOP_POSTERS_KEY = String(process.env.TOP_POSTERS_KEY || process.env.RPDB_API_KEY || '').trim();

let R_URL = String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim();
if (R_URL && !/^https?:\/\//i.test(R_URL)) R_URL = 'https://' + R_URL;
R_URL = R_URL.replace(/\/+$/, '');
const R_TOK = String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim();

const rcmd = async (...cmds) => {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL + '/pipeline', {
      method: 'POST',
      headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(4500)
    });
    return r.ok ? (await r.json()).map(x => x.result) : null;
  } catch {
    return null;
  }
};

const MANIFEST = {
  id: 'community.uwaazy.sync',
  version: '1.0.0',
  name: 'uWaazy Live Sync',
  description: 'Sincroniza o que você assiste em tempo real com o uWaazy Hub.',
  logo: 'https://uwaazy.vercel.app/assets/simkl.svg',
  resources: ['subtitles'],
  types: ['movie', 'series', 'anime'],
  catalogs: []
};

const pad2 = n => String(n).padStart(2, '0');
const sxe = (s, e) => (s != null && e != null ? `S${pad2(s)}E${pad2(e)}` : e != null ? `E${pad2(e)}` : null);
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
  } catch {
    return null;
  }
}

async function resolveMetadata(type, id) {
  const parts = String(id || '').replace(/\.json$/i, '').split(':');
  const mainId = parts[0];
  const season = parts[1] != null && !Number.isNaN(Number(parts[1])) ? Number(parts[1]) : null;
  const number = parts[2] != null && !Number.isNaN(Number(parts[2])) ? Number(parts[2]) : null;

  let kind = type === 'series' || season != null || number != null ? 'tv' : 'movie';
  let tmdbId = null;
  let imdbId = mainId.startsWith('tt') ? mainId : null;

  if (imdbId) {
    const found = await tmdbGet(`/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id', language: 'en-US' });
    const list = (kind === 'movie' ? found?.movie_results : found?.tv_results) || found?.tv_results || found?.movie_results || [];
    if (list.length) {
      tmdbId = list[0].id;
      if (!found?.movie_results?.length && found?.tv_results?.length) kind = 'tv';
      if (found?.movie_results?.length && !found?.tv_results?.length && season == null && number == null) kind = 'movie';
    }
  } else if (/^\d+$/.test(mainId)) {
    tmdbId = Number(mainId);
  }

  if (!tmdbId) {
    return {
      title: mainId,
      type: kind === 'tv' ? 'show' : 'movie',
      imdbId,
      tmdbId: null,
      season,
      number,
      episode: sxe(season, number),
      episodeTitle: null,
      poster: null,
      runtimeMin: kind === 'tv' ? 25 : 105,
      i18n: null
    };
  }

  const langs = [['pt', 'pt-BR'], ['en', 'en-US'], ['es', 'es-ES']];
  const i18n = {};
  let fallbackTitle = mainId;
  let fallbackPoster = null;
  let fallbackEpTitle = null;
  let runtimeMin = kind === 'tv' ? 25 : 105;

  await Promise.all(langs.map(async ([short, full]) => {
    let locTitle = fallbackTitle;
    let locPoster = null;
    let locEp = null;

    const det = await tmdbGet(`/${kind}/${tmdbId}`, { language: full });
    if (det) {
      locTitle = det.title || det.name || fallbackTitle;
      if (short === 'en') fallbackTitle = locTitle;
      if (det.poster_path) {
        locPoster = `https://image.tmdb.org/t/p/w500${det.poster_path}`;
        if (!fallbackPoster) fallbackPoster = locPoster;
      }
      const rt = Number(det.runtime) || Number(det.episode_run_time?.[0]) || 0;
      if (rt > 0) runtimeMin = rt;
    }

    if (TOP_POSTERS_KEY && imdbId) {
      locPoster = `https://api.ratingposterdb.com/${encodeURIComponent(TOP_POSTERS_KEY)}/imdb/poster-default/${encodeURIComponent(imdbId)}.jpg?lang=${short}`;
      if (!fallbackPoster) fallbackPoster = locPoster;
    }

    if (kind === 'tv' && number != null) {
      const epDet = await tmdbGet(`/tv/${tmdbId}/season/${season || 1}/episode/${number}`, { language: full });
      if (epDet) {
        if (epDet.name && !isGenericEpName(epDet.name)) {
          locEp = epDet.name;
          if (short === 'en') fallbackEpTitle = locEp;
        }
        if (Number(epDet.runtime) > 0) runtimeMin = Number(epDet.runtime);
      }
    }

    i18n[short] = { title: locTitle, episodeTitle: locEp, poster: locPoster };
  }));

  return {
    title: fallbackTitle,
    type: kind === 'tv' ? 'show' : 'movie',
    imdbId,
    tmdbId,
    season,
    number,
    episode: sxe(season, number),
    episodeTitle: fallbackEpTitle,
    poster: fallbackPoster,
    runtimeMin,
    i18n
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();

  const urlPath = (req.query?.path || req.url || '').replace(/^\/+/, '').split('?')[0];

  if (!urlPath || urlPath === 'manifest.json' || urlPath.endsWith('/manifest.json')) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json(MANIFEST);
  }

  const subMatch = urlPath.match(/(?:^|\/)subtitles\/([^/]+)\/([^/]+?)(?:\/([^/]+))?(?:\.json)?$/i);
  if (subMatch) {
    const rawType = subMatch[1].toLowerCase();
    const rawId = decodeURIComponent(subMatch[2]);
    res.setHeader('Cache-Control', 'no-store');

    (async () => {
      try {
        const meta = await resolveMetadata(rawType, rawId);
        const startedAt = Date.now();
        const durationSec = (meta.runtimeMin || (meta.type === 'movie' ? 105 : 25)) * 60;
        const livePayload = {
          live: true,
          paused: false,
          title: meta.title,
          type: meta.type,
          season: meta.season,
          number: meta.number,
          episode: meta.episode,
          episodeTitle: meta.episodeTitle,
          imdbId: meta.imdbId,
          tmdbId: meta.tmdbId,
          watchedAt: new Date(startedAt).toISOString(),
          startedAt,
          pushedAt: startedAt,
          runtimeMin: meta.runtimeMin,
          durationSec,
          elapsedSec: 0,
          progress: 0,
          poster: meta.poster,
          i18n: meta.i18n,
          url: meta.imdbId ? `https://www.imdb.com/title/${meta.imdbId}/` : 'https://simkl.com/8094166/dashboard/',
          source: 'stremio-live'
        };
        const ttl = Math.max(3600, durationSec + 900);
        await rcmd(['SET', 'hub:simkl:live', JSON.stringify(livePayload), 'EX', ttl]);
      } catch {}
    })();

    return res.status(200).json({ subtitles: [] });
  }

  return res.status(404).json({ error: 'not found' });
}

