import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
const loaded = [];
for (const name of ['.env', '.env.local', '.env.production', '.env.simkl']) {
  const file = resolve(root, name);
  if (!existsSync(file)) continue;
  loaded.push(name);
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith('#')) continue;
    const v = m[2].trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (v) env[m[1]] = v;
  }
}
const HUB = (env.HUB_URL || process.env.HUB_URL || 'https://uwaazy.vercel.app').replace(/\/+$/, '');

const http = async (url, opts = {}) => {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(12000) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json };
  } catch (e) {
    return { status: 0, text: '', json: null, err: e?.cause?.code || e?.name || String(e) };
  }
};
const ok = msg => ['OK', msg];
const bad = msg => ['ERRO', msg];
const warn = msg => ['AVISO', msg];
const skip = msg => ['--', msg];
const net = r => (r.status === 0 ? warn('sem resposta (' + (r.err || 'rede') + ')') : null);
const need = (...keys) => keys.filter(k => !env[k]);

const checks = [];
const add = (name, fn) => checks.push({ name, fn });

add('Simkl (token)', async () => {
  const miss = need('SIMKL_CLIENT_ID', 'SIMKL_TOKEN');
  if (miss.length) return skip('faltando no .env local: ' + miss.join(', '));
  const r = await http('https://api.simkl.com/sync/activities', { headers: { Authorization: `Bearer ${env.SIMKL_TOKEN}`, 'simkl-api-key': env.SIMKL_CLIENT_ID, 'User-Agent': 'wagner-hub/1.3' } });
  if (net(r)) return net(r);
  if (r.status === 200) return ok('valido');
  if (r.status === 401) return bad('token expirado ou invalido. Rode: node tools\\simkl-auth.mjs');
  if (r.status === 412 || r.status === 403) return bad('Client ID invalido ou bloqueado (HTTP ' + r.status + ')');
  if (r.status === 429) return warn('limite de requisicoes atingido, tente mais tarde');
  return warn('HTTP ' + r.status);
});

add('Trakt', async () => {
  const miss = need('TRAKT_CLIENT_ID', 'TRAKT_USER');
  if (miss.length) return skip('nao configurado (opcional)');
  const r = await http(`https://api.trakt.tv/users/${encodeURIComponent(env.TRAKT_USER)}/watching`, { headers: { 'trakt-api-key': env.TRAKT_CLIENT_ID, 'trakt-api-version': '2', 'User-Agent': 'wagner-hub/1.3' } });
  if (net(r)) return net(r);
  if (r.status === 200 || r.status === 204) return ok('valido');
  if (r.status === 401 || r.status === 403) return bad('Client ID invalido (HTTP ' + r.status + ')');
  if (r.status === 404) return warn('usuario nao encontrado');
  return warn('HTTP ' + r.status);
});

add('Last.fm', async () => {
  const miss = need('LASTFM_API_KEY');
  if (miss.length) return skip('faltando no .env local: LASTFM_API_KEY');
  const user = env.LASTFM_USER || env.LASTFM_USERNAME || 'WagnerSilva17';
  const r = await http(`https://ws.audioscrobbler.com/2.0/?method=user.getinfo&user=${encodeURIComponent(user)}&api_key=${encodeURIComponent(env.LASTFM_API_KEY)}&format=json`);
  if (net(r)) return net(r);
  if (r.json?.user) return ok('valida');
  if (r.json?.error === 10) return bad('API key invalida');
  if (r.json?.error === 26) return bad('API key suspensa');
  return warn(r.json?.message || 'HTTP ' + r.status);
});

add('stats.fm', async () => {
  if (!env.STATSFM_USER_ID) return skip('faltando no .env local: STATSFM_USER_ID');
  const r = await http(`https://api.stats.fm/api/v1/users/${encodeURIComponent(env.STATSFM_USER_ID)}`);
  if (net(r)) return net(r);
  return r.status === 200 ? ok('usuario acessivel') : r.status === 404 ? bad('usuario nao encontrado') : warn('HTTP ' + r.status);
});

add('TMDB', async () => {
  if (!env.TMDB_API_KEY) return skip('faltando no .env local: TMDB_API_KEY');
  const r = await http(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(env.TMDB_API_KEY)}`);
  if (net(r)) return net(r);
  return r.status === 200 ? ok('valida') : r.status === 401 ? bad('API key invalida') : warn('HTTP ' + r.status);
});

add('SteamGridDB', async () => {
  const key = env.STEAMGRIDDB_API_KEY || env.SGDB_API_KEY;
  if (!key) return skip('faltando no .env local: STEAMGRIDDB_API_KEY');
  const r = await http('https://www.steamgriddb.com/api/v2/search/autocomplete/portal', { headers: { Authorization: `Bearer ${key}` } });
  if (net(r)) return net(r);
  return r.status === 200 ? ok('valida') : r.status === 401 ? bad('API key invalida') : warn('HTTP ' + r.status);
});

add('YouTube', async () => {
  if (!env.YOUTUBE_API_KEY) return skip('nao configurado (opcional)');
  const r = await http(`https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
  if (net(r)) return net(r);
  if (r.status === 200) return ok('valida');
  return bad(r.json?.error?.errors?.[0]?.reason || r.json?.error?.message || 'HTTP ' + r.status);
});

