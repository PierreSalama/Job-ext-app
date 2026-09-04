'use strict';
// ============================================================================
//  JAT v11 — browser tools (AI Apply chunk 4)
//
//  The verbs the agent uses to see and drive a real page, wired to the chunk-1 CDP harness. This
//  is the exact set the overnight hand-apply run used through a browser extension, minus the
//  extension.
//
//  WHY A FACTORY
//  Each run owns ONE browser on ONE profile and ONE debug port, so Pierre's Chrome and Dad's can
//  run side by side. Tools therefore close over a session rather than reaching for a module-level
//  singleton, which would silently make two concurrent runs share a window.
//
//  LAZY LAUNCH
//  Chrome starts on the first tool that actually needs it. A run that ends up not browsing (parked
//  on a missing answer, say) never pays for a browser it did not use.
//
//  EVERY RESULT IS A SHORT STRING
//  The model re-reads the transcript on every turn, so a verbose observation is paid for over and
//  over. Results are trimmed hard here rather than in the loop, where the useful detail is already
//  gone.
//
//  ON GUARDS
//  Chunk 8 builds the full guardrail layer. Two guards live here anyway because they are intrinsic
//  to their tool: `fill` must never type into a password field, and `attach_file` must never reach
//  outside the folders that hold Pierre's documents. Shipping a tool belt that can type a password
//  and then pointing it at a real login page is not a thing to defer.
// ============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const cdp = require('../../browser/cdp');

let log = { info() {}, warn() {}, error() {} };
try { log = require('../../logger').scope('ai:tools:browser'); } catch { /* usable outside the app */ }

const MAX_RESULT = 1800;      // characters of observation a single tool may return
const MAX_TREE_NODES = 60;    // rows of the accessibility tree per read

const clip = (s, n = MAX_RESULT) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n)}\n…(${t.length - n} more characters)` : t;
};

// Only ever navigate to the web. file:// would let a posting's text talk the agent into reading
// the local disk, which is a data-exfiltration path, not a browsing feature.
function assertWebUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(`not a URL: ${url}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`refused: only http and https are allowed, got ${u.protocol}`);
  }
  return u.toString();
}

// Files the agent may attach. Anything else is refused by path, not by trust.
//
// ONE SOURCE OF TRUTH with the document tools. The agent writes a résumé and then attaches it, so
// wherever documents are written MUST be uploadable — otherwise the run gets all the way to the
// file input and is refused for a file it just created itself. Seen on the third end-to-end run.
// Deriving it here means changing the documents root can never silently break uploads.
let extraUploadRoots = [];
function allowUploadRoot(dir) {
  if (dir) extraUploadRoots = [...new Set([...extraUploadRoots, path.resolve(String(dir)).toLowerCase()])];
}
function allowedUploadRoots() {
  const home = os.homedir();
  let docsRoot = null;
  try { docsRoot = require('./documents').APPLICATIONS_ROOT; } catch { /* module optional */ }
  return [
    docsRoot,
    path.join(home, 'Desktop', 'important', 'resume'),
    path.join(home, 'Documents'),
    path.join(os.tmpdir(), 'jat-ai-apply'),
  ].filter(Boolean).map((p) => path.resolve(p).toLowerCase()).concat(extraUploadRoots);
}
// What is actually sitting in the folder the agent aimed at, and failing that, in every folder it is
// allowed to upload from. Only ever names real files, so it cannot invite another invented path.
function nearbyFiles(abs) {
  const seen = new Set();
  const list = (dir, depth = 0) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen.size >= 12) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2) list(full, depth + 1); }
      else seen.add(full);
    }
  };
  list(path.dirname(abs));
  if (!seen.size) for (const root of allowedUploadRoots()) list(root);
  if (!seen.size) return 'Nothing has been written yet. Use write_resume first.';
  return `These files DO exist, use one of them exactly: ${[...seen].join(' | ')}`;
}

