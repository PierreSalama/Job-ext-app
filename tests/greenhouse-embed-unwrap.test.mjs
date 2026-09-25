// The AI lane could not read cross-origin Greenhouse iframes (#grnhse_iframe) on company-hosted
// pages, so 50+ runs parked. The fix opens the iframe's own URL as the top-level page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cdp = require(path.join(here, '..', 'app', 'src', 'browser', 'cdp.js'));
const F = cdp.greenhouseEmbedUrl;

test('iframe src on the page is opened directly', () => {
  assert.equal(
    F({ href: 'https://stripe.com/jobs/search?gh_jid=555', iframes: ['https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=555'] }),
    'https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=555');
});
test('gh_jid + board from the embed script builds the form URL when no iframe is present yet', () => {
  assert.equal(
    F({ href: 'https://www.databricks.com/company/careers/x?gh_jid=77', scripts: ['https://boards.greenhouse.io/embed/job_board/js?for=databricks'] }),
    'https://job-boards.greenhouse.io/embed/job_app?for=databricks&token=77');
});
test('careerpuck job URLs map to the Greenhouse form', () => {
  assert.equal(F({ href: 'https://careerpuck.com/job-board/lyft/job/8123' }),
    'https://job-boards.greenhouse.io/embed/job_app?for=lyft&token=8123');
});
test('already on greenhouse, or an unrelated page, is left alone', () => {
  assert.equal(F({ href: 'https://job-boards.greenhouse.io/embed/job_app?for=x&token=1', iframes: ['https://job-boards.greenhouse.io/embed/job_app?for=x&token=1'] }), null);
  assert.equal(F({ href: 'https://example.com/careers', iframes: ['https://www.youtube.com/embed/x'] }), null);
  assert.equal(F({ href: 'not a url' }), null);
});

// Real-browser: a page that never mentions Greenhouse must not be touched by unwrapEmbed.
const chromePath = cdp.findChrome();
(chromePath ? test : test.skip)('a normal page is not navigated away', async () => {
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end('<title>t</title><iframe src="about:blank"></iframe><h1>hi</h1>'); });
  await new Promise((r) => srv.listen(9311, '127.0.0.1', r));
  const h = await cdp.launchChrome({ profileId: 'gh-unwrap-test', port: 9312, headless: true });
  try {
    const page = await cdp.attachPage({ port: h.port });
    const r = await page.navigate('http://127.0.0.1:9311/job?gh_jid=42');
    assert.match(r.url, /127\.0\.0\.1:9311\/job/);
    assert.equal(r.unwrappedFrom, undefined);
    page.close();
  } finally { await cdp.killChrome(h); await new Promise((r) => srv.close(r)); }
});
