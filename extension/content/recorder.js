// JAT v11 — Full-fidelity Recorder  [Teach & Correct T2]
//
// As the user applies BY HAND on any site, capture each real interaction at full
// fidelity (CSS selector + XPath + attribute signature + label + outerHTML snippet +
// value + inter-step timing) and POST it to the app as a `demonstration`, so the
// Distiller can later enrich recipes with real selectors instead of label-only guesses.
//
// Two triggers, one code path:
//   • ALWAYS-ON passive capture whenever apply-form capture is happening, and
//   • a deliberate TEACH MODE (chrome.storage.local['jat11.teachMode']) that adds a
//     form-crop screenshot per meaningful step + an on-page "captured ✓ <label>" toast.
//
// PRIVACY RAIL (unchanged): credential/payment fields never have their value or html
// captured. The app's recordDemonstration enforces this server-side via SENSITIVE_RX
// (the authoritative rail); the recorder ALSO nulls obvious password/cc/cvv values
// locally so they never even leave the page.
//
// buildLocator() is kept PURE — no chrome / network / window-at-import — so it imports
// cleanly under `node --test` and can be unit-tested with jsdom-style/duck-typed
// elements. Everything that touches chrome/DOM lifecycle lives below it and is only
// reached from the browser controller (start()).

// ------------------------------------------------------------------ pure helpers

// CSS.escape isn't guaranteed in a node/jsdom element, and buildLocator must stay
// pure → use a tiny local escaper (good enough for ids/classes we emit).
function cssEscape(s) {
  return String(s == null ? '' : s).replace(/([^\w-])/g, '\\$1');
}

// Stable-ish classes only: drop hashed/utility/state churn (md5-ish, has--/is--/active,
// long random Emotion/CSS-module suffixes) so the selector survives a re-render.
function stableClasses(el) {
  let raw = '';
  try { raw = (el.getAttribute && el.getAttribute('class')) || el.className || ''; } catch { raw = ''; }
  if (raw && typeof raw === 'object' && raw.baseVal != null) raw = raw.baseVal;  // SVGAnimatedString
  return String(raw).split(/\s+/).filter(Boolean).filter((c) => {
    if (c.length > 30) return false;                       // hashed/module name
    if (/^(is-|has-|active|open|focus|hover|selected|disabled|error|invalid|valid)/i.test(c)) return false; // state
    if (/(^|[-_])(css|sc|emotion)-/i.test(c)) return false; // styled-components / emotion
    if (/[a-f0-9]{6,}/i.test(c) && !/[a-z]{4,}/i.test(c)) return false; // pure hash chunk
    return true;
  }).slice(0, 2);
}

function tagOf(el) {
  try { return String(el.tagName || el.nodeName || 'div').toLowerCase(); } catch { return 'div'; }
}

function attrGet(el, name) {
  try { const v = el.getAttribute && el.getAttribute(name); return v == null ? '' : String(v); } catch { return ''; }
}

// nth-of-type index (1-based) among same-tag siblings — for selector + xpath stability.
function nthOfType(el) {
  try {
    const parent = el.parentNode;
    if (!parent || !parent.children) return 1;
    const tag = tagOf(el);
    let n = 0;
    for (const sib of parent.children) {
      if (tagOf(sib) === tag) { n++; if (sib === el) return n; }
    }
  } catch {}
  return 1;
}

// Build a bounded, robust CSS selector:
//   • prefer #id (escaped) when present + plausibly unique,
//   • else tag + up to 2 stable classes + :nth-of-type, walked up a few ancestors
//     until we hit an id anchor or a depth cap. Bounded length (≤ ~240 chars).
function cssSelector(el) {
  try {
    if (!el || el.nodeType !== 1) return '';
    const id = attrGet(el, 'id');
    if (id && !/\s/.test(id)) return '#' + cssEscape(id);

    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      const nid = attrGet(node, 'id');
      if (nid && !/\s/.test(nid)) { parts.unshift('#' + cssEscape(nid)); break; }
      let seg = tagOf(node);
      const cls = stableClasses(node);
      if (cls.length) seg += '.' + cls.map(cssEscape).join('.');
      seg += `:nth-of-type(${nthOfType(node)})`;
      parts.unshift(seg);
      node = node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null;
      depth++;
    }
    let sel = parts.join(' > ');
    if (sel.length > 240) sel = sel.slice(0, 240);
    return sel;
  } catch { return ''; }
}