function uploadRefusal(file) {
  let abs;
  try { abs = path.resolve(String(file)); } catch { return 'that is not a usable path'; }
  // A bare "no such file" is a dead end, and on a real run the agent answered it by giving up and
  // then inventing a story about the tools being broken. It had guessed `resume.pdf` instead of
  // calling list_documents. Telling it what IS on disk turns the refusal into a way forward.
  if (!fs.existsSync(abs)) return `no such file: ${abs}. ${nearbyFiles(abs)}`;
  const low = abs.toLowerCase();
  if (!allowedUploadRoots().some((root) => low === root || low.startsWith(root + path.sep))) {
    return `refused: ${abs} is outside the folders this agent may upload from`;
  }
  return null;
}

function renderTree(nodes) {
  const shown = nodes.slice(0, MAX_TREE_NODES);
  const lines = shown.map((n) => {
    const ref = n.ref ? n.ref.padEnd(8) : '        ';
    const val = n.value ? `  = ${String(n.value).slice(0, 40)}` : '';
    return `${ref}${n.role.padEnd(12)} ${String(n.name).slice(0, 60)}${val}`;
  });
  if (nodes.length > shown.length) lines.push(`…(${nodes.length - shown.length} more nodes — narrow with find)`);
  return lines.join('\n') || '(no readable nodes)';
}

