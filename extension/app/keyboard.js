// Global keyboard shortcuts. Wired by app.js after first render.
//
//   ?         show shortcuts overlay
//   Cmd/Ctrl+K  command palette (handled by cmd-palette.js)
//   g d       go dashboard
//   g j       go applications
//   g p       go profile
//   g s       go settings
//   n         new job (focus quick-add or go to jobs)
//   /         focus search input on current page
//   t         cycle theme (next theme in registry)
//   [ / ]     prev / next sidebar page
//   1-9       jump to nth visible sidebar item

import { computeSidebar } from '../lib/pages.js';

export const SHORTCUTS = [
  ['?',          'Show this help'],
  ['Cmd / Ctrl + K', 'Open command palette'],
  ['g then d',   'Go to Dashboard'],
  ['g then j',   'Go to Applications'],
  ['g then p',   'Go to Profile'],
  ['g then s',   'Go to Settings'],
  ['n',          'New job (focus quick-add)'],
  ['/',          'Focus page search'],
  ['t',          'Toggle dark / light theme'],
  ['[  /  ]',    'Previous / next sidebar page'],
  ['1 – 9',      'Jump to nth nav item'],
];

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export function showShortcutsOverlay() {
  document.querySelectorAll('.kbd-overlay').forEach((n) => n.remove());
  const wrap = document.createElement('div');
  wrap.className = 'kbd-overlay';
  wrap.innerHTML = `
    <div class="kbd-back"></div>
    <div class="kbd-card">
      <h3 style="margin:0 0 12px">Keyboard shortcuts</h3>
      <table>
        ${SHORTCUTS.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}
      </table>
      <div style="text-align:right;margin-top:12px"><button class="btn">Close</button></div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.kbd-back').addEventListener('click', close);
  wrap.querySelector('button').addEventListener('click', close);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

export function attachKeyboard({ getState, navigate, toggleTheme, openPalette, openHelp }) {
  let pendingG = false;
  let pendingTimer = null;

  function clearPending() { pendingG = false; if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; } }

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // let modified keys flow elsewhere
    if (isTypingTarget(e.target)) return;

    // ? help
    if (e.key === '?') { e.preventDefault(); (openHelp || showShortcutsOverlay)(); return; }

    // / focus search
    if (e.key === '/') {
      const search = document.querySelector('#sidebar-search, #search, input[type="search"]');
      if (search) { e.preventDefault(); search.focus(); search.select?.(); }
      return;
    }

    // g <letter>
    if (pendingG) {
      const route = ({ d: '/', j: '/jobs', p: '/profile', s: '/settings' })[e.key];
      clearPending();
      if (route) { e.preventDefault(); (navigate || ((r) => location.hash = '#' + r))(route); }
      return;
    }
    if (e.key === 'g') {
      pendingG = true;
      pendingTimer = setTimeout(clearPending, 1200);
      return;
    }

    if (e.key === 'n') {
      e.preventDefault();
      (navigate || ((r) => location.hash = '#' + r))('/jobs');
      return;
    }
    if (e.key === 't') { e.preventDefault(); toggleTheme && toggleTheme(); return; }

    if (e.key === '[' || e.key === ']') {
      const state = getState ? getState() : {};
      const sidebar = computeSidebar(state.settings || {});
      const ids = sidebar.map((p) => p.route);
      const cur = state.route || '/';
      let idx = ids.indexOf(cur);
      if (idx < 0) idx = 0;
      idx = e.key === '[' ? Math.max(0, idx - 1) : Math.min(ids.length - 1, idx + 1);
      e.preventDefault();
      (navigate || ((r) => location.hash = '#' + r))(ids[idx]);
      return;
    }

    if (/^[1-9]$/.test(e.key)) {
      const state = getState ? getState() : {};
      const sidebar = computeSidebar(state.settings || {});
      const target = sidebar[Number(e.key) - 1];
      if (target) { e.preventDefault(); (navigate || ((r) => location.hash = '#' + r))(target.route); }
      return;
    }

    // Cmd/Ctrl+K is handled inside cmd-palette.js — but allow plain k to open as a hint
  });
}

// Extra hooks for v8.5 QoL features. These are additive — call attachExtraKeyboard
// alongside attachKeyboard. Modifier-aware (Cmd/Ctrl) so they don't conflict
// with the bare-letter shortcuts above.
export function attachExtraKeyboard({ openQuickAdd, openRecent, undoLast, openPomodoro }) {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // Cmd/Ctrl+J — recent items quick switcher
    if (mod && (e.key === 'j' || e.key === 'J')) {
      e.preventDefault();
      openRecent && openRecent();
      return;
    }
    // Cmd/Ctrl+Z — undo (only when not focused on an input — let native undo win there)
    if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      undoLast && undoLast();
      return;
    }
    // Cmd/Ctrl+Shift+P — Pomodoro toggle
    if (mod && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      openPomodoro && openPomodoro();
      return;
    }
    // Plain `n` for quick-add (overrides earlier nav-to-jobs)
    if (!mod && !e.altKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      if (isTypingTarget(e.target)) return;
      // Only intercept if a quick-add handler is registered
      if (openQuickAdd) { e.preventDefault(); openQuickAdd(); }
    }
  }, true); // capture phase so we can override the basic 'n' in attachKeyboard
}
