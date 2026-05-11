// Renders the customizable sidebar. Pure DOM in/out — caller passes
// settings + currentRoute and we wire up drag/drop, hide, pin, and the
// "+ Add a page" picker. Drag-reorder and hide/pin/section-move all
// flow through onChange(patchObj) which the caller funnels into
// `send('patch-settings', patch)`.
import { PAGES, SECTIONS, computeSidebar, groupBySection, pageById } from '../lib/pages.js';

export function renderSidebar({ navEl, settings, currentRoute, search = '', onChange, onNavigate }) {
  if (!navEl) return;
  const visible = computeSidebar(settings || {});
  const filterLc = String(search || '').trim().toLowerCase();
  const filtered = filterLc
    ? visible.filter((p) => p.label.toLowerCase().includes(filterLc) || (p.description || '').toLowerCase().includes(filterLc))
    : visible;
  const groups = groupBySection(filtered);
  const pinned = new Set((settings && settings.sidebarPinned) || []);

  const collapsed = new Set((settings && settings.sidebarSectionsCollapsed) || []);
  const sectionLabels = (settings && settings.sidebarSections) || {};
  navEl.innerHTML = groups.map((g) => {
    const lbl = sectionLabels[g.id] || g.label;
    const isCol = collapsed.has(g.id);
    return `
    <div class="nav-group" data-section="${g.id}">
      <div class="nav-group-h ${isCol ? 'collapsed' : ''}" data-section-h="${g.id}"><span>${g.icon}</span><span class="nav-group-label" data-section-id="${g.id}">${escape(lbl)}</span><span class="caret">▾</span></div>
      <div class="nav-group-items">
        ${g.pages.map((p) => navItem(p, currentRoute, pinned)).join('')}
      </div>
    </div>
  `;
  }).join('');

  // Section header collapse + double-click rename
  navEl.querySelectorAll('.nav-group-h').forEach((h) => {
    h.addEventListener('click', (e) => {
      if (e.target.classList && e.target.classList.contains('nav-group-label')) return;
      const id = h.dataset.sectionH;
      const next = new Set(collapsed);
      if (next.has(id)) next.delete(id); else next.add(id);
      onChange && onChange({ sidebarSectionsCollapsed: Array.from(next) });
    });
  });
  navEl.querySelectorAll('.nav-group-label').forEach((lbl) => {
    lbl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const id = lbl.dataset.sectionId;
      const cur = lbl.textContent;
      const next = prompt('Rename section', cur);
      if (next != null && next.trim() && next !== cur) {
        const map = { ...(sectionLabels || {}) };
        map[id] = next.trim();
        onChange && onChange({ sidebarSections: map });
      }
    });
  });

  // Eye icon: hide page
  navEl.querySelectorAll('.nav-eye').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.id;
      const hidden = new Set((settings && settings.sidebarHidden) || []);
      hidden.add(id);
      onChange && onChange({ sidebarHidden: Array.from(hidden) });
    });
  });

  // Right-click context menu on nav items: Pin/Unpin/Hide/Move up/Move down
  navEl.querySelectorAll('a[data-route]').forEach((a) => {
    a.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, a.dataset.id, settings, onChange, visible);
    });
  });

  // Drag and drop
  const items = Array.from(navEl.querySelectorAll('a[data-route]'));
  let dragId = null;
  for (const a of items) {
    a.addEventListener('dragstart', (e) => {
      dragId = a.dataset.id;
      a.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch {}
    });
    a.addEventListener('dragend', () => { a.classList.remove('dragging'); dragId = null; navEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target')); });
    a.addEventListener('dragover', (e) => { e.preventDefault(); a.classList.add('drop-target'); });
    a.addEventListener('dragleave', () => a.classList.remove('drop-target'));
    a.addEventListener('drop', (e) => {
      e.preventDefault();
      a.classList.remove('drop-target');
      const fromId = dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      const toId = a.dataset.id;
      if (!fromId || fromId === toId) return;
      const newOrder = reorderIds(visible.map((p) => p.id), fromId, toId);
      onChange && onChange({ sidebarOrder: newOrder });
    });
  }

  // Click → navigate (a[href="#/..."] handles natively, but ensure cmd-menu doesn't swallow)
  navEl.querySelectorAll('a[data-route]').forEach((a) => {
    a.addEventListener('click', (e) => {
      // Let native hashchange fire; just close any open menus
      navEl.querySelectorAll('.nav-menu').forEach((m) => m.remove());
      if (typeof onNavigate === 'function') onNavigate(a.dataset.route);
    });
  });

  // Per-item ⋮ menu
  navEl.querySelectorAll('.nav-menu-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.id;
      openItemMenu(btn, id, settings, onChange);
    });
  });
}

