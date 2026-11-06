const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const env = (k, d = '') => String(process.env[k] ?? d).trim();
const list = v => String(v).split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
const safeName = s => String(s || '').replace(/[^A-Za-z0-9_.-]/g, '');

const CFG = {
  yt: list(env('LIVE_YT_HANDLES', 'uwaazy,uwaazy2')).map(safeName),
  twitch: safeName(env('LIVE_TWITCH', 'uwaazy')),
  kick: safeName(env('LIVE_KICK', 'uwaazy')),
  tiktok: safeName(env('LIVE_TIKTOK', 'uwaazy')),
  own: list(env('LIVE_OWN_NAMES', 'uwaazy,uwaazy2')).map(s => s.toLowerCase())
};
const YT_KEY = env('YOUTUBE_API_KEY');
const TW_ID = env('TWITCH_CLIENT_ID');
const TW_SECRET = env('TWITCH_CLIENT_SECRET');
const KICK_ID = env('KICK_CLIENT_ID');
const KICK_SECRET = env('KICK_CLIENT_SECRET');
const PRIORITY = ['youtube', 'twitch', 'kick', 'tiktok'];
const YT_HEADERS = { 'User-Agent': UA_BROWSER, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+417; SOCS=CAI' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url, { headers = {}, ms = 3500, method = 'GET', body } = {}) {
  const r = await fetch(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  return { ok: r.ok, status: r.status, url: r.url, text: await r.text() };
}
async function fetchJson(url, opts) {
  const r = await fetchText(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return JSON.parse(r.text);
}
function extractJson(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; } } }
  }
  return null;
}
function findKey(node, key, test, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 45) return null;
  if (!Array.isArray(node) && node[key] && (!test || test(node[key]))) return node[key];
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const f = findKey(v, key, test, depth + 1);
    if (f) return f;
  }
  return null;
}
const isOwnName = n => CFG.own.includes(String(n || '').trim().toLowerCase().replace(/^@/, ''));
const ownChannelIds = new Set();

async function ytProbe(handle) {
  const r = await fetchText(`https://www.youtube.com/@${handle}/live`, { headers: YT_HEADERS, ms: 4200 });
  if (!r.ok) return { status: 'error', error: 'HTTP ' + r.status };
  if (/consent\.youtube\.com/.test(r.url)) return { status: 'error', error: 'consent page' };
  const pr = extractJson(r.text, 'ytInitialPlayerResponse = ') || extractJson(r.text, 'ytInitialPlayerResponse=');
  const vd = pr?.videoDetails;
  const mf = pr?.microformat?.playerMicroformatRenderer;
  if (vd?.channelId) ownChannelIds.add(vd.channelId);
  if (!vd || vd.isLive !== true || mf?.liveBroadcastDetails?.isLiveNow === false) return { status: 'offline' };
  const data = extractJson(r.text, 'ytInitialData = ') || extractJson(r.text, 'ytInitialData=');
  const box = findKey(data, 'richMetadataRenderer', m => m?.style === 'RICH_METADATA_RENDERER_STYLE_BOX_ART');
  const game = box?.title?.simpleText || box?.title?.runs?.[0]?.text || null;
  return {
    status: 'live', platform: 'youtube', channel: handle, videoId: vd.videoId,
    url: `https://www.youtube.com/watch?v=${vd.videoId}`,
    title: vd.title, thumb: `https://i.ytimg.com/vi/${vd.videoId}/maxresdefault_live.jpg`, thumbFallback: `https://i.ytimg.com/vi/${vd.videoId}/mqdefault_live.jpg`,
    game, category: mf?.category || null, viewers: Number(vd.viewCount) || null, startedAt: mf?.liveBroadcastDetails?.startTimestamp || null
  };
}

