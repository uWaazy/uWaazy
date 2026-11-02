const LASTFM_USER = (process.env.LASTFM_USER || process.env.LASTFM_USERNAME || 'WagnerSilva17').trim();
const LASTFM_KEY = (process.env.LASTFM_API_KEY || '').trim();
const STAT_USER = (process.env.STATSFM_USER_ID || 'uwaazy').trim();
const LASTFM_URL = 'https://ws.audioscrobbler.com/2.0/';
const STATSFM_BASE = 'https://api.stats.fm/api/v1';
const UA = 'uWaazy-hub/1.6';

const memCache = new Map();
async function withCache(key, ttlMs, fn) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  memCache.set(key, { at: Date.now(), value });
  return value;
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

async function fetchJson(url, timeoutMs = 7000) {
  const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function safeJson(url, timeoutMs = 6500) {
  try { return await fetchJson(url, timeoutMs); } catch { return null; }
}

async function lastfm(method, extra = {}) {
  if (!LASTFM_KEY) throw new Error('LASTFM_API_KEY missing in Vercel');
  const url = new URL(LASTFM_URL);
  for (const [key, value] of Object.entries({ method, user: LASTFM_USER, api_key: LASTFM_KEY, format: 'json', ...extra })) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
  const data = await response.json();
  if (data?.error) throw new Error(`Last.fm ${data.error}: ${data.message || 'API error'}`);
  return data;
}

async function safeLastfm(method, extra = {}) {
  try { return await lastfm(method, extra); } catch { return null; }
}

const PLACEHOLDER_RE = /2a96cbd8b46e442fc41c2b86b821562f|4128a6eb29f94943c9d206c08e625904|818148bf682d429dc215c1705eb27b98/i;

const lastImage = images => {
  if (!Array.isArray(images)) return null;
  const candidates = [...images].reverse().map(x => x?.['#text']).filter(Boolean);
  return candidates.find(url => !PLACEHOLDER_RE.test(url)) || null;
};

const artistName = artist => typeof artist === 'string' ? artist : artist?.name || artist?.['#text'] || '';

function pickImage(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.startsWith('http') ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = pickImage(item); if (found) return found; }
    return null;
  }
  for (const key of ['url', 'src', 'href', 'large', 'medium', 'small', 'image']) {
    const found = pickImage(value[key]);
    if (found) return found;
  }
  return null;
}

async function searchStatsfm(query) {
  if (!query) return null;
  return withCache(`sf-search:${norm(query)}`, 30 * 60e3, async () => {
    const u = `${STATSFM_BASE}/search?query=${encodeURIComponent(query)}`;
    const d = await safeJson(u, 5000);
    return d?.items || null;
  });
}

async function resolveMediaImage(kind, title, artist = '') {
  if (!title) return null;
  const items = await searchStatsfm(title);
  if (!items) return null;
  const nTitle = norm(title);
  const nArtist = norm(artist);
  if (kind === 'artist') {
    const list = items.artists || [];
    const hit = list.find(a => norm(a.name) === nTitle) || list[0];
    return hit?.image || null;
  }
  if (kind === 'track') {
    const list = items.tracks || [];
    const hit = list.find(t => (!nArtist || t.artists?.some(a => norm(a.name).includes(nArtist) || nArtist.includes(norm(a.name))))) || list[0];
    return hit?.albums?.[0]?.image || hit?.artists?.[0]?.image || null;
  }
  if (kind === 'album') {
    const list = items.albums || [];
    const hit = list.find(a => (!nArtist || a.artists?.some(ar => norm(ar.name).includes(nArtist)))) || list[0];
    return hit?.image || null;
  }
  return null;
}

function normalizeRecent(recentData) {
  const raw = recentData?.recenttracks?.track;
  const tracks = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const live = tracks.find(track => track?.['@attr']?.nowplaying === 'true' || track?.nowplaying === true || track?.nowplaying === 'true') || null;
  const latest = tracks.find(track => track !== live) || tracks[0] || null;
  const mapTrack = track => track ? ({
    title: track.name || '',
    artist: artistName(track.artist),
    album: track.album?.['#text'] || track.album?.name || '',
    image: lastImage(track.image),
    url: track.url || null,
    date: track.date?.uts ? Number(track.date.uts) : null
  }) : null;
  return { live: !!live, current: mapTrack(live), lastTrack: mapTrack(live || latest) };
}

