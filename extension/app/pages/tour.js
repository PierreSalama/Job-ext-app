// Tour landing page. Lists chapters with progress, exposes Start / Resume /
// Restart buttons. Reads/writes settings.tourCompleted, settings.tourLastStep.
import { buildDefaultTour } from '../../lib/tour-steps.js';
import { PAGES } from '../../lib/pages.js';

const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _steps = null;
function getSteps() {
  if (!_steps) _steps = buildDefaultTour();
  return _steps;
}

function chaptersFromSteps(steps) {
  // Group steps by pageRoute to form "chapters"
  const map = new Map();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const key = s.pageRoute || '/';
    if (!map.has(key)) map.set(key, { route: key, indices: [] });
    map.get(key).indices.push(i);
  }
  return Array.from(map.values()).map((c) => {
    const page = PAGES.find((p) => p.route === c.route);
    return {
      ...c,
      label: page ? `${page.icon} ${page.label}` : (c.route === '/' ? '🏠 Home' : c.route),
      description: page?.description || ''
    };
  });
}

export function render(state) {
  const steps = getSteps();
  const chapters = chaptersFromSteps(steps);
  const last = state.settings?.tourLastStep || 0;
  const done = !!state.settings?.tourCompleted;
  const progressPct = Math.round((Math.min(last, steps.length) / steps.length) * 100);

  return `
    <div class="page-h">
      <div><h1>🎓 Take the tour</h1><div class="sub">Interactive walkthrough of every page in Job Tracker. ${steps.length} steps, ~5 min.</div></div>
      <div style="display:flex;gap:8px">
        ${last > 0 && !done ? `<button class="btn primary" id="tour-resume">Resume (step ${last + 1} / ${steps.length})</button>` : ''}
        <button class="btn ${last === 0 && !done ? 'primary' : ''}" id="tour-start">${last === 0 && !done ? 'Start tour' : 'Restart'}</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong>Progress</strong>
        <span style="color:var(--muted);font-size:12px">${progressPct}% · ${done ? 'Completed' : `${last} of ${steps.length} steps`}</span>
      </div>
      <div style="height:8px;background:rgba(99,102,241,0.12);border-radius:99px;overflow:hidden">
        <div style="height:100%;width:${progressPct}%;background:linear-gradient(90deg,var(--primary),var(--primary2));transition:width 0.3s"></div>
      </div>
      ${done ? `<div style="margin-top:10px;color:var(--success);font-size:12px">✓ You finished the tour. Restart any time.</div>` : ''}
    </div>
    <div class="card">
      <h3 style="margin-top:0;font-size:14px">Chapters</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-top:8px">
        ${chapters.map((c) => {
          const reached = Math.max(...c.indices) < last || done;
          const inProgress = c.indices.includes(last);
          return `
            <div class="card" style="padding:12px;background:${reached ? 'rgba(16,185,129,0.06)' : inProgress ? 'rgba(99,102,241,0.08)' : 'transparent'};border-color:${reached ? 'var(--success)' : inProgress ? 'var(--primary)' : 'var(--border)'}">
              <strong style="font-size:13px">${escape(c.label)}</strong>
              <div style="font-size:11px;color:var(--muted);margin-top:4px">${escape(c.description)}</div>
              <div style="margin-top:8px;font-size:11px;color:var(--muted)">${c.indices.length} step${c.indices.length === 1 ? '' : 's'} ${reached ? '· ✓' : inProgress ? '· in progress' : ''}</div>
              <button class="btn small" style="margin-top:8px" data-chapter-jump="${c.indices[0]}">Jump here</button>
            </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

export function attach($main, state) {
  const startTour = async (startAt = 0) => {
    const mod = await import('../../lib/tour.js');
    const steps = getSteps();
    const tour = new mod.Tour({
      steps,
      startAt,
      reducedMotion: !!state.settings?.reducedMotion,
      onAdvance: (i) => { send('patch-settings', { tourLastStep: i }); },
      onFinish: () => { send('patch-settings', { tourCompleted: true, tourLastStep: 0 }); },
      onExit: () => {}
    });
    tour.start();
  };

  document.getElementById('tour-start')?.addEventListener('click', () => {
    send('patch-settings', { tourLastStep: 0, tourCompleted: false }).then(() => startTour(0));
  });
  document.getElementById('tour-resume')?.addEventListener('click', () => startTour(state.settings?.tourLastStep || 0));
  // Alias for spotlight selector
  const restart = document.getElementById('tour-restart');
  if (restart) restart.addEventListener('click', () => startTour(0));

  document.querySelectorAll('[data-chapter-jump]').forEach((b) => b.addEventListener('click', () => {
    const idx = parseInt(b.dataset.chapterJump, 10) || 0;
    startTour(idx);
  }));
}
