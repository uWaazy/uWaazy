import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import musicHandler, { getTrackContext } from './music.js';
import simklHandler from './simkl.js';
import activityHandler from './activity.js';

const PROD_ORIGIN = 'https://uwaazy.vercel.app';
const UA = 'uWaazy-hub-svg/1.5';
const FRESH_MS = 8000;
const DEADLINE_MS = 2300;
const IMG_BUDGET_MS = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const envClean = v => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
let R_URL = envClean(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
if (R_URL && !/^https?:\/\//i.test(R_URL)) R_URL = 'https://' + R_URL;
R_URL = R_URL.replace(/\/+$/, '');
const R_TOK = envClean(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
async function rcmd(...cmds) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}` }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(1200) });
    return r.ok ? (await r.json()).map(x => x.result) : null;
  } catch { return null; }
}
let waitUntilFn = null;
try { waitUntilFn = (await import('@vercel/functions')).waitUntil || null; } catch {}
const keepAlive = p => { try { if (waitUntilFn) waitUntilFn(p.catch(() => {})); } catch {} };
const svgMem = new Map();
const inflight = new Map();
async function saveLastGood(lang, svg) {
  await rcmd(['SET', `hub:readme:svg:${lang}`, gzipSync(Buffer.from(svg)).toString('base64'), 'EX', 6 * 3600]);
}
async function loadLastGood(lang) {
  const hit = await rcmd(['GET', `hub:readme:svg:${lang}`]);
  if (!hit || !hit[0]) return null;
  try { return gunzipSync(Buffer.from(hit[0], 'base64')).toString('utf8'); } catch { return null; }
}

let cachedLogoDataUri = null;
function getLogoDataUri() {
  if (cachedLogoDataUri) return cachedLogoDataUri;
  try {
    const buf = readFileSync(new URL('../assets/logo.png', import.meta.url));
    cachedLogoDataUri = `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    cachedLogoDataUri = '';
  }
  return cachedLogoDataUri;
}

const imgMemo = new Map();
async function toDataUri(url) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('data:')) return url;
  if (url.startsWith('assets/logo')) return getLogoDataUri();
  const fullUrl = (url.startsWith('http') ? url : `${PROD_ORIGIN}/${url.replace(/^\/+/, '')}`)
    .replace(/\/\d+x\d+bb\.(jpg|png|webp)/i, '/160x160bb.$1')
    .replace(/\/i\/u\/300x300\//i, '/i/u/174s/')
    .replace(/(i\.scdn\.co\/image\/)ab67616d0000b273/i, '$1ab67616d00001e02')
    .replace(/(i\.scdn\.co\/image\/)ab6761610000e5eb/i, '$1ab6761610000f178')
    .replace(/(image\.tmdb\.org\/t\/p\/)w(?:500|780|original)/i, '$1w342');
  const hit = imgMemo.get(fullUrl);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.val;
  try {
    const r = await fetch(fullUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(3500) });
    if (!r.ok) return '';
    const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 160000) return '';
    const val = `data:${ct};base64,${buf.toString('base64')}`;
    imgMemo.set(fullUrl, { at: Date.now(), val });
    return val;
  } catch {
    return '';
  }
}

async function runInternal(handlerFn, query = {}) {
  return new Promise(resolve => {
    const req = { method: 'GET', query, headers: {} };
    const res = {
      statusCode: 200,
      setHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ ok: this.statusCode < 400, data: d }); return this; },
      end() { resolve({ ok: false, data: null }); return this; }
    };
    Promise.resolve(handlerFn(req, res)).catch(() => resolve({ ok: false, data: null }));
  });
}