// Build an XPath:
//   • id-anchored (//*[@id="…"]/…) when the element or an ancestor has an id,
//   • else an absolute-ish path from the root with [index] at each step.
function xPath(el) {
  try {
    if (!el || el.nodeType !== 1) return '';
    const myId = attrGet(el, 'id');
    if (myId && !/["\]]/.test(myId)) return `//*[@id="${myId}"]`;

    const segs = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const nid = attrGet(node, 'id');
      if (nid && !/["\]]/.test(nid) && node !== el) {
        // Anchor at the nearest id-bearing ancestor: //*[@id="x"]/child[i]/…
        return `//*[@id="${nid}"]/${segs.join('/')}`;
      }
      segs.unshift(`${tagOf(node)}[${nthOfType(node)}]`);
      node = node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null;
    }
    return '/' + segs.join('/');
  } catch { return ''; }
}

// Attribute signature: a JSON-able object of the identifying attributes, trimmed.
// Includes every data-* attribute (ATS hooks like data-automation-id live here).
function attrSignature(el) {
  const out = {};
  try {
    const pick = (k, alias) => { const v = attrGet(el, k); if (v) out[alias || k] = v.slice(0, 200); };
    pick('id'); pick('name'); pick('class'); pick('aria-label'); pick('role'); pick('type'); pick('placeholder');
    if (el.attributes) {
      for (const a of el.attributes) {
        if (a && a.name && a.name.indexOf('data-') === 0 && a.value) out[a.name] = String(a.value).slice(0, 200);
      }
    }
  } catch {}
  return out;
}

// outerHTML, trimmed to ≤2KB so a giant node can't bloat storage.
function trimmedHtml(el) {
  try {
    const h = el.outerHTML;
    return typeof h === 'string' ? h.slice(0, 2048) : '';
  } catch { return ''; }
}

// buildLocator(el) → { selector, xpath, attrs, label, html }   (PURE)
//
// labelFn is injectable so this stays browser-global-free; the browser controller
// passes fieldLabel / a radio-group label, tests pass a duck-typed function or rely
// on the element's getAttribute('aria-label') fallback.
export function buildLocator(el, labelFn) {
  if (!el) return { selector: '', xpath: '', attrs: {}, label: '', html: '' };
  let label = '';
  try {
    if (typeof labelFn === 'function') label = String(labelFn(el) || '');
    if (!label) label = attrGet(el, 'aria-label') || attrGet(el, 'name') || attrGet(el, 'placeholder') || '';
  } catch { label = ''; }
  return {
    selector: cssSelector(el),
    xpath: xPath(el),
    attrs: attrSignature(el),
    label: label.slice(0, 300),
    html: trimmedHtml(el),
  };
}

// Local-only sensitive guard (defense-in-depth; the app's SENSITIVE_RX is authoritative).
// Catches obvious password / credit-card / cvv fields by type/name/label so their value
// is dropped before it ever leaves the page.
const LOCAL_SENSITIVE_RX = /(pass(word|code|phrase)|\bpwd\b|credit.?card|card.?number|cardnum|\bcvv\b|\bcvc2?\b|security.?code|\bcvc\b|\bpin\b|\bssn\b|social.?security|\biban\b|routing.?number|bank.?account|\bcredential\b)/i;
function isLocallySensitive(el, label) {
  try {
    if (el && el.type === 'password') return true;
    const hay = `${label || ''} ${attrGet(el, 'name')} ${attrGet(el, 'id')} ${attrGet(el, 'autocomplete')} ${attrGet(el, 'placeholder')}`;
    return LOCAL_SENSITIVE_RX.test(hay);
  } catch { return false; }
}

// inferAction(el, eventType) → click | fill | select | advance   (PURE)
export function inferAction(el, eventType, isAdvance) {
  if (isAdvance) return 'advance';
  const tag = tagOf(el);
  if (eventType === 'change' || eventType === 'input') {
    if (tag === 'select') return 'select';
    const t = (attrGet(el, 'type') || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return 'click';
    return 'fill';
  }
  return 'click';
}

// =====================================================================
// Browser controller — only reached from start() inside an apply context.
// Everything below may touch chrome/DOM; nothing here runs at import time.
// =====================================================================

let _started = false;
let _sessionId = null;
let _stepIndex = 0;
let _lastTs = 0;
let _teach = false;
let _preapproved = false;
let _applyRoot = null;
let _mods = null;        // { fieldLabel, isSiteChromeInput, isFillable, radioGroupLabel, detectApplyForm }

function genSession() {
  try { return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  catch { return 'sess-' + Date.now(); }
}

async function loadDeps() {
  if (_mods) return _mods;
  const af = await import(chrome.runtime.getURL('content/autofill.js'));
  const forms = await import(chrome.runtime.getURL('content/signals/forms.js'));
  _mods = {
    fieldLabel: af.fieldLabel,
    isSiteChromeInput: af.isSiteChromeInput,
    isFillable: af.isFillable,
    radioGroupLabel: af.radioGroupLabel,
    detectApplyForm: forms.detectApplyForm,
  };
  return _mods;
}

function labelForEl(el) {
  try {
    const t = (el.type || '').toLowerCase();
    if (t === 'radio' && _mods?.radioGroupLabel) {
      const g = _mods.radioGroupLabel(el);
      if (g) return g;
    }
    return _mods?.fieldLabel ? _mods.fieldLabel(el) : '';
  } catch { return ''; }
}

// Is this element inside the live apply form (and NOT site chrome)?
function inApplyScope(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    if (_mods?.isSiteChromeInput && _mods.isSiteChromeInput(el)) return false;
    if (_applyRoot && _applyRoot.contains && _applyRoot.contains(el)) return true;
    // advance/submit buttons may live just outside the form root (modal footer) →
    // allow buttons/role=button anywhere that are NOT site chrome.
    return false;
  } catch { return false; }
}

const ADVANCE_RX = /\b(next|continue|review|submit|finish|apply|envoyer|suivant|continuer|soumettre)\b/i;
function isAdvanceButton(el) {
  try {
    const tag = tagOf(el);
    const role = (attrGet(el, 'role') || '').toLowerCase();
    if (tag !== 'button' && role !== 'button' && !(tag === 'input' && /submit|button/i.test(attrGet(el, 'type')))) return false;
    if (_mods?.isSiteChromeInput && _mods.isSiteChromeInput(el)) return false;
    const txt = `${el.textContent || ''} ${attrGet(el, 'aria-label')} ${attrGet(el, 'value')}`;
    return ADVANCE_RX.test(txt);
  } catch { return false; }
}

function readValue(el) {
  try {
    const t = (el.type || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return el.checked ? (el.value || 'on') : '';
    if (el.value != null) return String(el.value);
    return '';
  } catch { return ''; }
}

// Post one demonstration step to the app via the background api-call proxy.
function postStep(fields) {
  try {
    chrome.runtime.sendMessage(
      { type: 'api-call', method: 'POST', path: '/observe', body: { kind: 'step', url: location.href, ...fields } },
      () => { void chrome.runtime.lastError; },
    );
  } catch { /* never throw into the page */ }
}

// Capture one interaction → build the locator bundle, rail-guard the value, time it,
// post it. Best-effort screenshot in Teach Mode. NEVER throws into the page.
function capture(el, eventType, opts = {}) {
  try {
    const advance = !!opts.advance;
    if (!advance && !inApplyScope(el)) return;
    const label = labelForEl(el);
    const bundle = buildLocator(el, labelForEl);
    const sensitive = isLocallySensitive(el, label || bundle.label);
    const action = inferAction(el, eventType, advance);
    const ftype = (el.type || tagOf(el) || '').toLowerCase();

    const nowMs = Date.now();
    const delayMs = _lastTs ? Math.max(0, nowMs - _lastTs) : 0;
    _lastTs = nowMs;

    const step = {
      sessionId: _sessionId,
      stepIndex: _stepIndex++,
      action,
      label: bundle.label,
      fieldType: ftype,
      selector: bundle.selector,
      xpath: bundle.xpath,
      attrs: bundle.attrs,
      html: sensitive ? null : bundle.html,
      value: sensitive ? null : (action === 'click' || action === 'advance' ? null : readValue(el)),
      delayMs,
      source: _teach ? 'teach' : 'manual',
    };
    postStep(step);

    if (_teach) {
      affirm(bundle.label || action);
      if (action !== 'click' || advance) maybeScreenshot(step);
    }
  } catch { /* swallow — recorder must never break the page */ }
}

// Teach-Mode screenshot: send the apply-form bounding rect to background, which does
// captureVisibleTab + the app crops + saves. Best-effort; any failure → step already
// recorded without a screenshot, so we simply drop it.
function maybeScreenshot(step) {
  try {
    if (!_applyRoot || !_applyRoot.getBoundingClientRect) return;
    const r = _applyRoot.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const rect = {
      x: Math.max(0, Math.round(r.left * dpr)),
      y: Math.max(0, Math.round(r.top * dpr)),
      w: Math.max(1, Math.round(r.width * dpr)),
      h: Math.max(1, Math.round(r.height * dpr)),
    };
    chrome.runtime.sendMessage(
      { type: 'teach-screenshot', rect, demo: { sessionId: step.sessionId, stepIndex: step.stepIndex, label: step.label } },
      () => { void chrome.runtime.lastError; },
    );
  } catch { /* best-effort only */ }
}

// On-page "captured ✓ <label>" affirmation toast (Teach Mode only).
let _toastEl = null;
let _toastTimer = null;
function affirm(text) {
  try {
    if (!_toastEl) {
      // Idempotent across double-injection: adopt an existing toast node if present.
      const existing = document.querySelector('[data-jat11-toast="1"]');
      if (existing) { _toastEl = existing; }
    }
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.setAttribute('data-jat11-toast', '1');
      Object.assign(_toastEl.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
        background: '#111827', color: '#fff', font: '13px/1.4 system-ui, sans-serif',
        padding: '8px 12px', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.3)',
        maxWidth: '320px', pointerEvents: 'none', opacity: '0', transition: 'opacity .15s',
      });
      (document.body || document.documentElement).appendChild(_toastEl);
    }
    _toastEl.textContent = `captured ✓ ${String(text || '').slice(0, 60)}`;
    _toastEl.style.opacity = '1';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { if (_toastEl) _toastEl.style.opacity = '0'; }, 1400);
  } catch {}
}