add('Twitch', async () => {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return skip('nao configurado (opcional)');
  const r = await http('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }) });
  if (net(r)) return net(r);
  return r.status === 200 && r.json?.access_token ? ok('valido') : bad(r.json?.message || 'HTTP ' + r.status);
});

add('Kick', async () => {
  if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) return skip('nao configurado (opcional)');
  const r = await http('https://id.kick.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.KICK_CLIENT_ID, client_secret: env.KICK_CLIENT_SECRET, grant_type: 'client_credentials' }) });
  if (net(r)) return net(r);
  return r.status === 200 && r.json?.access_token ? ok('valido') : bad('HTTP ' + r.status);
});

add('Upstash Redis', async () => {
  const url = (env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '').replace(/\/+$/, '');
  const tok = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !tok) return skip('faltando no .env local: UPSTASH_REDIS_REST_URL / TOKEN');
  const r = await http(/^https?:/.test(url) ? url + '/ping' : 'https://' + url + '/ping', { headers: { Authorization: `Bearer ${tok}` } });
  if (net(r)) return net(r);
  return r.json?.result === 'PONG' ? ok('conectado') : bad('HTTP ' + r.status);
});

add('YourGamerProfile', async () => {
  if (!env.YGP_GAMES_URL) return skip('nao configurado (usa a pagina publica)');
  const r = await http(env.YGP_GAMES_URL, { headers: { 'User-Agent': 'Mozilla/5.0', ...(env.YGP_COOKIE ? { Cookie: env.YGP_COOKIE } : {}) } });
  if (net(r)) return net(r);
  if (r.status === 200) return ok('acessivel');
  if (r.status === 401 || r.status === 403) return bad('acesso negado (cookie/URL expirados?)');
  return warn('HTTP ' + r.status);
});

add(`Hub em producao: Simkl`, async () => {
  const r = await http(`${HUB}/api/simkl?debug=1`, { headers: { 'Cache-Control': 'no-cache' } });
  if (net(r)) return net(r);
  const d = r.json?._debug || {};
  if (d.tokenExpired) return bad('o SIMKL_TOKEN do Vercel expirou. Renove e faca um deploy novo');
  if (d.errorStatus === 401) return bad('Simkl recusou as credenciais do Vercel (401)');
  if (d.blockedForMin) return warn(`Simkl em pausa por limite (${d.blockedForMin} min), mostrando dado salvo`);
  if (d.error) return warn(String(d.error).slice(0, 90));
  if (r.status !== 200) return warn('HTTP ' + r.status);
  return ok(`respondendo (${r.json?.title || 'sem item'}, fonte ${r.json?.source || '?'})`);
});

add('Hub em producao: musica', async () => {
  const r = await http(`${HUB}/api/music?recent=1`);
  if (net(r)) return net(r);
  if (r.status !== 200) return warn('HTTP ' + r.status);
  return r.json?.error ? bad(String(r.json.error).slice(0, 90)) : ok('respondendo');
});

add('Hub em producao: jogos', async () => {
  const r = await http(`${HUB}/api/activity?debug=1`);
  if (net(r)) return net(r);
  if (r.status !== 200) return warn('HTTP ' + r.status);
  const redis = r.json?._debug?.redis;
  if (redis && redis !== 'ok') return bad('Redis: ' + redis);
  return ok(`respondendo (fonte ${r.json?.source || '?'})`);
});

add('Hub em producao: addon Nuvio', async () => {
  const tok = env.NUVIO_ADDON_TOKEN;
  if (!tok) return skip('coloque NUVIO_ADDON_TOKEN no .env local para testar');
  const r = await http(`${HUB}/api/nuvio/${encodeURIComponent(tok)}/manifest.json`);
  if (net(r)) return net(r);
  if (r.status === 200 && r.json?.name) return ok('manifest acessivel');
  if (r.status === 404) return bad('404: token diferente do Vercel ou deploy sem o addon');
  if (r.status === 503) return bad('NUVIO_ADDON_TOKEN ausente no Vercel');
  return warn('HTTP ' + r.status);
});

console.log('');
console.log('Verificando chaves e servicos...');
console.log('Arquivos lidos: ' + (loaded.length ? loaded.join(', ') : 'nenhum (so testes de producao)'));
console.log('Hub: ' + HUB);
console.log('');

const results = await Promise.all(checks.map(async c => {
  try { return [c.name, ...(await c.fn())]; } catch (e) { return [c.name, 'AVISO', String(e?.message || e).slice(0, 90)]; }
}));
const tag = { OK: '[ OK  ]', ERRO: '[ERRO ]', AVISO: '[AVISO]', '--': '[ --  ]' };
for (const [name, st, msg] of results) console.log(`${tag[st]} ${name.padEnd(30)} ${msg}`);

const erros = results.filter(r => r[1] === 'ERRO').length;
const avisos = results.filter(r => r[1] === 'AVISO').length;
console.log('');
console.log(erros ? `${erros} problema(s) para corrigir.` : avisos ? 'Nenhum erro, mas veja os avisos acima.' : 'Tudo certo.');
console.log('');
process.exitCode = erros ? 1 : 0;