async function findStatsfmTrack(title, artist) {
  const nTitle = norm(title);
  const nArtist = norm(artist);
  if (!nTitle) return null;
  if (STAT_USER) {
    const [cur, rec] = await Promise.all([
      safeJson(`${STATSFM_BASE}/users/${encodeURIComponent(STAT_USER)}/streams/current`, 4500),
      safeJson(`${STATSFM_BASE}/users/${encodeURIComponent(STAT_USER)}/streams/recent?limit=12`, 4500)
    ]);
    const candidates = [
      cur?.item?.track,
      ...(Array.isArray(rec?.items) ? rec.items.map(x => x?.track) : [])
    ].filter(Boolean);
    const direct = candidates.find(t => {
      const tMatch = norm(t.name) === nTitle || norm(t.name).includes(nTitle) || nTitle.includes(norm(t.name));
      const aMatch = !nArtist || (t.artists || []).some(a => norm(a.name) === nArtist || norm(a.name).includes(nArtist) || nArtist.includes(norm(a.name)));
      return tMatch && aMatch;
    });
    if (direct) return direct;
  }
  const searched = await searchStatsfm(title);
  const tracks = searched?.tracks || [];
  return tracks.find(t => !nArtist || (t.artists || []).some(a => norm(a.name) === nArtist || norm(a.name).includes(nArtist) || nArtist.includes(norm(a.name)))) || tracks[0] || null;
}

async function getTrackContext(track, isLive = false) {
  if (!track || !track.title) return null;
  const cacheKey = `ctx:${norm(track.artist)}|${norm(track.title)}`;
  return withCache(cacheKey, 120e3, async () => {
    const [lfTrackRes, sfTrack] = await Promise.all([
      LASTFM_KEY ? safeLastfm('track.getInfo', { artist: track.artist, track: track.title, username: LASTFM_USER, autocorrect: 1 }) : null,
      findStatsfmTrack(track.title, track.artist)
    ]);

    const lfTrack = lfTrackRes?.track || null;
    const loved = lfTrack?.userloved === '1' || lfTrack?.userloved === 1 || lfTrack?.userloved === true;
    const lfTrackPlays = Number(lfTrack?.userplaycount || 0) || 0;
    const albumName = track.album || lfTrack?.album?.title || sfTrack?.albums?.[0]?.name || '';
    const coverImg = track.image || lastImage(lfTrack?.album?.image) || sfTrack?.albums?.[0]?.image || null;

    const sfTrackId = sfTrack?.id || null;
    const sfAlbumId = sfTrack?.albums?.[0]?.id || null;
    const sfArtistId = sfTrack?.artists?.[0]?.id || null;
    const uEnc = encodeURIComponent(STAT_USER);

    const [tAsc, tStats, alStats, arAsc, lfAlbumRes] = await Promise.all([
      sfTrackId && STAT_USER ? safeJson(`${STATSFM_BASE}/users/${uEnc}/streams/tracks/${sfTrackId}?order=asc&limit=1`, 5000) : null,
      sfTrackId && STAT_USER ? safeJson(`${STATSFM_BASE}/users/${uEnc}/streams/tracks/${sfTrackId}/stats`, 5000) : null,
      sfAlbumId && STAT_USER ? safeJson(`${STATSFM_BASE}/users/${uEnc}/streams/albums/${sfAlbumId}/stats`, 5000) : null,
      sfArtistId && STAT_USER ? safeJson(`${STATSFM_BASE}/users/${uEnc}/streams/artists/${sfArtistId}?order=asc&limit=1`, 5000) : null,
      LASTFM_KEY && albumName && track.artist ? safeLastfm('album.getInfo', { artist: track.artist, album: albumName, username: LASTFM_USER, autocorrect: 1 }) : null
    ]);

    const sfTrackPlays = Number(tStats?.items?.count ?? tStats?.item?.count ?? 0) || 0;
    const sfAlbumPlays = Number(alStats?.item?.count ?? alStats?.items?.count ?? 0) || 0;
    const lfAlbumPlays = Number(lfAlbumRes?.album?.userplaycount || 0) || 0;

    const firstTrackIso = tAsc?.items?.[0]?.endTime || (track.date ? new Date(track.date * 1000).toISOString() : null);
    const firstArtistIso = arAsc?.items?.[0]?.endTime || null;
    const trackPlays = Math.max(lfTrackPlays, sfTrackPlays, isLive ? 1 : 0);
    const albumPlays = Math.max(lfAlbumPlays, sfAlbumPlays);

    return {
      title: track.title,
      artist: track.artist,
      album: albumName || null,
      image: coverImg,
      loved,
      firstListenAt: firstTrackIso,
      trackPlays,
      albumPlays,
      showAlbum: Boolean(albumName && albumPlays > 20),
      artistFirstListenAt: firstArtistIso,
      urls: {
        track: sfTrackId ? `https://stats.fm/track/${sfTrackId}` : (track.url || `https://www.last.fm/user/${encodeURIComponent(LASTFM_USER)}`),
        album: sfAlbumId ? `https://stats.fm/album/${sfAlbumId}` : (albumName ? `https://www.last.fm/music/${encodeURIComponent(track.artist)}/${encodeURIComponent(albumName)}` : null),
        artist: sfArtistId ? `https://stats.fm/artist/${sfArtistId}` : `https://www.last.fm/music/${encodeURIComponent(track.artist)}`,
        loved: `https://www.last.fm/user/${encodeURIComponent(LASTFM_USER)}/loved`
      }
    };
  });
}

