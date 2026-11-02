import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

const id = process.env.SIMKL_CLIENT_ID;
if (!id) { console.error('Set SIMKL_CLIENT_ID first.'); process.exit(1); }
const redirect = 'http://localhost:8095/callback';
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(12).toString('hex');
const url = `https://simkl.com/oauth2/authorize?response_type=code&client_id=${id}&redirect_uri=${encodeURIComponent(redirect)}` +
  `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&app-name=wagner-hub&app-version=1.3`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (u.pathname !== '/callback') return res.end();
  if (u.searchParams.get('state') !== state) return res.end('bad state');
  const r = await fetch(`https://api.simkl.com/oauth2/token?client_id=${id}&app-name=wagner-hub&app-version=1.3`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'wagner-hub/1.3' },
    body: JSON.stringify({ code: u.searchParams.get('code'), client_id: id, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  res.end(j.access_token ? 'Done! Go back to the terminal and close this tab.' : 'Failed: ' + JSON.stringify(j));
  console.log(j.access_token ? `\nSIMKL_TOKEN=${j.access_token}\n\n(put it in Vercel env vars, never in the repo)` : j);
  process.exit(0);
}).listen(8095, () => console.log('Open this URL in your browser:\n\n' + url + '\n'));
