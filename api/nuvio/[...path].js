import { timingSafeEqual } from 'node:crypto';

const envClean = v => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
const TOKEN = envClean(process.env.NUVIO_ADDON_TOKEN);
let R_URL = envClean(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
if (R_URL && !/^https?:\/\//i.test(R_URL)) R_URL = 'https://' + R_URL;
R_URL = R_URL.replace(/\/+$/, '');
const R_TOK = envClean(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);

const CUR_KEY = 'hub:nuvio:cur';
const HIST_KEY = 'hub:nuvio:hist';
const SAME_ITEM_MS = 3 * 3600e3;
const MIN_WATCH_MS = 3 * 60e3;
const HIST_MAX = 10;

let waitUntilFn = null;
try { waitUntilFn = (await import('@vercel/functions')).waitUntil || null; } catch {}

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

const MANIFEST = {
  id: 'org.uwaazy.hub.sync',
  version: '1.0.0',
  name: 'uWaazy Hub Sync',
  description: 'Informa ao hub o que você está assistindo. Não entrega streams nem legendas.',
  resources: [
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] },
    { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }
  ],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false, adult: false }
};

function parseId(type, rawId) {
  const id = decodeURIComponent(String(rawId || ''));
  const m = id.match(/^(tt\d{5,10})(?::(\d{1,3}):(\d{1,4}))?$/);
  if (!m) return null;
  if (type === 'series' && m[2] == null) return null;
  return {
    type: type === 'movie' ? 'movie' : 'show',
    imdbId: m[1],
    season: type === 'movie' ? null : Number(m[2]),
    number: type === 'movie' ? null : Number(m[3]),
    key: type === 'movie' ? m[1] : `${m[1]}:${m[2]}:${m[3]}`
  };
}

async function record(info, kind) {
  const now = Date.now();
  const [curRaw, histRaw] = (await rcmd(['GET', CUR_KEY], ['GET', HIST_KEY])) || [];
  const cur = jparse(curRaw);
  let hist = jparse(histRaw) || [];
  if (cur && cur.key === info.key && now - cur.at < SAME_ITEM_MS) {
    await rcmd(['SET', CUR_KEY, JSON.stringify({ ...cur, seen: now, kind: cur.kind === 'subtitles' ? 'subtitles' : kind }), 'EX', 86400]);
    return;
  }
  if (cur && now - cur.at >= MIN_WATCH_MS) {
    hist = [{ ...cur, endedAt: now }, ...hist.filter(h => h.key !== cur.key)].slice(0, HIST_MAX);
  }
  await rcmd(
    ['SET', CUR_KEY, JSON.stringify({ ...info, kind, at: now, seen: now }), 'EX', 86400],
    ['SET', HIST_KEY, JSON.stringify(hist), 'EX', 30 * 86400]
  );
}

function routeSegments(req) {
  const q = req.query?.path;
  const fromQuery = Array.isArray(q) ? q : q ? [q] : [];
  if (fromQuery.length) return fromQuery.map(String);
  const pathname = String(req.url || '').split('?')[0];
  const m = pathname.match(/\/(?:api\/)?nuvio\/(.+)$/);
  return m ? m[1].split('/').filter(Boolean) : [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();
  if (TOKEN.length < 16) return res.status(503).json({ error: 'NUVIO_ADDON_TOKEN missing or shorter than 16 characters' });
  const segs = routeSegments(req);
  if (!okSecret(segs[0] || '', TOKEN)) return res.status(404).end();
  const path = segs.slice(1).join('/');
  if (path === 'manifest.json') return res.status(200).json(MANIFEST);
  if (path === 'log') {
    const [c, h] = (await rcmd(['GET', CUR_KEY], ['GET', HIST_KEY])) || [];
    return res.status(200).json({ now: Date.now(), cur: jparse(c), hist: jparse(h) || [] });
  }

  const m = path.match(/^(stream|subtitles)\/(movie|series)\/([^/]+?)(?:\/[^/]+)?\.json$/);
  if (!m) return res.status(404).json({ error: 'not found' });
  const empty = m[1] === 'stream' ? { streams: [], cacheMaxAge: 0 } : { subtitles: [], cacheMaxAge: 0 };
  const info = parseId(m[2], m[3]);
  if (!info) return res.status(200).json(empty);

  const kind = m[1];
  const job = record(info, kind).catch(() => {});
  if (waitUntilFn) {
    try { waitUntilFn(job); } catch { await job; }
  } else {
    await Promise.race([job, new Promise(r => setTimeout(r, 2500))]);
  }
  return res.status(200).json(empty);
}