async function getLastfmRecent() {
  let recent = { live: false, current: null, lastTrack: null };
  try {
    const recentData = await lastfm('user.getRecentTracks', { limit: 2 });
    recent = normalizeRecent(recentData);
  } catch (err) {
    if (!STAT_USER) throw err;
    const uEnc = encodeURIComponent(STAT_USER);
    const [cur, rec] = await Promise.all([
      safeJson(`${STATSFM_BASE}/users/${uEnc}/streams/current`, 4500),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/streams/recent?limit=1`, 4500)
    ]);
    const curTr = cur?.item?.track;
    const recItem = rec?.items?.[0];
    const recTr = recItem?.track || curTr;
    const mapSf = (t, endIso) => t ? ({
      title: t.name || '',
      artist: t.artists?.[0]?.name || '',
      album: t.albums?.[0]?.name || '',
      image: t.albums?.[0]?.image || t.artists?.[0]?.image || null,
      url: t.id ? `https://stats.fm/track/${t.id}` : null,
      date: endIso ? Math.floor(new Date(endIso).getTime() / 1000) : null
    }) : null;
    const live = Boolean(cur?.item?.isPlaying && curTr);
    recent = {
      live,
      current: live ? mapSf(curTr, cur?.item?.date) : null,
      lastTrack: mapSf(live ? curTr : recTr, live ? cur?.item?.date : recItem?.endTime)
    };
  }
  const track = recent.lastTrack;
  const trackInfo = await getTrackContext(track, recent.live);
  if (track && !track.image) {
    track.image = trackInfo?.image || await resolveMediaImage('track', track.title, track.artist);
    if (recent.current && !recent.current.image) recent.current.image = track.image;
  }
  return { ...recent, trackInfo };
}

const firstEntry = v => Array.isArray(v) ? v[0] : v || null;

