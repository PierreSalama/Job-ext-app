// Cmd+K command palette. Fuzzy searches: pages, jobs, contacts, and a small
// set of named commands (theme picker, AI, navigation). Pure DOM, no deps.
import { PAGES, SECTIONS } from '../lib/pages.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fuzzyScore(text, q) {
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500;
  if (t.includes(q)) return 250;
  // Subsequence match
  let i = 0, j = 0, hits = 0;
  while (i < t.length && j < q.length) {
    if (t[i] === q[j]) { hits++; j++; }
    i++;
  }
  if (j === q.length) return 50 + hits;
  return 0;
}

function buildItems(state, commands) {
  const items = [];
  // Pages
  for (const p of PAGES) {
    items.push({
      kind: 'page', icon: p.icon, label: p.label,
      sub: (SECTIONS.find((s) => s.id === p.section)?.label || '') + (p.description ? ' · ' + p.description : ''),
      route: p.route
    });
  }
  // Jobs
  for (const j of (state.jobs || [])) {
    items.push({
      kind: 'job', icon: '📋',
      label: (j.title || 'Untitled') + (j.company ? ' · ' + j.company : ''),
      sub: 'Application · ' + (j.status || ''),
      route: '/job/' + j.id
    });
  }
  // Contacts
  for (const c of (state.contacts || [])) {
    items.push({
      kind: 'contact', icon: '👤',
      label: c.name || c.email || 'Contact',
      sub: 'Contact · ' + (c.company || c.role || ''),
      route: '/contacts'
    });
  }
  // Commands
  for (const cmd of commands) {
    items.push({ kind: 'command', icon: cmd.icon || '⚡', label: cmd.label, sub: cmd.sub || 'Command', run: cmd.run });
  }
  return items;
}

export function attachCommandPalette({ paletteEl, inputEl, listEl, getState, getCommands, onPickRoute }) {
  if (!paletteEl || !inputEl || !listEl) return null;
  let cursor = 0;
  let results = [];

  function open() {
    paletteEl.hidden = false;
    inputEl.value = '';
    cursor = 0;
    refresh('');
    inputEl.focus();
  }
  function close() { paletteEl.hidden = true; }

  function refresh(q) {
    const state = getState ? getState() : { jobs: [], contacts: [] };
    const commands = getCommands ? getCommands() : [];
    const items = buildItems(state, commands);
    const ql = String(q || '').trim().toLowerCase();
    results = items
      .map((it) => ({ it, score: fuzzyScore(it.label, ql) + 0.3 * fuzzyScore(it.sub || '', ql) }))
      .filter((r) => r.score > 0 || !ql)
      .sort((a, b) => b.score - a.score)
      .slice(0, 80);
    listEl.innerHTML = results.map((r, i) => `
      <div class="cmd-row ${i === cursor ? 'sel' : ''}" data-i="${i}">
        <span class="cmd-ic">${r.it.icon}</span>
        <div>
          <div class="cmd-lbl">${esc(r.it.label)}</div>
          <small>${esc(r.it.sub || '')}</small>
        </div>
      </div>
    `).join('') || '<div class="empty" style="padding:18px">No matches.</div>';
    listEl.querySelectorAll('.cmd-row').forEach((row) => {
      row.addEventListener('click', () => { pick(Number(row.dataset.i)); });
    });
  }

  function pick(i) {
    const r = results[i]; if (!r) return;
    close();
    if (r.it.kind === 'command' && typeof r.it.run === 'function') {
      try { r.it.run(); } catch (e) { console.error('cmd failed', e); }
    } else if (r.it.route) {
      if (typeof onPickRoute === 'function') onPickRoute(r.it.route);
      else location.hash = '#' + r.it.route;
    }
  }

  inputEl.addEventListener('input', () => { cursor = 0; refresh(inputEl.value); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); }
    else if (e.key === 'ArrowDown') { cursor = Math.min(results.length - 1, cursor + 1); refresh(inputEl.value); e.preventDefault(); }
    else if (e.key === 'ArrowUp')   { cursor = Math.max(0, cursor - 1); refresh(inputEl.value); e.preventDefault(); }
    else if (e.key === 'Enter')     { pick(cursor); e.preventDefault(); }
  });
  paletteEl.querySelector('.cmd-backdrop')?.addEventListener('click', close);

  document.addEventListener('keydown', (e) => {
    const isK = (e.key === 'k' || e.key === 'K');
    if (isK && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (paletteEl.hidden) open(); else close();
    } else if (e.key === 'Escape' && !paletteEl.hidden) {
      close();
    }
  });

  return { open, close };
}