// Per-field debounce so a long type fires ONE 'fill' step (on blur/change), not per key.
const _debounce = new Map();
function scheduleFieldCapture(el) {
  try {
    const prev = _debounce.get(el);
    if (prev) clearTimeout(prev);
    _debounce.set(el, setTimeout(() => { _debounce.delete(el); capture(el, 'change'); }, 600));
  } catch {}
}

// ---- event handlers (capture phase) ----
function onClick(e) {
  const el = e.target;
  if (!el) return;
  if (isAdvanceButton(el)) { capture(el, 'click', { advance: true }); return; }
  // a real button/control click inside the apply form (e.g. toggle, custom dropdown)
  if (inApplyScope(el)) {
    const tag = tagOf(el);
    const t = (el.type || '').toLowerCase();
    if (tag === 'button' || t === 'checkbox' || t === 'radio' || (attrGet(el, 'role') || '').toLowerCase() === 'button') {
      capture(el, 'click');
    }
  }
}
function onChange(e) {
  const el = e.target;
  if (!el || !inApplyScope(el)) return;
  // flush any pending debounce + record immediately on commit
  const prev = _debounce.get(el);
  if (prev) { clearTimeout(prev); _debounce.delete(el); }
  capture(el, 'change');
}
function onInput(e) {
  const el = e.target;
  if (!el || !inApplyScope(el)) return;
  const tag = tagOf(el);
  if (tag === 'input' || tag === 'textarea') scheduleFieldCapture(el);
}