async function getLastfm() {
  const recentPromise = getLastfmRecent();
  const aggregatesPromise = withCache(`lf-agg:${LASTFM_USER}`, 180e3, async () => {
    const [userData, tracks7d, albums7d, artists7d, albums6m, albumsAll, tracksAll, artists1y, artistsAll, lovedData, sfUser] = await Promise.all([
      safeLastfm('user.getInfo'),
      safeLastfm('user.getTopTracks', { period: '7day', limit: 1 }),
      safeLastfm('user.getTopAlbums', { period: '7day', limit: 1 }),
      safeLastfm('user.getTopArtists', { period: '7day', limit: 1 }),
      safeLastfm('user.getTopAlbums', { period: '6month', limit: 1 }),
      safeLastfm('user.getTopAlbums', { period: 'overall', limit: 1 }),
      safeLastfm('user.getTopTracks', { period: 'overall', limit: 1 }),
      safeLastfm('user.getTopArtists', { period: '12month', limit: 1 }),
      safeLastfm('user.getTopArtists', { period: 'overall', limit: 1 }),
      safeLastfm('user.getLovedTracks', { limit: 1 }),
      STAT_USER ? safeJson(`${STATSFM_BASE}/users/${encodeURIComponent(STAT_USER)}`, 5000) : null
    ]);

    const u = userData?.user || {};
    const totalScrobbles = Number(u.playcount || 0) || 0;
    const profileImg = lastImage(u.image) || sfUser?.item?.image || 'assets/logo.webp';
    const profileBase = `https://www.last.fm/user/${encodeURIComponent(LASTFM_USER)}`;

    const topTrack7d = firstEntry(tracks7d?.toptracks?.track);
    const topAlbum7d = firstEntry(albums7d?.topalbums?.album);
    const topArtist7d = firstEntry(artists7d?.topartists?.artist);
    const topAlbum = firstEntry(albums6m?.topalbums?.album);
    const topAlbumAll = firstEntry(albumsAll?.topalbums?.album);
    const topTrack = firstEntry(tracksAll?.toptracks?.track);
    const topArtist1y = firstEntry(artists1y?.topartists?.artist);
    const topArtistAll = firstEntry(artistsAll?.topartists?.artist);

    const lovedTotal = Number(lovedData?.lovedtracks?.['@attr']?.total || 0) || 0;
    const lastLoved = firstEntry(lovedData?.lovedtracks?.track);

    const [tr7dImg, al7dImg, ar7dImg, albumImg, alAllImg, trackImg, art1yImg, artAllImg, lovedImg] = await Promise.all([
      topTrack7d ? (lastImage(topTrack7d.image) || resolveMediaImage('track', topTrack7d.name, artistName(topTrack7d.artist))) : null,
      topAlbum7d ? (lastImage(topAlbum7d.image) || resolveMediaImage('album', topAlbum7d.name, artistName(topAlbum7d.artist))) : null,
      topArtist7d ? (lastImage(topArtist7d.image) || resolveMediaImage('artist', topArtist7d.name)) : null,
      topAlbum ? (lastImage(topAlbum.image) || resolveMediaImage('album', topAlbum.name, artistName(topAlbum.artist))) : null,
      topAlbumAll ? (lastImage(topAlbumAll.image) || resolveMediaImage('album', topAlbumAll.name, artistName(topAlbumAll.artist))) : null,
      topTrack ? (lastImage(topTrack.image) || resolveMediaImage('track', topTrack.name, artistName(topTrack.artist))) : null,
      topArtist1y ? (lastImage(topArtist1y.image) || resolveMediaImage('artist', topArtist1y.name)) : null,
      topArtistAll ? (lastImage(topArtistAll.image) || resolveMediaImage('artist', topArtistAll.name)) : null,
      lastLoved ? (lastImage(lastLoved.image) || resolveMediaImage('track', lastLoved.name, artistName(lastLoved.artist))) : null
    ]);

    const slides = [];
    if (totalScrobbles > 0) {
      slides.push({
        kind: 'total',
        title: u.realname || u.name || LASTFM_USER,
        subtitle: `@${u.name || LASTFM_USER}`,
        plays: totalScrobbles,
        image: profileImg,
        url: `${profileBase}/library`
      });
    }
    if (topTrack7d) {
      slides.push({
        kind: 'track7d',
        title: topTrack7d.name || '',
        artist: artistName(topTrack7d.artist),
        plays: Number(topTrack7d.playcount || 0),
        image: tr7dImg || profileImg,
        url: `${profileBase}/library/tracks?date_preset=LAST_7_DAYS`
      });
    }
    if (topAlbum7d) {
      slides.push({
        kind: 'album7d',
        title: topAlbum7d.name || '',
        artist: artistName(topAlbum7d.artist),
        plays: Number(topAlbum7d.playcount || 0),
        image: al7dImg || profileImg,
        url: `${profileBase}/library/albums?date_preset=LAST_7_DAYS`
      });
    }
    if (topArtist7d) {
      slides.push({
        kind: 'artist7d',
        title: topArtist7d.name || '',
        artist: '',
        plays: Number(topArtist7d.playcount || 0),
        image: ar7dImg || profileImg,
        url: `${profileBase}/library/artists?date_preset=LAST_7_DAYS`
      });
    }
    if (topAlbum) {
      slides.push({
        kind: 'album6m',
        title: topAlbum.name || '',
        artist: artistName(topAlbum.artist),
        plays: Number(topAlbum.playcount || 0),
        image: albumImg || profileImg,
        url: `${profileBase}/library/albums?date_preset=LAST_180_DAYS`
      });
    }
    if (topAlbumAll) {
      slides.push({
        kind: 'albumAll',
        title: topAlbumAll.name || '',
        artist: artistName(topAlbumAll.artist),
        plays: Number(topAlbumAll.playcount || 0),
        image: alAllImg || profileImg,
        url: `${profileBase}/library/albums?date_preset=ALL`
      });
    }
    if (topTrack) {
      slides.push({
        kind: 'trackAll',
        title: topTrack.name || '',
        artist: artistName(topTrack.artist),
        plays: Number(topTrack.playcount || 0),
        image: trackImg || profileImg,
        url: `${profileBase}/library/tracks?date_preset=ALL`
      });
    }
    if (topArtist1y) {
      slides.push({
        kind: 'artist1y',
        title: topArtist1y.name || '',
        artist: '',
        plays: Number(topArtist1y.playcount || 0),
        image: art1yImg || profileImg,
        url: `${profileBase}/library/artists?date_preset=LAST_365_DAYS`
      });
    }
    if (topArtistAll) {
      slides.push({
        kind: 'artistAll',
        title: topArtistAll.name || '',
        artist: '',
        plays: Number(topArtistAll.playcount || 0),
        image: artAllImg || profileImg,
        url: `${profileBase}/library/artists?date_preset=ALL`
      });
    }
    if (lovedTotal > 0 || totalScrobbles > 0) {
      slides.push({
        kind: 'loved',
        title: lastLoved?.name || (u.realname || LASTFM_USER),
        artist: lastLoved ? artistName(lastLoved.artist) : '',
        lovedCount: lovedTotal,
        plays: totalScrobbles,
        image: lovedImg || profileImg,
        url: `${profileBase}/loved`
      });
    }

    return {
      totalScrobbles,
      lovedTotal,
      profileImage: profileImg,
      album: topAlbum ? {
        title: topAlbum.name || '',
        artist: artistName(topAlbum.artist),
        plays: Number(topAlbum.playcount || 0),
        image: albumImg || profileImg,
        url: `${profileBase}/library/albums?date_preset=LAST_180_DAYS`
      } : null,
      slides,
      profile: profileBase
    };
  });

  const [recent, agg] = await Promise.all([recentPromise, aggregatesPromise]);
  if (agg.album && !agg.album.image && recent.lastTrack?.image) agg.album.image = recent.lastTrack.image;

  return {
    ...agg,
    live: recent.live,
    current: recent.current,
    lastTrack: recent.lastTrack,
    trackInfo: recent.trackInfo
  };
}