const endpointMemo = new Map();
async function fetchEndpoint(handlerFn, fallbackPath, query = {}) {
  const internal = await Promise.race([runInternal(handlerFn, query), sleep(1700).then(() => ({ ok: false, data: null, timedOut: true }))]);
  if (internal.ok && internal.data && !internal.data.error && !internal.data.lastfm?.error) {
    endpointMemo.set(fallbackPath, { at: Date.now(), data: internal.data });
    return internal.data;
  }
  const memo = endpointMemo.get(fallbackPath);
  if (memo && Date.now() - memo.at < 10 * 60e3) return memo.data;
  try {
    const r = await fetch(`${PROD_ORIGIN}${fallbackPath}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const prod = await r.json();
      if (fallbackPath === '/api/music' && internal.data?.statsfm?.slides?.length) {
        prod.statsfm = internal.data.statsfm;
        if (prod.lastfm && !prod.lastfm.trackInfo) {
          const tr = prod.lastfm.current || prod.lastfm.lastTrack;
          if (tr) prod.lastfm.trackInfo = await getTrackContext(tr, prod.lastfm.live);
        }
      }
      return prod;
    }
  } catch {}
  return internal.data || {};
}

let ghMemo = { at: 0, val: null };
async function fetchGithubSummary() {
  if (ghMemo.val && Date.now() - ghMemo.at < 10 * 60e3) return ghMemo.val;
  try {
    const r = await fetch('https://api.github.com/users/uWaazy/events/public?per_page=15', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(2000)
    });
    const ev = await r.json();
    if (Array.isArray(ev) && ev.length) {
      const e = ev.find(x => x.type === 'PushEvent') || ev[0];
      const repo = e.repo?.name || 'uWaazy/uWaazy';
      let msg = e.payload?.commits?.[e.payload.commits.length - 1]?.message || '';
      msg = String(msg || 'Latest activity on GitHub').split('\n')[0].slice(0, 90);
      ghMemo = { at: Date.now(), val: { repo, msg, at: e.created_at } };
      return ghMemo.val;
    }
  } catch {}
  return ghMemo.val || { repo: 'uWaazy/ygp-playtime-sync', msg: 'Sync your Playnite playtime with Your Gamer Profile', at: null };
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const trunc = (s, max) => {
  const str = String(s ?? '').trim();
  return str.length > max ? str.slice(0, max - 1).trimEnd() + '…' : str;
};
const nf = (n, lang = 'pt') => Number(n || 0).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US');

function agoText(iso, lang = 'pt') {
  if (!iso) return '';
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return lang === 'pt' ? 'agora mesmo' : 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return lang === 'pt' ? `há ${min} min` : `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return lang === 'pt' ? `há ${hr} h` : `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return lang === 'pt' ? `há ${days} ${days === 1 ? 'dia' : 'dias'}` : `${days}d ago`;
}

function fmtShortDate(iso, lang = 'pt') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ de /g, ' ');
}

function fmtArtistDuration(iso, lang = 'pt') {
  if (!iso) return '';
  const days = Math.max(1, (Date.now() - new Date(iso).getTime()) / 86400000);
  if (days >= 365) {
    const y = Math.floor(days / 365);
    return lang === 'pt' ? `${y} ${y === 1 ? 'ano' : 'anos'}` : `${y} ${y === 1 ? 'yr' : 'yrs'}`;
  }
  if (days >= 30) {
    const m = Math.floor(days / 30);
    return lang === 'pt' ? `${m} ${m === 1 ? 'mês' : 'meses'}` : `${m} ${m === 1 ? 'mo' : 'mos'}`;
  }
  const w = Math.max(1, Math.floor(days / 7));
  return lang === 'pt' ? `${w} ${w === 1 ? 'semana' : 'semanas'}` : `${w} ${w === 1 ? 'wk' : 'wks'}`;
}

function buildSlideLabels(slide, isLf, lang = 'pt') {
  const pt = lang === 'pt';
  if (isLf) {
    switch (slide.kind) {
      case 'total':
        return {
          label: pt ? 'Last.fm · total de scrobbles' : 'Last.fm · total scrobbles',
          title: `${nf(slide.plays, lang)} scrobbles`,
          meta: `${slide.title || 'WagnerSilva17'} · ${slide.subtitle || ''}`
        };
      case 'track7d':
        return {
          label: pt ? 'Last.fm · top música / semana' : 'Last.fm · top track / week',
          title: slide.title || '—',
          meta: [slide.artist, slide.plays ? `${nf(slide.plays, lang)} scrobbles` : ''].filter(Boolean).join(' · ')
        };
      case 'album7d':
        return {
          label: pt ? 'Last.fm · top álbum / semana' : 'Last.fm · top album / week',
          title: slide.title || '—',
          meta: [slide.artist, slide.plays ? `${nf(slide.plays, lang)} scrobbles` : ''].filter(Boolean).join(' · ')
        };
      case 'artist7d':
        return {
          label: pt ? 'Last.fm · top artista / semana' : 'Last.fm · top artist / week',
          title: slide.title || '—',
          meta: `${nf(slide.plays, lang)} scrobbles · 7d`
        };
      case 'album6m':
        return {
          label: pt ? 'Last.fm · top álbum / 6 meses' : 'Last.fm · top album / 6m',
          title: slide.title || '—',
          meta: [slide.artist, slide.plays ? `${nf(slide.plays, lang)} plays` : ''].filter(Boolean).join(' · ')
        };
      case 'albumAll':
        return {
          label: pt ? 'Last.fm · top álbum / total' : 'Last.fm · top album / total',
          title: slide.title || '—',
          meta: [slide.artist, slide.plays ? `${nf(slide.plays, lang)} scrobbles` : ''].filter(Boolean).join(' · ')
        };
      case 'trackAll':
        return {
          label: pt ? 'Last.fm · top música / total' : 'Last.fm · top track / total',
          title: slide.title || '—',
          meta: [slide.artist, slide.plays ? `${nf(slide.plays, lang)} scrobbles` : ''].filter(Boolean).join(' · ')
        };
      case 'artist1y':
        return {
          label: pt ? 'Last.fm · top artista / 1 ano' : 'Last.fm · top artist / 1 year',
          title: slide.title || '—',
          meta: `${nf(slide.plays, lang)} scrobbles · 12m`
        };
      case 'artistAll':
        return {
          label: pt ? 'Last.fm · top artista / total' : 'Last.fm · top artist / total',
          title: slide.title || '—',
          meta: `${nf(slide.plays, lang)} scrobbles · total`
        };
      case 'loved':
        return {
          label: pt ? 'Last.fm · faixas favoritas' : 'Last.fm · loved tracks',
          title: `♥ ${nf(slide.lovedCount, lang)} ${pt ? 'favoritas' : 'loved'}`,
          meta: `${nf(slide.plays, lang)} scrobbles`
        };
      default:
        return { label: 'Last.fm', title: slide.title || '—', meta: '' };
    }
  } else {
    const hrs = slide.durationMs ? `${(slide.durationMs / 3600000).toFixed(1)}h` : '';
    switch (slide.kind) {
      case 'total':
        return {
          label: pt ? 'stats.fm · total de streams' : 'stats.fm · total streams',
          title: `${nf(slide.streams, lang)} streams`,
          meta: [hrs ? `${hrs} ${pt ? 'ouvidas' : 'listened'}` : '', slide.artist].filter(Boolean).join(' · ')
        };
      case 'track7d':
        return {
          label: pt ? 'stats.fm · top música / semana' : 'stats.fm · top track / week',
          title: slide.title || '—',
          meta: [slide.artist, slide.streams ? `${nf(slide.streams, lang)} plays` : ''].filter(Boolean).join(' · ')
        };
      case 'album7d':
        return {
          label: pt ? 'stats.fm · top álbum / semana' : 'stats.fm · top album / week',
          title: slide.title || '—',
          meta: [slide.artist, slide.streams ? `${nf(slide.streams, lang)} plays` : ''].filter(Boolean).join(' · ')
        };
      case 'artist7d':
        return {
          label: pt ? 'stats.fm · top artista / semana' : 'stats.fm · top artist / week',
          title: slide.title || '—',
          meta: [slide.streams ? `${nf(slide.streams, lang)} plays` : '', slide.artist].filter(Boolean).join(' · ')
        };
      case 'album':
        return {
          label: pt ? 'stats.fm · top álbum / 4 sem.' : 'stats.fm · top album / 4w',
          title: slide.title || '—',
          meta: [slide.artist, slide.streams ? `${nf(slide.streams, lang)} plays` : ''].filter(Boolean).join(' · ')
        };
      case 'track':
        return {
          label: pt ? 'stats.fm · top música / 4 sem.' : 'stats.fm · top track / 4w',
          title: slide.title || '—',
          meta: [slide.artist, slide.streams ? `${nf(slide.streams, lang)} plays` : ''].filter(Boolean).join(' · ')
        };
      case 'artist':
        return {
          label: pt ? 'stats.fm · top artista / 4 sem.' : 'stats.fm · top artist / 4w',
          title: slide.title || '—',
          meta: [slide.streams ? `${nf(slide.streams, lang)} plays` : '', slide.artist].filter(Boolean).join(' · ')
        };
      case 'albumAll':
        return {
          label: pt ? 'stats.fm · top álbum / total' : 'stats.fm · top album / total',
          title: slide.title || '—',
          meta: [slide.artist, slide.streams ? `${nf(slide.streams, lang)} plays` : ''].filter(Boolean).join(' · ')
        };
      case 'artistAll':
        return {
          label: pt ? 'stats.fm · top artista / total' : 'stats.fm · top artist / total',
          title: slide.title || '—',
          meta: [slide.streams ? `${nf(slide.streams, lang)} plays` : '', slide.artist].filter(Boolean).join(' · ')
        };
      case 'genre':
        return {
          label: pt ? 'stats.fm · top gênero / 4 sem.' : 'stats.fm · top genre / 4w',
          title: slide.title || '—',
          meta: [slide.streams ? `${nf(slide.streams, lang)} plays` : '', slide.artist].filter(Boolean).join(' · ')
        };
      case 'playlist':
        return {
          label: pt ? 'stats.fm · top playlist / 4 sem.' : 'stats.fm · top playlist / 4w',
          title: slide.title || '—',
          meta: `${nf(slide.streams, lang)} plays · Spotify`
        };
      default:
        return { label: 'stats.fm', title: slide.title || '—', meta: '' };
    }
  }
}

async function renderSvg(lang) {
  const pt = lang === 'pt';

  const [music, simkl, activity, gh] = await Promise.all([
    fetchEndpoint(musicHandler, '/api/music'),
    fetchEndpoint(simklHandler, `/api/simkl?lang=${lang}`, { lang }),
    fetchEndpoint(activityHandler, '/api/activity'),
    fetchGithubSummary()
  ]);

  const lf = music?.lastfm || {};
  const sf = music?.statsfm || {};
  const isMusicLive = Boolean(lf.live);
  const track = (isMusicLive ? (lf.current || lf.lastTrack) : (lf.lastTrack || lf.current)) || {
    title: 'Brace Face',
    artist: 'Rod Wave',
    album: 'Ghetto Gospel',
    image: ''
  };
  const ti = lf.trackInfo || null;
  const wLoc = (simkl?.i18n && simkl.i18n[lang]) || {};
  const wPosterUrl = wLoc.poster || simkl?.poster;

  const lfSlidesRaw = (Array.isArray(lf.slides) && lf.slides.length ? lf.slides : (lf.album ? [{ kind: 'album6m', ...lf.album }] : [])).slice(0, 6);
  const sfSlidesRaw = (Array.isArray(sf.slides) && sf.slides.length ? sf.slides : (sf.album ? [{ kind: 'album', ...sf.album }] : [])).slice(0, 6);

  const gamesList = Array.isArray(activity?.recent) ? activity.recent.slice() : [];
  const mainGame = activity?.now || gamesList.shift() || { name: 'Assetto Corsa', hours: 466.9, endedAt: null };
  const secondGame = gamesList[0] || { name: 'Assetto Corsa Competizione', endedAt: null };

  const urlsToFetch = [
    track?.image,
    wPosterUrl,
    mainGame?.cover,
    secondGame?.cover,
    'https://github.com/uWaazy.png?size=96',
    ...lfSlidesRaw.map(s => s.image),
    ...sfSlidesRaw.map(s => s.image)
  ];
  const uniqueUrls = [...new Set(urlsToFetch.filter(Boolean))];
  const uriMap = new Map();
  await Promise.race([
    Promise.all(uniqueUrls.map(async u => {
      uriMap.set(u, await toDataUri(u));
    })),
    sleep(IMG_BUDGET_MS)
  ]);

  const logoUri = getLogoDataUri();
  const trackUri = uriMap.get(track?.image) || '';
  const simklUri = uriMap.get(wPosterUrl) || '';
  const gameUri = uriMap.get(mainGame?.cover) || '';
  const game2Uri = uriMap.get(secondGame?.cover) || '';
  const ghUri = uriMap.get('https://github.com/uWaazy.png?size=96') || logoUri;

  const pillItems = [];
  if (isMusicLive && ti) {
    if (ti.loved) pillItems.push({ text: pt ? '♥ Favorita' : '♥ Loved', loved: true });
    if (ti.firstListenAt) pillItems.push({ text: `${pt ? '1ª vez:' : '1st heard:'} ${fmtShortDate(ti.firstListenAt, lang)}` });
    if (ti.trackPlays > 0) {
      const pTxt = ti.trackPlays === 1
        ? (pt ? '▶ Tocou 1 vez' : '▶ Played 1x')
        : (pt ? `▶ Tocou ${nf(ti.trackPlays, lang)}x` : `▶ Played ${nf(ti.trackPlays, lang)}x`);
      pillItems.push({ text: pTxt });
    }
    if (ti.showAlbum && ti.album && ti.albumPlays > 20) {
      pillItems.push({ text: pt ? `💿 Tocou o álbum ${nf(ti.albumPlays, lang)}x` : `💿 Album played ${nf(ti.albumPlays, lang)}x`, gold: true });
    }
    if (ti.artistFirstListenAt) {
      pillItems.push({ text: pt ? `Ouviu o artista há ${fmtArtistDuration(ti.artistFirstListenAt, lang)}` : `Heard artist ${fmtArtistDuration(ti.artistFirstListenAt, lang)} ago` });
    }
  }

  function renderChipSlidesSvg(slides, isLf, x, y) {
    const accent = isLf ? '#ff5a5f' : '#1ed760';
    const list = slides.length ? slides : [{ kind: isLf ? 'album6m' : 'album', title: '—', artist: '' }];
    const count = list.length;
    const clsPrefix = isLf ? 'lfs' : 'sfs';

    const itemsSvg = list.map((s, idx) => {
      const info = buildSlideLabels(s, isLf, lang);
      const imgUri = uriMap.get(s.image) || logoUri;
      const clipId = `clip-${clsPrefix}-${idx}`;
      return `
        <g class="${clsPrefix} ${clsPrefix}-${idx}">
          <defs><clipPath id="${clipId}"><rect x="${x + 10}" y="${y + 11}" width="56" height="56" rx="9"/></clipPath></defs>
          <rect x="${x + 10}" y="${y + 11}" width="56" height="56" rx="9" fill="#0e1016"/>
          ${imgUri ? `<image href="${imgUri}" x="${x + 10}" y="${y + 11}" width="56" height="56" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>` : ''}
          <text x="${x + 76}" y="${y + 25}" fill="#8a91a6" font-size="9.5" font-weight="500">${esc(trunc(info.label, 30))}</text>
          <text x="${x + 76}" y="${y + 43}" fill="${accent}" font-size="12" font-weight="700">${esc(trunc(info.title, 22))}</text>
          <text x="${x + 76}" y="${y + 59}" fill="#8a91a6" font-size="10">${esc(trunc(info.meta, 27))}</text>
        </g>`;
    }).join('');

    const dotsSvg = count > 1 ? list.map((_, idx) => {
      const dx = x + 230 - (count * 7) + idx * 7;
      return `<circle cx="${dx}" cy="${y + 70}" r="2" fill="#3a4157" class="${clsPrefix}-dot-${idx}"/>`;
    }).join('') : '';

    return `
      <g>
        <rect x="${x}" y="${y}" width="238" height="78" rx="14" fill="#171a23" stroke="#222633"/>
        ${itemsSvg}
        ${dotsSvg}
      </g>`;
  }

  function buildSlideKeyframes(prefix, count, offsetSec = 0) {
    if (count <= 1) return `.${prefix}{opacity:1}`;
    const stepPct = 100 / count;
    const fadePct = Math.min(3, stepPct * 0.18);
    const totalDur = count * 5;
    let css = `
      .${prefix}{opacity:0;animation:${prefix}Anim ${totalDur}s infinite}
      @keyframes ${prefix}Anim {
        0%, ${ (stepPct - fadePct).toFixed(2) }% { opacity: 1; transform: translateY(0px); }
        ${ stepPct.toFixed(2) }%, 100% { opacity: 0; transform: translateY(3px); }
      }
    `;
    for (let i = 0; i < count; i++) {
      const delay = (i * 5 + offsetSec).toFixed(2);
      css += `.${prefix}-${i}{animation-delay:${delay}s}`;
      css += `.${prefix}-dot-${i}{animation:${prefix}Dot ${totalDur}s infinite;animation-delay:${delay}s}`;
    }
    css += `
      @keyframes ${prefix}Dot {
        0%, ${ (stepPct - fadePct).toFixed(2) }% { fill: ${prefix === 'lfs' ? '#ff5a5f' : '#1ed760'}; }
        ${ stepPct.toFixed(2) }%, 100% { fill: #3a4157; }
      }
    `;
    return css;
  }

  const fmtDur = s => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  const wTitle = wLoc.title || simkl?.title || 'The Boondocks';
  const wEp = [simkl?.episode, wLoc.episodeTitle || simkl?.episodeTitle].filter(Boolean).join(' · ');
  const wAgo = simkl?.watchedAt ? agoText(simkl.watchedAt, lang) : '';
  const wTotSec = Number(simkl?.durationSec) || (simkl?.runtimeMin ? simkl.runtimeMin * 60 : 0);
  const wElSec = Number(simkl?.elapsedSec) || (simkl?.watchedAt ? Math.max(0, (Date.now() - new Date(simkl.watchedAt).getTime()) / 1000) : 0);
  const wLiveTime = wTotSec > 0 ? `${fmtDur(Math.min(wElSec, wTotSec))} / ${fmtDur(wTotSec)}` : (pt ? 'Ao vivo' : 'Live');
  const wMeta = [wEp, simkl?.live ? wLiveTime : wAgo].filter(Boolean).join(' · ');
  const wPill = simkl?.live ? (pt ? 'Assistindo agora' : 'Watching now') : (pt ? 'Último assistido' : 'Last watched');

  const gIsLive = Boolean(activity?.now);
  const gPill = gIsLive ? (pt ? 'Jogando agora' : 'Playing now') : (pt ? 'Último jogado' : 'Last played');
  const gAgo = mainGame?.endedAt || mainGame?.playedAt ? agoText(mainGame.endedAt || mainGame.playedAt, lang) : '';
  const gHrs = mainGame?.hours ? `${nf(mainGame.hours, lang)} h ${pt ? 'no total' : 'total'}` : '';
  const gMeta = [gAgo, gHrs].filter(Boolean).join(' · ');

  let px = 22;
  const pillsSvg = pillItems.map(p => {
    const w = Math.max(54, p.text.length * 6.1 + 18);
    if (px + w > 492) return '';
    const fill = p.loved ? 'rgba(255,59,92,0.14)' : p.gold ? 'rgba(251,191,36,0.1)' : '#171a23';
    const stroke = p.loved ? '#ff3b5c' : p.gold ? '#5b4413' : '#262b3b';
    const textCol = p.loved ? '#ff6b84' : p.gold ? '#fbbf24' : '#b9c0d4';
    const node = `
      <g transform="translate(${px}, 256)">
        <rect x="0" y="0" width="${w.toFixed(0)}" height="22" rx="11" fill="${fill}" stroke="${stroke}" ${p.loved ? 'class="heart-pill"' : ''}/>
        <text x="${(w / 2).toFixed(0)}" y="14.5" text-anchor="middle" fill="${textCol}" font-size="10" font-weight="600">${esc(p.text)}</text>
      </g>`;
    px += w + 6;
    return node;
  }).join('');

  const stacks = [
    { name: 'C#', col: '#9b4f96' },
    { name: 'JavaScript', col: '#f7df1e' },
    { name: 'Python', col: '#3776ab' },
    { name: 'PowerShell', col: '#5391fe' },
    { name: 'Node.js', col: '#339933' },
    { name: 'HTML/CSS', col: '#e34f26' },
    { name: 'Redis', col: '#dc382d' },
    { name: 'Git', col: '#f05032' }
  ];
  let sx = 40;
  const stacksSvg = stacks.map(st => {
    const w = st.name.length * 6.8 + 28;
    const node = `
      <g transform="translate(${sx}, 764)">
        <rect x="0" y="0" width="${w.toFixed(0)}" height="24" rx="7" fill="#171a23" stroke="#252a3a"/>
        <circle cx="11" cy="12" r="4" fill="${st.col}"/>
        <text x="20" y="15.5" fill="#e8ecf5" font-size="10.5" font-weight="600">${esc(st.name)}</text>
      </g>`;
    sx += w + 8;
    return node;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="816" viewBox="0 0 760 816" fill="none">
  <defs>
    <linearGradient id="avRing" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#8b5cf6"/>
      <stop offset="50%" stop-color="#22d3ee"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
    <linearGradient id="progGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#22d3ee"/>
    </linearGradient>
    <clipPath id="avClip"><circle cx="55" cy="55" r="29"/></clipPath>
    <clipPath id="trackClip"><rect x="38" y="132" width="112" height="112" rx="20"/></clipPath>
    <clipPath id="watchClip"><rect x="36" y="330" width="60" height="86" rx="9"/></clipPath>
    <clipPath id="gameClip"><rect x="36" y="472" width="78" height="78" rx="11"/></clipPath>
    <clipPath id="game2Clip"><rect x="32" y="576" width="28" height="36" rx="5"/></clipPath>
    <clipPath id="ghClip"><circle cx="56" cy="664" r="20"/></clipPath>
  </defs>
  <style>
    svg { font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
    @keyframes eq1 { 0%,100%{transform:scaleY(.25)} 40%{transform:scaleY(1)} 75%{transform:scaleY(.55)} }
    @keyframes eq2 { 0%,100%{transform:scaleY(.9)} 35%{transform:scaleY(.3)} 70%{transform:scaleY(1)} }
    @keyframes eq3 { 0%,100%{transform:scaleY(.4)} 50%{transform:scaleY(.95)} 80%{transform:scaleY(.3)} }
    @keyframes eq4 { 0%,100%{transform:scaleY(.75)} 25%{transform:scaleY(.25)} 65%{transform:scaleY(.9)} }
    @keyframes pulseDot { 0%,100%{opacity:1} 50%{opacity:.28} }
    @keyframes heartBeat { 0%,100%{transform:scale(1)} 50%{transform:scale(1.04)} }
    .eq-b1 { transform-origin: 170px 160px; animation: eq1 0.65s ease-in-out infinite; }
    .eq-b2 { transform-origin: 175px 160px; animation: eq2 0.92s ease-in-out infinite; }
    .eq-b3 { transform-origin: 180px 160px; animation: eq3 0.76s ease-in-out infinite; }
    .eq-b4 { transform-origin: 185px 160px; animation: eq4 1.05s ease-in-out infinite; }
    .live-dot { animation: pulseDot 1.4s ease-in-out infinite; }
    .heart-pill { transform-box: fill-box; transform-origin: center; animation: heartBeat 1.8s ease-in-out infinite; }
    ${buildSlideKeyframes('lfs', lfSlidesRaw.length || 1, 0)}
    ${buildSlideKeyframes('sfs', sfSlidesRaw.length || 1, 2.5)}
  </style>

  <rect x="1" y="1" width="758" height="814" rx="22" fill="#12141b" stroke="#222633" stroke-width="1.5"/>

  <circle cx="55" cy="55" r="32" fill="url(#avRing)"/>
  <circle cx="55" cy="55" r="30" fill="#0d0f15"/>
  ${logoUri ? `<image href="${logoUri}" x="31" y="31" width="48" height="48" clip-path="url(#avClip)"/>` : ''}
  <circle cx="79" cy="79" r="6.5" fill="#fbbf24" stroke="#12141b" stroke-width="3"/>

  <text x="102" y="65" fill="#e8ecf5" font-size="30" font-weight="700" letter-spacing="6">W ∆ G N E R .</text>

  <rect x="536" y="36" width="202" height="38" rx="12" fill="#0e1016" stroke="#222633"/>
  <rect x="540" y="40" width="82" height="30" rx="9" fill="#171a23" stroke="#222633"/>
  <text x="581" y="59" text-anchor="middle" fill="#e8ecf5" font-size="12.5" font-weight="600">uWaazy</text>
  <text x="678" y="59" text-anchor="middle" fill="#8a91a6" font-size="12.5" font-weight="600">Kanye vs Taylor</text>

  <line x1="22" y1="96" x2="738" y2="96" stroke="#222633"/>

  <text x="24" y="118" fill="#8a91a6" font-size="12" font-weight="500">${pt ? 'Ouvindo' : 'Listening'}</text>

  <rect x="38" y="132" width="112" height="112" rx="20" fill="#171a23"/>
  ${trackUri ? `<image href="${trackUri}" x="38" y="132" width="112" height="112" preserveAspectRatio="xMidYMid slice" clip-path="url(#trackClip)"/>` : `<text x="94" y="198" text-anchor="middle" fill="#4a5170" font-size="32">♪</text>`}

  <g>
    ${isMusicLive ? `
      <rect class="eq-b1" x="168" y="149" width="3" height="11" rx="1.5" fill="#34d399"/>
      <rect class="eq-b2" x="173" y="149" width="3" height="11" rx="1.5" fill="#34d399"/>
      <rect class="eq-b3" x="178" y="149" width="3" height="11" rx="1.5" fill="#34d399"/>
      <rect class="eq-b4" x="183" y="149" width="3" height="11" rx="1.5" fill="#34d399"/>
    ` : ''}
    <text x="${isMusicLive ? 193 : 168}" y="159" fill="${isMusicLive ? '#34d399' : '#8a91a6'}" font-size="10.5" font-weight="700" letter-spacing="1.3">${isMusicLive ? (pt ? 'OUVINDO AGORA' : 'LISTENING NOW') : (pt ? 'ÚLTIMA MÚSICA' : 'LAST TRACK')}</text>
    <text x="168" y="193" fill="#ffffff" font-size="26" font-weight="700">${esc(trunc(track.title, 21))}</text>
    <text x="168" y="220" fill="#f5c518" font-size="17" font-weight="600">${esc(trunc(track.artist, 28))}</text>
  </g>

  ${pillsSvg}

  ${renderChipSlidesSvg(lfSlidesRaw, true, 500, 122)}
  ${renderChipSlidesSvg(sfSlidesRaw, false, 500, 210)}

  <text x="24" y="308" fill="#8a91a6" font-size="12" font-weight="500">${pt ? 'Assistindo' : 'Watching'}</text>
  <text x="736" y="308" text-anchor="end" fill="#8a91a6" font-size="12" class="mono">simkl ↗</text>

  <rect x="22" y="316" width="716" height="114" rx="16" fill="#171a23" stroke="#222633"/>
  <rect x="36" y="330" width="60" height="86" rx="9" fill="#232839"/>
  ${simklUri ? `<image href="${simklUri}" x="36" y="330" width="60" height="86" preserveAspectRatio="xMidYMid slice" clip-path="url(#watchClip)"/>` : `<text x="66" y="380" text-anchor="middle" fill="#4a5170" font-size="20">▶</text>`}
  <rect x="112" y="340" width="${simkl?.live ? 118 : 104}" height="21" rx="10.5" fill="${simkl?.live ? 'rgba(52,211,153,0.14)' : '#1d2130'}"/>
  ${simkl?.live ? `<circle cx="123" cy="350.5" r="3.5" fill="#34d399" class="live-dot"/>` : ''}
  <text x="${simkl?.live ? 133 : 122}" y="354.5" fill="${simkl?.live ? '#34d399' : '#8a91a6'}" font-size="11" font-weight="600">${esc(wPill)}</text>
  <text x="112" y="381" fill="#e8ecf5" font-size="16" font-weight="700">${esc(trunc(wTitle, 52))}</text>
  <text x="112" y="401" fill="#8a91a6" font-size="12.5">${esc(trunc(wMeta, 64))}</text>
  ${simkl?.live && simkl?.progress != null ? `
    <rect x="112" y="411" width="600" height="4" rx="2" fill="#232839"/>
    <rect x="112" y="411" width="${Math.max(12, Math.min(600, Math.round(Number(simkl.progress) * 6)))}" height="4" rx="2" fill="url(#progGrad)"/>
  ` : ''}

  <text x="24" y="450" fill="#8a91a6" font-size="12" font-weight="500">${pt ? 'Jogando' : 'Playing'}</text>
  <text x="736" y="450" text-anchor="end" fill="#8a91a6" font-size="12" class="mono">yourgamerprofile ↗</text>

  <rect x="22" y="458" width="716" height="106" rx="16" fill="#171a23" stroke="#222633"/>
  <rect x="36" y="472" width="78" height="78" rx="11" fill="#232839"/>
  ${gameUri ? `<image href="${gameUri}" x="36" y="472" width="78" height="78" preserveAspectRatio="xMidYMid slice" clip-path="url(#gameClip)"/>` : `<text x="75" y="518" text-anchor="middle" fill="#4a5170" font-size="22">🎮</text>`}
  <rect x="128" y="482" width="${gIsLive ? 108 : 96}" height="21" rx="10.5" fill="${gIsLive ? 'rgba(52,211,153,0.14)' : '#1d2130'}"/>
  ${gIsLive ? `<circle cx="139" cy="492.5" r="3.5" fill="#34d399" class="live-dot"/>` : ''}
  <text x="${gIsLive ? 149 : 138}" y="496.5" fill="${gIsLive ? '#34d399' : '#8a91a6'}" font-size="11" font-weight="600">${esc(gPill)}</text>
  <text x="128" y="523" fill="#e8ecf5" font-size="16" font-weight="700">${esc(trunc(mainGame?.name || '—', 50))}</text>
  <text x="128" y="543" fill="#8a91a6" font-size="12.5">${esc(trunc(gMeta, 64))}</text>

  <rect x="22" y="570" width="716" height="48" rx="12" fill="#0f1117" stroke="#222633"/>
  <rect x="32" y="576" width="28" height="36" rx="5" fill="#232839"/>
  ${game2Uri ? `<image href="${game2Uri}" x="32" y="576" width="28" height="36" preserveAspectRatio="xMidYMid slice" clip-path="url(#game2Clip)"/>` : ''}
  <text x="70" y="599" fill="#e8ecf5" font-size="13" font-weight="600">${esc(trunc(secondGame?.name || 'Assetto Corsa Competizione', 50))}</text>
  <text x="724" y="599" text-anchor="end" fill="#8a91a6" font-size="12">${esc(secondGame?.endedAt ? agoText(secondGame.endedAt, lang) : '')}</text>

  <rect x="22" y="628" width="716" height="72" rx="14" fill="#171a23" stroke="#222633"/>
  <circle cx="56" cy="664" r="20" fill="#0d0f15"/>
  ${ghUri ? `<image href="${ghUri}" x="36" y="644" width="40" height="40" clip-path="url(#ghClip)"/>` : ''}
  <text x="88" y="653" fill="#e8ecf5" font-size="13.5" font-weight="700">uWaazy <tspan fill="#8a91a6" font-weight="400" font-size="12">${pt ? 'no GitHub' : 'on GitHub'}</tspan></text>
  <text x="88" y="671" fill="#e8ecf5" font-size="12.5">${esc(trunc(gh.msg, 65))}</text>
  <text x="88" y="687" fill="#8a91a6" font-size="11.5">${esc([gh.repo, gh.at ? agoText(gh.at, lang) : ''].filter(Boolean).join(' · '))}</text>
  <text x="722" y="668" text-anchor="end" fill="#22d3ee" font-size="13">${pt ? 'abrir ↗' : 'open ↗'}</text>

  <a href="${PROD_ORIGIN}#stacks" target="_blank">
    <rect x="22" y="710" width="716" height="90" rx="14" fill="#0e1016" stroke="#222633"/>
    <rect x="36" y="723" width="3.5" height="30" rx="1.75" fill="#8b5cf6"/>
    <text x="48" y="734" fill="#8a91a6" font-size="9.5" font-weight="600" letter-spacing="2" class="mono">DEVELOPER STACK</text>
    <text x="48" y="751" fill="#ffffff" font-size="15" font-weight="700" letter-spacing="0.8">STACKS &amp; LANGUAGES</text>
    <text x="722" y="751" text-anchor="end" fill="#8a91a6" font-size="11.5" class="mono">${pt ? 'ampliar ↗' : 'expand ↗'}</text>
    ${stacksSvg}
  </a>
</svg>`;

  return svg;
}

const PLACEHOLDER = lang => `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="120" viewBox="0 0 760 120"><rect width="760" height="120" rx="20" fill="#0b0c10" stroke="#222633"/><text x="380" y="66" text-anchor="middle" fill="#8a91a6" font-family="Segoe UI,Helvetica,Arial,sans-serif" font-size="16">${lang === 'pt' ? 'Atualizando…' : 'Updating…'}</text></svg>`;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const lang = (req.query?.lang || 'pt').toLowerCase().startsWith('en') ? 'en' : 'pt';
  const send = (svg, policy) => {
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', policy);
    return res.status(200).send(svg);
  };
  const FRESH = 'public, max-age=0, s-maxage=8, stale-while-revalidate=25';
  const STALE = 'public, max-age=0, s-maxage=2, stale-while-revalidate=20';

  const hit = svgMem.get(lang);
  if (hit && Date.now() - hit.at < FRESH_MS) return send(hit.svg, FRESH);

  const lastGoodP = hit ? Promise.resolve(null) : loadLastGood(lang);
  let job = inflight.get(lang);
  if (!job) {
    job = renderSvg(lang)
      .then(async svg => {
        svgMem.set(lang, { at: Date.now(), svg });
        await saveLastGood(lang, svg);
        return svg;
      })
      .finally(() => inflight.delete(lang));
    inflight.set(lang, job);
    keepAlive(job);
  }
  const svg = await Promise.race([job.catch(() => null), sleep(DEADLINE_MS).then(() => null)]);
  if (svg) return send(svg, FRESH);

  const last = hit?.svg || svgMem.get(lang)?.svg || await Promise.race([lastGoodP, sleep(300).then(() => null)]);
  if (last) return send(last, STALE);
  return send(PLACEHOLDER(lang), 'public, max-age=0, s-maxage=1, stale-while-revalidate=5');
}
