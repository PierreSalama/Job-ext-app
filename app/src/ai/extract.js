// JAT v11 — document text extraction (Electron main process).
// Fixes the v9 failure where binary PDFs were decoded as UTF-8 garbage and the
// tailor silently degraded. pdf-parse and mammoth are lazy-required so a
// missing optional dep degrades gracefully instead of crashing startup.

const fs = require('fs');
const path = require('path');
const { scope } = require('../logger');

const log = scope('extract');

async function extractText(filePath, mime = '') {
  const ext = path.extname(filePath).toLowerCase();

  try {
    // Inside the try: a locked PDF (open in Word) or a file deleted between save and
    // read degrades to '' (no extracted text) instead of throwing a 500 on upload.
    const buf = fs.readFileSync(filePath);
    if (ext === '.pdf' || /pdf/.test(mime)) {
      const pdfParse = require('pdf-parse');
      const out = await pdfParse(buf);
      return cleanup(out.text);
    }
    if (ext === '.docx' || /officedocument\.wordprocessingml/.test(mime)) {
      const mammoth = require('mammoth');
      const out = await mammoth.extractRawText({ buffer: buf });
      return cleanup(out.value);
    }
    if (['.txt', '.md', '.rtf'].includes(ext) || /^text\//.test(mime)) {
      return cleanup(buf.toString('utf8'));
    }
  } catch (e) {
    log.warn('extraction failed for', filePath, e.message);
    return '';
  }
  // Unknown binary type — do NOT pretend it's text.
  return '';
}

function cleanup(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { extractText };