async function getTopPlaylist4w(uEnc, profileUrl) {
  try {
    const fourWeeksAgo = Date.now() - 28 * 86400 * 1000;
    const s1 = await safeJson(`${STATSFM_BASE}/users/${uEnc}/streams?after=${fourWeeksAgo}&limit=1000`, 6000);
    const items = Array.isArray(s1?.items) ? s1.items : [];
    const counts = new Map();
    for (const st of items) {
      const ctx = st?.contextId;
      if (typeof ctx === 'string' && ctx.startsWith('spotify:playlist:')) {
        counts.set(ctx, (counts.get(ctx) || 0) + 1);
      }
    }
    if (!counts.size) return null;
    const [topCtx, plays] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const plId = topCtx.split(':').pop();
    const oembed = await safeJson(`https://open.spotify.com/oembed?url=https://open.spotify.com/playlist/${encodeURIComponent(plId)}`, 5000);
    return {
      kind: 'playlist',
      title: oembed?.title || 'Spotify Playlist',
      artist: 'Spotify',
      streams: plays,
      image: oembed?.thumbnail_url || null,
      url: `${profileUrl}/streams`,
      spotifyUrl: `https://open.spotify.com/playlist/${encodeURIComponent(plId)}`
    };
  } catch {
    return null;
  }
}