// start(opts) — boot the recorder inside a detected apply context. Idempotent.
// Called by the engine when an apply form is detected (always-on when capture/harvest
// is enabled). Re-reads Teach Mode from storage and listens in capture phase.
export async function start(opts = {}) {
  try {
    if (_started) { if (opts.preapproved) _preapproved = true; await refreshTeach(); return true; }
    await loadDeps();
    const found = _mods.detectApplyForm && _mods.detectApplyForm();
    _applyRoot = (found && found.form) || opts.root || null;
    if (!_applyRoot) return false;           // not in an apply context → do nothing
    _preapproved = !!opts.preapproved;
    _started = true;
    _sessionId = genSession();
    _stepIndex = 0;
    _lastTs = Date.now();
    await refreshTeach();
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes['jat11.teachMode']) _teach = _preapproved || !!changes['jat11.teachMode'].newValue;
      });
    } catch {}
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('input', onInput, true);
    injectToggle();
    return true;
  } catch { return false; }
}

async function refreshTeach() {
  try { _teach = _preapproved || !!(await chrome.storage.local.get('jat11.teachMode'))['jat11.teachMode']; }
  catch { _teach = !!_preapproved; }
}

// An always-available floating Teach-Mode toggle. Mirrors the popup toggle: writes
// chrome.storage.local['jat11.teachMode']. Visible on any plausible job page when Teach
// Mode is ON (so the user gets feedback it's armed) — not only inside a detected apply
// form. Idempotent across the whole document (a duplicate/second extension injection must
// not create a second pill).
let _toggleEl = null;
function injectToggle() {
  try {
    if (_toggleEl) return;
    // Idempotency across double-injection (a second copy of the extension, or two
    // boots): if a toggle already lives in the DOM, adopt it instead of adding another.
    const existing = document.querySelector('[data-jat11-teach-toggle="1"]');
    if (existing) { _toggleEl = existing; return; }
    _toggleEl = document.createElement('button');
    _toggleEl.setAttribute('data-jat11-teach-toggle', '1');
    _toggleEl.type = 'button';
    Object.assign(_toggleEl.style, {
      position: 'fixed', right: '16px', bottom: '56px', zIndex: '2147483647',
      font: '12px/1 system-ui, sans-serif', padding: '7px 12px', borderRadius: '999px',
      border: '1px solid rgba(255,255,255,.25)', cursor: 'pointer', color: '#fff',
      boxShadow: '0 2px 10px rgba(0,0,0,.35)', opacity: '0.85',
    });
    const paint = () => {
      _toggleEl.textContent = _teach ? '● Teaching' : '○ Teach';
      _toggleEl.style.background = _teach ? '#059669' : '#374151';
    };
    paint();
    _toggleEl.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      try {
        const next = !_teach;
        await chrome.storage.local.set({ 'jat11.teachMode': next });
        _teach = next; paint();
      } catch {}
    }, true);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes['jat11.teachMode']) { _teach = !!changes['jat11.teachMode'].newValue; paint(); }
      });
    } catch {}
    (document.body || document.documentElement).appendChild(_toggleEl);
  } catch {}
}

export function isTeachMode() { return _teach; }

// Show the floating Teach toggle WITHOUT requiring a detected apply form. Called by the
// engine on any plausible job page when Teach Mode is ON, so the user gets visible
// feedback that Teach Mode is armed even before an apply form mounts. Capture itself
// stays scoped to apply-form interactions (start() does that) — this only relaxes the
// VISIBILITY of the toggle. Idempotent + top-frame only. Best-effort; never throws.
export async function ensureToggle() {
  try {
    if (window !== window.top) return false;       // one pill, top frame only
    await refreshTeach();                           // reflect current Teach Mode from storage
    if (!_teach) return false;                      // only surface the pill when armed
    injectToggle();
    return true;
  } catch { return false; }
}