function navItem(p, currentRoute, pinned) {
  const isActive = currentRoute === p.route || (currentRoute && currentRoute.startsWith(p.route + '/') && p.route !== '/');
  const pinIcon = pinned.has(p.id) ? '📌' : '';
  const newBadge = p.v6New ? '<span class="badge-new">NEW</span>' : '';
  const eyeBtn = p.alwaysShow ? '' : `<button class="nav-eye" data-id="${escape(p.id)}" title="Hide" aria-label="Hide">👁</button>`;
  return `<a href="#${p.route}" data-route="${escape(p.route)}" data-id="${escape(p.id)}" data-tour="page-${escape(p.id)}" draggable="true" class="${isActive ? 'active' : ''}">
    <span class="nav-ic">${p.icon}</span>
    <span class="nav-lbl">${escape(p.label)}</span>
    ${newBadge}
    ${pinIcon ? `<span class="nav-pin">${pinIcon}</span>` : ''}
    ${eyeBtn}
    <button class="nav-menu-btn" data-id="${escape(p.id)}" title="Page options" aria-label="Page options">⋮</button>
  </a>`;
}

function openItemMenu(anchorBtn, id, settings, onChange) {
  // Remove any existing menu
  document.querySelectorAll('.nav-menu').forEach((m) => m.remove());
  const page = pageById(id);
  if (!page) return;
  const pinned = new Set((settings.sidebarPinned) || []);
  const hidden = new Set((settings.sidebarHidden) || []);
  const isPinned = pinned.has(id);
  const isHidden = hidden.has(id);
  const sections = SECTIONS.map((s) => `<button data-act="section" data-section="${s.id}" ${s.id === page.section ? 'disabled' : ''}>${s.icon} ${escape(s.label)}</button>`).join('');
  const menu = document.createElement('div');
  menu.className = 'nav-menu';
  menu.innerHTML = `
    <button data-act="pin">${isPinned ? 'Unpin' : '📌 Pin to top'}</button>
    ${page.alwaysShow ? '' : `<button data-act="hide">${isHidden ? '👁 Unhide' : '🚫 Hide'}</button>`}
    <div class="nav-menu-h">Move to section</div>
    ${sections}
  `;
  document.body.appendChild(menu);
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.min(window.innerWidth - 220, r.right + 4)}px`;
  menu.style.top = `${r.top}px`;
  const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); };
  const onDoc = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'pin') {
      const next = new Set(pinned);
      if (isPinned) next.delete(id); else next.add(id);
      onChange && onChange({ sidebarPinned: Array.from(next) });
    } else if (act === 'hide') {
      const next = new Set(hidden);
      if (isHidden) next.delete(id); else next.add(id);
      onChange && onChange({ sidebarHidden: Array.from(next) });
    } else if (act === 'section') {
      // Move to a different section by overriding settings.sectionOverrides
      const overrides = { ...(settings.sectionOverrides || {}) };
      overrides[id] = b.dataset.section;
      onChange && onChange({ sectionOverrides: overrides });
    }
    close();
  }));
}

export function renderHiddenPicker(settings) {
  const hidden = new Set((settings && settings.sidebarHidden) || []);
  const items = PAGES.filter((p) => hidden.has(p.id) || (!computeSidebar(settings).find((cp) => cp.id === p.id) && !p.alwaysShow));
  // Always also show every page that's not currently visible
  const visibleIds = new Set(computeSidebar(settings).map((p) => p.id));
  const all = PAGES.filter((p) => !visibleIds.has(p.id));
  return all.length === 0
    ? '<div style="padding:12px;color:var(--muted)">All pages are visible.</div>'
    : all.map((p) => `<button class="picker-row" data-id="${escape(p.id)}"><span>${p.icon}</span><span>${escape(p.label)}</span><small>${escape(p.section)}</small></button>`).join('');
}

function openContextMenu(x, y, id, settings, onChange, visible) {
  document.querySelectorAll('.ctx-menu, .nav-menu').forEach((n) => n.remove());
  const pinned = new Set(settings.sidebarPinned || []);
  const hidden = new Set(settings.sidebarHidden || []);
  const isPinned = pinned.has(id);
  const isHidden = hidden.has(id);
  const ids = visible.map((p) => p.id);
  const idx = ids.indexOf(id);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = Math.min(window.innerWidth - 200, x) + 'px';
  menu.style.top = Math.min(window.innerHeight - 220, y) + 'px';
  menu.innerHTML = `
    <button data-act="open">Open</button>
    <div class="sep"></div>
    <button data-act="pin">${isPinned ? 'Unpin' : 'Pin to top'}</button>
    <button data-act="hide">${isHidden ? 'Unhide' : 'Hide'}</button>
    <div class="sep"></div>
    <button data-act="up" ${idx <= 0 ? 'disabled' : ''}>Move up</button>
    <button data-act="down" ${idx < 0 || idx >= ids.length - 1 ? 'disabled' : ''}>Move down</button>
  `;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); };
  const onDoc = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'open') { location.hash = '#' + (visible[idx]?.route || '/'); }
    else if (act === 'pin') {
      const next = new Set(pinned); if (isPinned) next.delete(id); else next.add(id);
      onChange && onChange({ sidebarPinned: Array.from(next) });
    } else if (act === 'hide') {
      const next = new Set(hidden); if (isHidden) next.delete(id); else next.add(id);
      onChange && onChange({ sidebarHidden: Array.from(next) });
    } else if (act === 'up' || act === 'down') {
      const order = (settings.sidebarOrder && settings.sidebarOrder.length) ? settings.sidebarOrder.slice() : ids.slice();
      const i = order.indexOf(id);
      if (i < 0) return close();
      const j = act === 'up' ? Math.max(0, i - 1) : Math.min(order.length - 1, i + 1);
      [order[i], order[j]] = [order[j], order[i]];
      onChange && onChange({ sidebarOrder: order });
    }
    close();
  }));
}

// Animate the absolute nav-active-indicator to track the active <a>.
export function syncNavActiveIndicator(navEl) {
  if (!navEl) return;
  let ind = navEl.querySelector('.nav-active-indicator');
  if (!ind) { ind = document.createElement('div'); ind.className = 'nav-active-indicator'; navEl.prepend(ind); }
  const active = navEl.querySelector('a.active');
  if (!active) { ind.style.opacity = '0'; return; }
  const navRect = navEl.getBoundingClientRect();
  const r = active.getBoundingClientRect();
  ind.style.opacity = '1';
  ind.style.top = (r.top - navRect.top + navEl.scrollTop) + 'px';
  ind.style.height = r.height + 'px';
}

function reorderIds(order, fromId, toId) {
  const arr = order.filter((id) => id !== fromId);
  const i = arr.indexOf(toId);
  if (i < 0) arr.push(fromId);
  else arr.splice(i, 0, fromId);
  return arr;
}

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

// ---------- Command palette (Cmd/Ctrl+K) ----------
export function attachCommandPalette({ paletteEl, inputEl, listEl, onPick }) {
  if (!paletteEl || !inputEl || !listEl) return;
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
    const ql = String(q || '').trim().toLowerCase();
    results = PAGES
      .map((p) => ({ p, score: scorePage(p, ql) }))
      .filter((r) => r.score > 0 || !ql)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
    listEl.innerHTML = results.map((r, i) => `
      <div class="cmd-row ${i === cursor ? 'sel' : ''}" data-i="${i}">
        <span class="cmd-ic">${r.p.icon}</span>
        <div>
          <div class="cmd-lbl">${escape(r.p.label)}</div>
          <small>${escape(SECTIONS.find((s) => s.id === r.p.section)?.label || '')} · ${escape(r.p.description || '')}</small>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.cmd-row').forEach((row) => {
      row.addEventListener('click', () => { pick(Number(row.dataset.i)); });
    });
  }
  function pick(i) {
    const r = results[i]; if (!r) return;
    close();
    if (typeof onPick === 'function') onPick(r.p);
  }
  inputEl.addEventListener('input', () => { cursor = 0; refresh(inputEl.value); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); }
    else if (e.key === 'ArrowDown') { cursor = Math.min(results.length - 1, cursor + 1); refresh(inputEl.value); e.preventDefault(); }
    else if (e.key === 'ArrowUp')   { cursor = Math.max(0, cursor - 1); refresh(inputEl.value); e.preventDefault(); }
    else if (e.key === 'Enter')     { pick(cursor); }
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

function scorePage(p, q) {
  if (!q) return 1;
  const lbl = p.label.toLowerCase();
  const desc = (p.description || '').toLowerCase();
  if (lbl === q) return 1000;
  if (lbl.startsWith(q)) return 500;
  if (lbl.includes(q)) return 200;
  // Token match
  const toks = q.split(/\s+/).filter(Boolean);
  let s = 0;
  for (const t of toks) { if (lbl.includes(t)) s += 50; if (desc.includes(t)) s += 5; }
  return s;
}