function formatGenreTitle(tag) {
  return String(tag || '').split('/').map(part =>
    part.trim().replace(/\b\w/g, c => c.toUpperCase())
  ).join(' / ');
}

function mapSfAlbum(alItem, profileImage) {
  const alObj = alItem?.album || alItem;
  if (!alObj) return null;
  return {
    title: alObj.name || alObj.title || 'Unknown album',
    artist: alObj.artist?.name || alObj.artists?.[0]?.name || '',
    image: pickImage(alObj.image) || pickImage(alObj.images) || profileImage,
    streams: Number(alItem?.streams ?? alItem?.playCount ?? 0) || null,
    durationMs: Number(alItem?.playedMs ?? alItem?.durationMs ?? 0) || null
  };
}

function mapSfTrack(trItem, profileImage) {
  const trObj = trItem?.track || trItem;
  if (!trObj) return null;
  return {
    title: trObj.name || trObj.title || 'Unknown track',
    artist: trObj.artists?.[0]?.name || trObj.artist?.name || '',
    image: pickImage(trObj.albums?.[0]?.image) || pickImage(trObj.image) || profileImage,
    streams: Number(trItem?.streams ?? 0) || null,
    durationMs: Number(trItem?.playedMs ?? 0) || null
  };
}

function mapSfArtist(arItem, profileImage) {
  const arObj = arItem?.artist || arItem;
  if (!arObj) return null;
  return {
    title: arObj.name || 'Unknown artist',
    artist: Array.isArray(arObj.genres) && arObj.genres.length ? formatGenreTitle(arObj.genres[0]) : '',
    image: pickImage(arObj.image) || profileImage,
    streams: Number(arItem?.streams ?? 0) || null,
    durationMs: Number(arItem?.playedMs ?? 0) || null
  };
}

