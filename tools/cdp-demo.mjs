// AI Apply chunk 1 — live demo / manual verification.
//
// Launches a headful Chrome on a dedicated profile and drives a REAL application form with the
// harness, taking a screenshot at each step. Nothing is ever submitted.
//
//   node tools/cdp-demo.mjs                 # Cornerstone upload check (the blueprint's open question)
//   node tools/cdp-demo.mjs <url>           # any page: navigate, read the tree, screenshot
//
// Screenshots land in tools/.cdp-demo/ and the paths are printed.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cdp = require(path.join(here, '..', 'app', 'src', 'browser', 'cdp.js'));

const OUT = path.join(here, '.cdp-demo');
fs.mkdirSync(OUT, { recursive: true });

const SEEQUENT = 'https://seequent.csod.com/ux/ats/careersite/1/requisition/4318/application?c=seequent&source=LinkedIn&jobboardid=0';
const RESUME = 'C:/Users/pierr/Desktop/important/resume/2026/applications/seequent/PierreSalama_Seequent_SoftwareDeveloper.pdf';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => process.stdout.write(s + '\n');

const url = process.argv[2] || SEEQUENT;
const isCornerstone = url === SEEQUENT;

const handle = await cdp.launchChrome({ profileId: 'demo', port: 9340, headless: false });
let page;
try {
  page = await cdp.attachPage({ port: 9340 });

  say(`\n[1] navigating -> ${url.slice(0, 90)}`);
  const nav = await page.navigate(url, { waitMs: 30000, settleMs: 2500 });
  say(`    settled at ${nav.url.slice(0, 90)}`);
  let shot = await page.screenshot({ savePath: path.join(OUT, '1-loaded.jpg') });
  say(`    screenshot ${shot.savedTo} (${shot.bytes} bytes)`);

  say('\n[2] reading the accessibility tree');
  const tree = await page.readTree();
  const withRef = tree.filter((n) => n.ref).length;
  say(`    ${tree.length} nodes, ${withRef} actionable`);
  for (const n of tree.filter((x) => x.ref).slice(0, 12)) {
    say(`      ${String(n.ref).padEnd(8)} ${n.role.padEnd(12)} ${n.name.slice(0, 46)}`);
  }

  if (!isCornerstone) {
    say('\n[3] page text (first 400 chars)');
    say('    ' + (await page.text()).slice(0, 400).replace(/\n+/g, ' | '));
  } else {
    say('\n[3] can the a11y tree see the resume file input?');
    const viaTree = page.find('resume').concat(page.find('upload'));
    say(`    find("resume"/"upload") -> ${viaTree.length} hit(s)`);
    const inputs = await page.queryRefAll('input[type=file]');
    say(`    queryRefAll("input[type=file]") -> ${inputs.length} hit(s)  <-- the escape hatch`);

    const ref = await page.queryRef('#resumeFileUpload') || inputs[0];
    if (!ref) { say('    !! no file input on the page at all'); }
    else {
      say(`\n[4] attaching a REAL file via DOM.setFileInputFiles  (ref ${ref})`);
      if (!fs.existsSync(RESUME)) { say(`    !! resume missing at ${RESUME}`); }
      else {
        await page.setFiles(ref, RESUME);
        say('    set. waiting 8s for the site to react...');
        await sleep(8000);

        const state = await page.evaluate(`(() => {
          const el = document.getElementById('resumeFileUpload')
                  || document.querySelector('input[type=file]');
          const body = document.body.innerText || '';
          return JSON.stringify({
            files: el && el.files ? [...el.files].map(f => f.name + ':' + f.size) : [],
            error: /error occurred while uploading/i.test(body),
            named: /PierreSalama/i.test(body)
          });
        })()`);
        const s = JSON.parse(state);
        shot = await page.screenshot({ savePath: path.join(OUT, '2-after-upload.jpg') });

        say('\n===== CORNERSTONE UPLOAD VERDICT =====');
        say(`  input holds        : ${s.files.length ? s.files.join(', ') : '(nothing)'}`);
        say(`  filename on page   : ${s.named ? 'YES' : 'no'}`);
        say(`  error banner shown : ${s.error ? 'YES  -> still blocked' : 'no   -> CLEARED'}`);
        say(`  verdict            : ${s.error ? 'CDP did NOT beat Cornerstone' : (s.named || s.files.length ? 'CDP BEAT the extension block' : 'inconclusive, inspect the screenshot')}`);
        say(`  screenshot         : ${shot.savedTo}`);
        say('======================================');
      }
    }
  }

  say('\nleaving the window open for 12s so you can look at it...');
  await sleep(12000);
} catch (e) {
  say(`\n!! ${e.stack || e.message}`);
  try { if (page) await page.screenshot({ savePath: path.join(OUT, 'error.jpg') }); } catch { /* nothing */ }
  process.exitCode = 1;
} finally {
  try { page && page.close(); } catch { /* closing */ }
  await cdp.killChrome(handle);
  say('chrome closed.');
}