let twToken = { v: null, exp: 0 };
async function twAppToken() {
  if (twToken.v && Date.now() < twToken.exp) return twToken.v;
  const r = await fetchJson('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: TW_ID, client_secret: TW_SECRET, grant_type: 'client_credentials' }).toString()
  });
  twToken = { v: r.access_token, exp: Date.now() + Math.max(60, (r.expires_in || 3600) - 300) * 1000 };
  return twToken.v;
}
async function twProbe(login) {
  const base = { platform: 'twitch', channel: login, url: `https://www.twitch.tv/${login}` };
  if (TW_ID && TW_SECRET) {
    const t = await twAppToken();
    const j = await fetchJson(`https://api.twitch.tv/helix/streams?user_login=${login}`, { headers: { 'Client-Id': TW_ID, Authorization: 'Bearer ' + t } });
    const s = j?.data?.[0];
    if (!s || s.type !== 'live') return { status: 'offline' };
    return { ...base, status: 'live', title: s.title, thumb: String(s.thumbnail_url || '').replace('{width}', '640').replace('{height}', '360'), game: s.game_name || null, category: null, viewers: s.viewer_count ?? null, startedAt: s.started_at || null };
  }
  const q = `query{user(login:"${login}"){stream{title viewersCount createdAt game{name} previewImageURL(width:640,height:360)}}}`;
  const j = await fetchJson('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
  const s = j?.data?.user?.stream;
  if (!s) return { status: 'offline' };
  return { ...base, status: 'live', title: s.title, thumb: s.previewImageURL || null, game: s.game?.name || null, category: null, viewers: s.viewersCount ?? null, startedAt: s.createdAt || null };
}

let kickToken = { v: null, exp: 0 };
async function kickAppToken() {
  if (kickToken.v && Date.now() < kickToken.exp) return kickToken.v;
  const r = await fetchJson('https://id.kick.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: KICK_ID, client_secret: KICK_SECRET }).toString()
  });
  kickToken = { v: r.access_token, exp: Date.now() + Math.max(60, (r.expires_in || 3600) - 300) * 1000 };
  return kickToken.v;
}
async function kickProbe(slug) {
  const base = { platform: 'kick', channel: slug, url: `https://kick.com/${slug}` };
  if (KICK_ID && KICK_SECRET) {
    const t = await kickAppToken();
    const j = await fetchJson(`https://api.kick.com/public/v1/channels?slug=${slug}`, { headers: { Authorization: 'Bearer ' + t, Accept: 'application/json' } });
    const ch = j?.data?.[0];
    if (!ch?.stream?.is_live) return { status: 'offline' };
    return { ...base, status: 'live', title: ch.stream_title || null, thumb: ch.stream.thumbnail || null, game: ch.category?.name || null, category: null, viewers: ch.stream.viewer_count ?? null, startedAt: ch.stream.start_time || null };
  }
  const j = await fetchJson(`https://kick.com/api/v2/channels/${slug}`, { headers: { 'User-Agent': UA_BROWSER, Accept: 'application/json' } });
  const ls = j?.livestream;
  if (!ls) return { status: 'offline' };
  return { ...base, status: 'live', title: ls.session_title || null, thumb: ls.thumbnail?.url || ls.thumbnail?.src || null, game: ls.categories?.[0]?.name || null, category: null, viewers: ls.viewer_count ?? null, startedAt: ls.created_at || null };
}