async function getStatsfm() {
  const profileUrl = `https://stats.fm/${encodeURIComponent(STAT_USER || 'uwaazy')}`;
  if (!STAT_USER) return { configured: false, album: null, slides: [], profile: profileUrl };

  return withCache(`sf-agg:${STAT_USER}`, 180e3, async () => {
    const uEnc = encodeURIComponent(STAT_USER);
    const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;
    const [
      userRes,
      statsRes,
      tracks7dRes,
      albums7dRes,
      artists7dRes,
      albumsRes,
      tracksRes,
      artistsRes,
      albumsAllRes,
      artistsAllRes,
      genresRes,
      topPlaylist
    ] = await Promise.all([
      safeJson(`${STATSFM_BASE}/users/${uEnc}`),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/streams/stats`),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/top/tracks?after=${sevenDaysAgo}&limit=1`),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/top/albums?after=${sevenDaysAgo}&limit=1`),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/top/artists?after=${sevenDaysAgo}&limit=1`),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/top/albums?range=weeks&limit=1`),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/top/tracks?range=weeks&limit=1`),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/top/artists?range=weeks&limit=1`),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/top/albums?range=lifetime&limit=1`),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/top/artists?range=lifetime&limit=1`),
      safeJson(`${STATSFM_BASE}/users/${uEnc}/top/genres?range=weeks&limit=1`),
      getTopPlaylist4w(uEnc, profileUrl)
    ]);

    const userItem = userRes?.item || {};
    const profileImage = userItem.image || 'assets/logo.webp';
    const displayName = userItem.displayName || userItem.customId || STAT_USER;
    const statsObj = statsRes?.items || statsRes?.item || {};
    const totalStreams = Number(statsObj.count || 0) || null;
    const totalDurationMs = Number(statsObj.durationMs || 0) || null;

    const track7dData = mapSfTrack(tracks7dRes?.items?.[0], profileImage);
    const album7dData = mapSfAlbum(albums7dRes?.items?.[0], profileImage);
    const artist7dData = mapSfArtist(artists7dRes?.items?.[0], profileImage);
    const albumData = mapSfAlbum(albumsRes?.items?.[0], profileImage);
    const trackData = mapSfTrack(tracksRes?.items?.[0], profileImage);
    const artistData = mapSfArtist(artistsRes?.items?.[0], profileImage);
    const albumAllData = mapSfAlbum(albumsAllRes?.items?.[0], profileImage);
    const artistAllData = mapSfArtist(artistsAllRes?.items?.[0], profileImage);

    const geItem = genresRes?.items?.[0] || null;
    const geTag = geItem?.genre?.tag || geItem?.tag || '';
    const geTopArtist = geItem?.previewArtists?.[0]?.artist || null;
    const gePreviewNames = (geItem?.previewArtists || []).slice(0, 2).map(x => x?.artist?.name).filter(Boolean).join(', ');
    const genreData = geTag ? {
      title: formatGenreTitle(geTag),
      artist: gePreviewNames,
      image: pickImage(geTopArtist?.image) || artistData?.image || profileImage,
      streams: Number(geItem?.streams ?? 0) || null,
      durationMs: Number(geItem?.playedMs ?? 0) || null
    } : null;

    const slides = [];
    if (totalStreams) {
      slides.push({
        kind: 'total',
        title: displayName,
        artist: `@${userItem.customId || STAT_USER}`,
        streams: totalStreams,
        durationMs: totalDurationMs,
        image: profileImage,
        url: profileUrl
      });
    }
    if (track7dData) {
      slides.push({
        kind: 'track7d',
        ...track7dData,
        url: `${profileUrl}/tracks`
      });
    }
    if (album7dData) {
      slides.push({
        kind: 'album7d',
        ...album7dData,
        url: `${profileUrl}/albums`
      });
    }
    if (artist7dData) {
      slides.push({
        kind: 'artist7d',
        ...artist7dData,
        url: `${profileUrl}/artists`
      });
    }
    if (albumData) {
      slides.push({
        kind: 'album',
        ...albumData,
        url: `${profileUrl}/albums?range=weeks`
      });
    }
    if (trackData) {
      slides.push({
        kind: 'track',
        ...trackData,
        url: `${profileUrl}/tracks?range=weeks`
      });
    }
    if (artistData) {
      slides.push({
        kind: 'artist',
        ...artistData,
        url: `${profileUrl}/artists?range=weeks`
      });
    }
    if (albumAllData) {
      slides.push({
        kind: 'albumAll',
        ...albumAllData,
        url: `${profileUrl}/albums?range=lifetime`
      });
    }
    if (artistAllData) {
      slides.push({
        kind: 'artistAll',
        ...artistAllData,
        url: `${profileUrl}/artists?range=lifetime`
      });
    }
    if (genreData) {
      slides.push({
        kind: 'genre',
        ...genreData,
        url: `${profileUrl}/genres?range=weeks`
      });
    }
    if (topPlaylist) {
      slides.push({
        ...topPlaylist,
        image: topPlaylist.image || albumData?.image || profileImage
      });
    }

    return {
      configured: true,
      profileImage,
      totalStreams,
      totalDurationMs,
      album: albumData,
      slides,
      profile: profileUrl
    };
  });
}

export { getTrackContext, getStatsfm, getLastfm };
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  if (req.query?.recent === '1') {
    try {
      const recent = await getLastfmRecent();
      return res.status(200).json({ lastfm: recent });
    } catch (error) {
      return res.status(502).json({ lastfm: { error: error?.message || 'Last.fm unavailable' } });
    }
  }
  const [lastfmResult, statsfmResult] = await Promise.allSettled([getLastfm(), getStatsfm()]);
  return res.status(200).json({
    lastfm: lastfmResult.status === 'fulfilled' ? lastfmResult.value : { error: lastfmResult.reason?.message || 'Last.fm unavailable' },
    statsfm: statsfmResult.status === 'fulfilled' ? statsfmResult.value : { error: statsfmResult.reason?.message || 'stats.fm unavailable' }
  });
}
