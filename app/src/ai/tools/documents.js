'use strict';
// ============================================================================
//  JAT v11 — document tools (AI Apply chunk 6)
//
//  Writing the two documents that actually go to an employer: a résumé tailored to one posting,
//  and a cover letter. Both pass through the voice check, and the check is a GATE — a document
//  that fails is not written to disk at all, so a failing draft can never be attached by a later
//  step that forgets to look.
//
//  THE RÉSUMÉ IS A BODY, NOT A WHOLE FILE
//  Pierre's résumé styling lives in the <head> of portfolio-site/resume/resume-2026.html and is
//  shared by every application. The agent writes only the <body>; the head is prepended here. That
//  is exactly the pipeline used by hand overnight, and it means the agent cannot accidentally
//  redesign the résumé while tailoring it.
//
//  ONE FOLDER PER APPLICATION, mirroring what already exists on disk:
//      Desktop/important/resume/2026/applications/<slug>/
//          body.html          what the agent wrote
//          render.html        head + body, the file Chrome prints
//          <Name>.pdf         the artefact that gets attached
//          cover-letter.txt
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { voiceCheck, report } = require('../voice-check');
const cdp = require('../../browser/cdp');

let log = { info() {}, warn() {}, error() {} };
try { log = require('../../logger').scope('ai:tools:documents'); } catch { /* usable outside the app */ }

const RESUME_TEMPLATE = 'F:/GITHUB/Perosnal/portfolio-site/resume/resume-2026.html';
const APPLICATIONS_ROOT = path.join(os.homedir(), 'Desktop', 'important', 'resume', '2026', 'applications');

const slugify = (s) => String(s || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'application';

// The <head> of the shared résumé, up to and including <html>/<head> but stopping before <body>.
function resumeHead(templatePath = RESUME_TEMPLATE) {
  const raw = fs.readFileSync(templatePath, 'utf8');
  const i = raw.search(/<body\b/i);
  if (i === -1) throw new Error(`no <body> in the résumé template at ${templatePath}`);
  return raw.slice(0, i);
}

function renderPdf(htmlPath, pdfPath, { timeoutMs = 60000 } = {}) {
  const chrome = cdp.findChrome();
  if (!chrome) throw new Error('Chrome not found, so no PDF can be rendered');
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      '--headless', '--disable-gpu', '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`, htmlPath,
    ], { windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('PDF render timed out')); }, timeoutMs);
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      // Chrome exits 0 while writing nothing when the input path is wrong, so trust the FILE.
      let size = 0;
      try { size = fs.statSync(pdfPath).size; } catch { /* stays 0 */ }
      if (size < 1000) return reject(new Error(`PDF was not written (${size} bytes). ${err.trim().slice(0, 200)}`));
      resolve(size);
    });
  });
}

function makeDocumentTools(opts = {}) {
  const {
    root = APPLICATIONS_ROOT,
    template = RESUME_TEMPLATE,
    candidateName = 'PierreSalama',
  } = opts;

  const folderFor = (company) => path.join(root, slugify(company));

  const tools = [
    {
      name: 'voice_check',
      description: 'Check writing against the house rules before using it anywhere. Reports every violation with a fix.',
      args: ['text'],
      run: ({ text }) => report(voiceCheck(String(text == null ? '' : text))),
    },
    {
      name: 'write_resume',
      description: 'Write the tailored résumé for one application. Pass company and bodyHtml: a complete '
        + '<body>...</body> element, not a fragment and not a whole document. Renders a PDF and returns the '
        + 'path you must give attach_file. REFUSED if the writing breaks the house rules.',
      args: ['company', 'bodyHtml'],
      // The gate. A failing document is never written, so nothing downstream can attach a draft
      // that was known to be wrong.
      guard: ({ company, bodyHtml }) => {
        if (!company) return 'refused: which company is this résumé for?';
        if (!bodyHtml || !/<body[\s>]/i.test(String(bodyHtml))) {
          return 'refused: bodyHtml must be a full <body>…</body> block — the <head> is added for you';
        }
        const v = voiceCheck(String(bodyHtml), { html: true });
        return v.ok ? null : `refused, the writing breaks the house rules:\n${report(v)}`;
      },
      run: async ({ company, bodyHtml }) => {
        const dir = folderFor(company);
        fs.mkdirSync(dir, { recursive: true });
        const bodyPath = path.join(dir, 'body.html');
        const renderPath = path.join(dir, 'render.html');
        const pdfPath = path.join(dir, `${candidateName}_${slugify(company).replace(/-/g, '')}.pdf`);

        fs.writeFileSync(bodyPath, String(bodyHtml), 'utf8');
        fs.writeFileSync(renderPath, resumeHead(template) + String(bodyHtml), 'utf8');
        const size = await renderPdf(renderPath, pdfPath);
        log.info(`résumé rendered for ${company}: ${pdfPath} (${size} bytes)`);
        return `résumé written and rendered: ${pdfPath} (${size} bytes). Attach THIS path.`;
      },
    },
    {
      name: 'write_cover_letter',
      description: 'Write the cover letter for one application. REFUSED if the writing breaks the house rules.',
      args: ['company', 'text'],
      guard: ({ company, text }) => {
        if (!company) return 'refused: which company is this letter for?';
        const t = String(text == null ? '' : text).trim();
        if (t.length < 200) return 'refused: that is too short to be a real cover letter';
        const v = voiceCheck(t, { html: false });
        return v.ok ? null : `refused, the writing breaks the house rules:\n${report(v)}`;
      },
      run: ({ company, text }) => {
        const dir = folderFor(company);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'cover-letter.txt');
        fs.writeFileSync(file, String(text), 'utf8');
        return `cover letter written: ${file}. Attach THIS path.`;
      },
    },
    {
      name: 'list_documents',
      description: 'List the documents already prepared for a company.',
      args: ['company'],
      run: ({ company }) => {
        const dir = folderFor(company);
        if (!fs.existsSync(dir)) return `nothing prepared for ${company} yet`;
        const files = fs.readdirSync(dir)
          .map((f) => `${f} (${fs.statSync(path.join(dir, f)).size} bytes)`);
        return files.length ? `${dir}\n  ${files.join('\n  ')}` : `${dir} is empty`;
      },
    },
  ];

  return { tools, folderFor, resumeHead: () => resumeHead(template) };
}

module.exports = { makeDocumentTools, renderPdf, resumeHead, slugify, APPLICATIONS_ROOT, RESUME_TEMPLATE };
