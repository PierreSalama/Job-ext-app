// JAT v11 — DOM utilities that pierce shadow roots (Workday et al.).
// All scans in signals/* go through these instead of bare querySelectorAll.

const MAX_NODES = 12000;
// qsa caps results and host-scanning SEPARATELY: capping host enumeration at
// the result limit (the old bug) made deep shadow roots on big pages invisible
// once enough plain elements were seen. Now we scan many more hosts (so Workday
// shadow trees are reached) but stop early once we have enough matches.
const QSA_MAX_RESULTS = 6000;
const QSA_MAX_HOSTS = 30000;

// Iterate every element in document order, descending into open shadow roots.
export function* allElements(root = document) {
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const node = stack.pop();
    const kids = node.children || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    if (node.shadowRoot) stack.push(node.shadowRoot);
    if (node.nodeType === 1) {
      if (++seen > MAX_NODES) return;
      yield node;
    }
  }
}

// querySelectorAll across shadow boundaries. Returns an array.
export function qsa(selector, root = document) {
  const out = [];
  try { out.push(...root.querySelectorAll(selector)); } catch { return out; }
  if (out.length >= QSA_MAX_RESULTS) return out.slice(0, QSA_MAX_RESULTS);
  let hosts;
  try { hosts = root.querySelectorAll('*'); } catch { return out; }
  let seen = 0;
  for (const el of hosts) {
    if (out.length >= QSA_MAX_RESULTS) break;
    if (++seen > QSA_MAX_HOSTS) break;
    if (el.shadowRoot) {
      for (const m of qsa(selector, el.shadowRoot)) {
        out.push(m);
        if (out.length >= QSA_MAX_RESULTS) break;
      }
    }
  }
  return out;
}

export function qs(selector, root = document) {
  return qsa(selector, root)[0] || null;
}

// The real click target even through shadow DOM retargeting.
export function eventTarget(ev) {
  try {
    const path = ev.composedPath?.();
    if (path && path.length) return path[0];
  } catch {}
  return ev.target;
}

export function closestThroughShadow(el, selector) {
  let cur = el;
  while (cur) {
    if (cur.nodeType === 1) {
      const hit = cur.closest?.(selector);
      if (hit) return hit;
    }
    const root = cur.getRootNode?.();
    cur = root && root.host ? root.host : null;
  }
  return null;
}

export function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function isProbablyVisible(el) {
  if (!el || el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
  try {
    const r = el.getBoundingClientRect?.();
    if (r && r.width === 0 && r.height === 0) return false;
  } catch {}
  return true;
}
