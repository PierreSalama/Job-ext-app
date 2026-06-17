// JAT v11 — one-time helper to capture a Chrome Web Store API REFRESH TOKEN.
//
// Google removed the old copy-paste ("oob") flow, so this runs the modern
// loopback flow for you: it starts a tiny localhost server, opens Google's
// consent page, catches the redirect, exchanges the code, and writes the
// refresh token into tools/.cws-credentials.json. Run it ONCE.
//
//   PREREQ: tools/.cws-credentials.json already has clientId + clientSecret
//           (from the OAuth "Desktop app" client you created in Cloud Console).
//   RUN:    node tools/cws-get-token.mjs
//
// A "Desktop app" OAuth client allows http://localhost redirects automatically,
// so you do NOT need to register a redirect URI anywhere.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const credPath = path.join(here, '.cws-credentials.json');
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

if (!fs.existsSync(credPath)) {
  console.error(`\n  Missing ${credPath}\n  Create it first with at least:\n  { "clientId": "...apps.googleusercontent.com", "clientSecret": "..." }\n`);
  process.exit(1);
}
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
if (!cred.clientId || !cred.clientSecret) {
  console.error('\n  .cws-credentials.json needs both "clientId" and "clientSecret" before running this.\n');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (err) { res.end(`Auth error: ${err}. You can close this tab.`); console.error('\n  Consent denied/error:', err); server.close(); process.exit(1); }
  if (!code) { res.statusCode = 204; res.end(); return; }   // ignore favicon etc.
  try {
    const port = server.address().port;
    const body = new URLSearchParams({
      code, client_id: cred.clientId, client_secret: cred.clientSecret,
      redirect_uri: `http://localhost:${port}`, grant_type: 'authorization_code',
    });
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
    const tok = await r.json();
    if (!tok.refresh_token) {
      res.end('No refresh_token returned — re-run (the script forces prompt=consent). You can close this tab.');
      console.error('\n  No refresh_token in response:', JSON.stringify(tok));
      server.close(); process.exit(1);
    }
    cred.refreshToken = tok.refresh_token;
    fs.writeFileSync(credPath, JSON.stringify(cred, null, 2) + '\n');
    res.end('Success! Refresh token saved. You can close this tab and return to the terminal.');
    console.log('\n  ✓ refresh token captured and written to tools/.cws-credentials.json');
    console.log(cred.itemId
      ? '  ✓ itemId already present — you are ready: run  .\\tools\\cws-publish.ps1\n'
      : '  → Last thing: add your store "itemId" to tools/.cws-credentials.json, then run .\\tools\\cws-publish.ps1\n');
    server.close(); process.exit(0);
  } catch (e) {
    res.end('Token exchange failed: ' + e.message);
    console.error('\n  Token exchange failed:', e.message);
    server.close(); process.exit(1);
  }
});

server.listen(0, () => {
  const port = server.address().port;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: cred.clientId,
    redirect_uri: `http://localhost:${port}`,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  console.log('\n  Opening Google consent in your browser...');
  console.log('  If it does not open, paste this URL:\n\n  ' + authUrl + '\n');
  // Best-effort open on Windows; harmless if it fails (the URL is printed above).
  try { spawn('cmd', ['/c', 'start', '', authUrl], { detached: true, stdio: 'ignore' }).unref(); } catch {}
});
