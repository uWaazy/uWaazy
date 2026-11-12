import http from 'node:http';
import { exec } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';

const id = process.env.SIMKL_CLIENT_ID;
if (!id) { console.error('Set SIMKL_CLIENT_ID first.'); process.exit(1); }
if (/^\d{1,12}$/.test(id)) console.warn('Aviso: esse valor parece um ID de usuario. O Client ID do app Simkl e uma sequencia longa de letras e numeros.');

const OUT_FILE = '.env.simkl';
const redirect = 'http://localhost:8095/callback';
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(12).toString('hex');
const url = `https://simkl.com/oauth2/authorize?response_type=code&client_id=${id}&redirect_uri=${encodeURIComponent(redirect)}` +
  `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&app-name=wagner-hub&app-version=1.3`;

const openBrowser = target => {
  const cmd = process.platform === 'win32' ? `start "" "${target}"` : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`;
  exec(cmd, err => { if (err) console.log('Nao consegui abrir o navegador. Abra esta URL:\n\n' + target + '\n'); });
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (u.pathname !== '/callback') return res.end();
  if (u.searchParams.get('state') !== state) return res.end('bad state');
  const r = await fetch(`https://api.simkl.com/oauth2/token?client_id=${id}&app-name=wagner-hub&app-version=1.3`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'wagner-hub/1.3' },
    body: JSON.stringify({ code: u.searchParams.get('code'), client_id: id, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  if (!j.access_token) {
    res.end('Failed: ' + JSON.stringify(j));
    console.log(j);
    process.exit(1);
  }
  writeFileSync(OUT_FILE, `SIMKL_TOKEN=${j.access_token}\n`, 'utf8');
  res.end('Pronto! Volte ao terminal e feche esta aba.');
  console.log(`\nToken salvo em ${OUT_FILE}. Abra esse arquivo no VS Code, copie o valor, cole no Vercel e depois apague o arquivo.`);
  process.exit(0);
}).listen(8095, () => { console.log('Abrindo o navegador...'); openBrowser(url); });