// ---------------------------------------------------------------------------
function makeBrowserTools(opts = {}) {
  const {
    profileId = 'default',
    port = 9222,
    headless = false,
    shotDir = path.join(os.tmpdir(), 'jat-ai-apply', 'shots'),
  } = opts;

  let handle = null;
  let page = null;
  let shots = 0;
  // The last page actually opened. The guardrail layer needs it to answer "are we on an ATS that
  // will wall us?" before a document is written, and asking the browser for it would be async
  // inside a synchronous policy check.
  let lastUrl = '';

  async function ensure() {
    if (page) return page;
    handle = await cdp.launchChrome({ profileId, port, headless });
    page = await cdp.attachPage({ port });
    log.info(`browser ready for ${profileId} on ${port}`);
    return page;
  }

  async function close() {
    try { if (page) page.close(); } catch { /* closing anyway */ }
    page = null;
    try { await cdp.killChrome(handle); } catch { /* already gone */ }
    handle = null;
  }

  const tools = [
    {
      name: 'navigate',
      description: 'Open a web page. Always read_page afterwards, because refs from a previous page are dead.',
      args: ['url'],
      run: async ({ url }) => {
        const target = assertWebUrl(url);
        const p = await ensure();
        const r = await p.navigate(target);
        lastUrl = r.url || target;
        return `opened ${r.url}`;
      },
    },
    {
      name: 'read_page',
      description: 'Read the page structure and get a ref for each element. Pass interactive:true for only the controls.',
      args: ['interactive'],
      run: async ({ interactive } = {}) => {
        const p = await ensure();
        const nodes = await p.readTree({ interactiveOnly: interactive === true || interactive === 'true' });
        return clip(renderTree(nodes));
      },
    },
    {
      name: 'find',
      description: 'Search the LAST read_page for elements whose label contains this text. Cheaper than re-reading.',
      args: ['query'],
      run: async ({ query }) => {
        const p = await ensure();
        const hits = p.find(query);
        if (!hits.length) return `no match for "${query}" — read_page again, the label may differ`;
        return clip(renderTree(hits));
      },
    },
    {
      name: 'query_ref',
      description: 'Get a ref by CSS selector, for elements the page hides from the tree (file inputs usually are).',
      args: ['selector'],
      run: async ({ selector }) => {
        const p = await ensure();
        const ref = await p.queryRef(String(selector));
        return ref ? `${ref} matches ${selector}` : `nothing matches ${selector}`;
      },
    },
    {
      name: 'click',
      description: 'Click the element with this ref.',
      args: ['ref'],
      run: async ({ ref }) => {
        const p = await ensure();
        await p.click(String(ref));
        return `clicked ${ref}`;
      },
    },
    {
      name: 'fill',
      description: 'Type text into a text field. Always blurs afterwards so the page commits the value. For a dropdown use choose_option instead.',
      args: ['ref', 'text'],
      // Intrinsic guard, not a chunk-8 policy: this tool must never be able to type a credential.
      // It asks the DOM what the element actually IS (the a11y tree calls a password box a plain
      // textbox, so the tree cannot answer this). A ref we cannot identify is refused rather than
      // assumed safe — the failure mode of guessing wrong here is typing a password into a page.
      guard: async ({ ref }) => {
        if (!page || !ref) return null;                 // nothing opened yet; run() will ensure()
        try {
          return (await page.isPasswordRef(String(ref)))
            ? 'refused: that is a password field — the agent never types credentials, ask the human'
            : null;
        } catch (e) {
          return `refused: could not identify ${ref} (${e.message}) — re-read the page`;
        }
      },
      run: async ({ ref, text }) => {
        const p = await ensure();
        // A <select> silently swallows typed text. Say so rather than reporting a fill that did
        // nothing: every real Greenhouse form has several dropdowns and the fixture had none.
        if (await p.isSelectRef(ref)) {
          const opts = await p.listOptions(ref);
          return `that is a dropdown, not a text field. Use choose_option with one of: `
            + `${(opts || []).slice(0, 25).join(' | ')}`;
        }
        if (await p.isPasswordRef(String(ref))) {
          throw new Error('refused: that is a password field — the agent never types credentials');
        }
        await p.fill(String(ref), String(text == null ? '' : text));
        return `filled ${ref} and blurred it`;
      },
    },
    {
      name: 'choose_option',
      description: 'Pick a value in a dropdown. Matches the option text or value, exactly first and '
        + 'then loosely. If nothing matches it tells you every option there is, so ask for one of those.',
      args: ['ref', 'value'],
      guard: ({ value }) => (String(value || '').trim() ? null : 'refused: choose WHICH option'),
      run: async ({ ref, value }) => {
        const p = await ensure();
        const r = await p.selectOption(ref, value);
        if (r && r.notASelect) return 'that is not a dropdown. Use fill for a text field.';
        if (!r || !r.ok) {
          return `no option matches "${value}". The choices are: ${(r && r.options || []).join(' | ')}`;
        }
        return `chose "${r.chose}"`;
      },
    },
    {
      name: 'press_key',
      description: 'Press Tab, Enter, Escape or Backspace.',
      args: ['key'],
      run: async ({ key }) => {
        const p = await ensure();
        await p.pressKey(String(key));
        return `pressed ${key}`;
      },
    },
    {
      name: 'attach_file',
      // On a real run the model invented `resume.pdf` and was refused. Name the source of truth.
      description: 'Attach a file to a file input. Two things first: query_ref to get the ref for that input '
        + '(file inputs are usually hidden), and the EXACT path returned by write_resume or list_documents. '
        + 'Never type a filename you have not been given.',
      args: ['ref', 'file'],
      guard: ({ file }) => uploadRefusal(file),
      run: async ({ ref, file }) => {
        const p = await ensure();
        const set = await p.setFiles(String(ref), String(file));
        return `attached ${path.basename(set[0])}`;
      },
    },
    {
      name: 'page_text',
      description: 'Read the visible text of the page. Use it to check what a form said back to you.',
      args: [],
      run: async () => {
        const p = await ensure();
        return clip(await p.text({ max: MAX_RESULT * 2 }));
      },
    },
    {
      name: 'screenshot',
      description: 'Save a picture of the page. Use it to prove what happened, or when the text is unclear.',
      args: [],
      run: async () => {
        const p = await ensure();
        fs.mkdirSync(shotDir, { recursive: true });
        const file = path.join(shotDir, `${profileId}-${Date.now()}-${++shots}.jpg`);
        const r = await p.screenshot({ savePath: file });
        return `saved ${file} (${r.bytes} bytes)`;
      },
    },
  ];

  return {
    tools,
    close,
    isOpen: () => !!page,
    page: () => page,
    lastUrl: () => lastUrl,
    _ensure: ensure,
  };
}

module.exports = {
  makeBrowserTools, assertWebUrl, uploadRefusal, allowedUploadRoots, allowUploadRoot,
  renderTree, clip,
};