async function tiktokProbe(user) {
  const j = await fetchJson(`https://www.tiktok.com/api-live/user/room/?aid=1988&uniqueId=${user}&sourceType=54`, {
    headers: { 'User-Agent': UA_BROWSER, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9', Referer: `https://www.tiktok.com/@${user}/live` }
  });
  const u = j?.data?.user;
  const room = j?.data?.liveRoom;
  if (!u) return { status: 'error', error: 'no user data' };
  if (Number(u.status) !== 2 && Number(room?.status) !== 2) return { status: 'offline' };
  return {
    status: 'live', platform: 'tiktok', channel: user, url: `https://www.tiktok.com/@${user}/live`,
    title: room?.title || null, thumb: room?.coverUrl || room?.cover?.urlList?.[0] || null, game: null, category: null,
    viewers: room?.liveRoomStats?.userCount ?? null, startedAt: room?.startTime ? new Date(Number(room.startTime) * 1000).toISOString() : null
  };
}

const chatCache = new Map();
async function cachedChat(key, ttl, fn) {
  const hit = chatCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  let val = [];
  try { val = await fn(); } catch { val = hit?.val || []; }
  chatCache.set(key, { at: Date.now(), val });
  if (chatCache.size > 30) chatCache.delete(chatCache.keys().next().value);
  return val;
}
async function ytChatScrape(id) {
  const r = await fetchText(`https://www.youtube.com/live_chat?is_popout=1&v=${id}`, { headers: YT_HEADERS, ms: 3000 });
  const data = extractJson(r.text, 'ytInitialData = ') || extractJson(r.text, 'ytInitialData=');
  const actions = data?.contents?.liveChatRenderer?.actions || [];
  return actions.map(a => a.addChatItemAction?.item?.liveChatTextMessageRenderer).filter(Boolean).map(m => ({
    platform: 'youtube', author: m.authorName?.simpleText || '', channelId: m.authorExternalChannelId || null,
    text: (m.message?.runs || []).map(x => x.text || x.emoji?.shortcuts?.[0] || '').join('').trim(),
    at: Math.round(Number(m.timestampUsec) / 1000) || 0,
    owner: (m.authorBadges || []).some(b => b.liveChatAuthorBadgeRenderer?.icon?.iconType === 'OWNER')
  }));
}
async function ytChatApi(id) {
  const v = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${id}&key=${YT_KEY}`);
  const chatId = v?.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  if (!chatId) return [];
  const j = await fetchJson(`https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${chatId}&part=snippet,authorDetails&maxResults=200&key=${YT_KEY}`);
  return (j?.items || []).filter(i => i.snippet?.type === 'textMessageEvent').map(i => ({
    platform: 'youtube', author: i.authorDetails?.displayName || '', channelId: i.authorDetails?.channelId || null,
    text: String(i.snippet?.displayMessage || '').trim(), at: Date.parse(i.snippet?.publishedAt || 0) || 0, owner: !!i.authorDetails?.isChatOwner
  }));
}
function parseIrcTags(raw) {
  const tags = {};
  for (const kv of raw.split(';')) { const i = kv.indexOf('='); if (i > 0) tags[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\'); }
  return tags;
}
async function twChat(login) {
  const j = await fetchJson(`https://recent-messages.robotty.de/api/v2/recent-messages/${login}?limit=40&hide_moderation_messages=true&hide_moderated_messages=true`, { ms: 3000 });
  return (j?.messages || []).map(line => {
    if (!line.startsWith('@') || !/ PRIVMSG #/.test(line)) return null;
    const tags = parseIrcTags(line.slice(1, line.indexOf(' ')));
    const m = line.match(/ :([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.*)$/);
    if (!m) return null;
    return {
      platform: 'twitch', author: tags['display-name'] || m[1], channelId: tags['user-id'] || null, login: m[1].toLowerCase(),
      text: m[2].replace(/^\u0001ACTION /, '').replace(/\u0001$/, '').trim(), at: Number(tags['tmi-sent-ts']) || 0,
      owner: /(^|,)broadcaster\//.test(tags.badges || '')
    };
  }).filter(Boolean);
}
async function chatFor(item) {
  if (item.platform === 'youtube' && item.videoId) {
    return cachedChat('yt:' + item.videoId, YT_KEY ? 45000 : 20000, () => (YT_KEY ? ytChatApi(item.videoId) : ytChatScrape(item.videoId)));
  }
  if (item.platform === 'twitch') return cachedChat('tw:' + item.channel, 12000, () => twChat(item.channel));
  return [];
}
const isOwnMessage = m => !m.text || m.owner || isOwnName(m.author) || isOwnName(m.login) || (m.channelId && m.platform === 'youtube' && ownChannelIds.has(m.channelId));

const probeCache = new Map();
const lastLive = new Map();
async function probe(platform, channel, fn, offlineTtl) {
  const key = platform + ':' + channel;
  const hit = probeCache.get(key);
  const ttl = hit ? (hit.res.status === 'live' ? 15000 : hit.res.status === 'offline' ? offlineTtl : 12000) : 0;
  if (hit && Date.now() - hit.at < ttl) return hit.res;
  const t0 = Date.now();
  let res;
  try { res = await Promise.race([fn(), sleep(4800).then(() => ({ status: 'error', error: 'timeout' }))]); }
  catch (e) { res = { status: 'error', error: String(e?.message || e).slice(0, 120) }; }
  res = { platform, channel, ...res, ms: Date.now() - t0 };
  if (res.status === 'live') lastLive.set(key, { at: Date.now(), res });
  else if (res.status === 'error') {
    const prev = lastLive.get(key);
    if (prev && Date.now() - prev.at < 120000) res = { ...prev.res, status: 'live', held: true, error: res.error, ms: res.ms };
  } else lastLive.delete(key);
  probeCache.set(key, { at: Date.now(), res });
  return res;
}

let snapshot = { at: 0, data: null };
async function collect() {
  const probes = await Promise.all([
    ...CFG.yt.map(h => probe('youtube', h, () => ytProbe(h), 45000)),
    CFG.twitch ? probe('twitch', CFG.twitch, () => twProbe(CFG.twitch), 20000) : null,
    CFG.kick ? probe('kick', CFG.kick, () => kickProbe(CFG.kick), 25000) : null,
    CFG.tiktok ? probe('tiktok', CFG.tiktok, () => tiktokProbe(CFG.tiktok), 45000) : null
  ].filter(Boolean));
  const live = probes.filter(p => p.status === 'live').sort((a, b) => PRIORITY.indexOf(a.platform) - PRIORITY.indexOf(b.platform));
  const featured = live[0] || null;
  const chats = await Promise.all(live.map(chatFor));
  const comments = chats.flat().filter(m => !isOwnMessage(m)).sort((a, b) => a.at - b.at).slice(-3)
    .map(m => ({ platform: m.platform, author: m.author, text: m.text.slice(0, 160), at: m.at }));
  const pub = p => ({ platform: p.platform, channel: p.channel, url: p.url, title: p.title || null, thumb: p.thumb || null, thumbFallback: p.thumbFallback || null, game: p.game || null, category: p.category || null, viewers: p.viewers ?? null, startedAt: p.startedAt || null });
  return {
    live: !!featured,
    featured: featured ? pub(featured) : null,
    others: live.slice(1).map(p => ({ platform: p.platform, channel: p.channel, url: p.url, title: p.title || null })),
    comments,
    checkedAt: new Date().toISOString(),
    _probes: probes.map(p => ({ platform: p.platform, channel: p.channel, status: p.status, held: !!p.held, error: p.error || null, ms: p.ms }))
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const debug = req.query?.debug === '1';
  res.setHeader('Cache-Control', debug ? 'no-store' : 'public, max-age=0, s-maxage=10, stale-while-revalidate=20');
  if (!debug && snapshot.data && Date.now() - snapshot.at < 12000) { const { _probes, ...out } = snapshot.data; return res.status(200).json(out); }
  try {
    const data = await collect();
    snapshot = { at: Date.now(), data };
    const { _probes, ...out } = data;
    return res.status(200).json(debug ? { ...out, _debug: { probes: _probes, keys: { youtubeApi: !!YT_KEY, twitchApi: !!(TW_ID && TW_SECRET), kickApi: !!(KICK_ID && KICK_SECRET) } } } : out);
  } catch (e) {
    if (snapshot.data) { const { _probes, ...out } = snapshot.data; return res.status(200).json(out); }
    return res.status(200).json({ live: false, featured: null, others: [], comments: [] });
  }
}
