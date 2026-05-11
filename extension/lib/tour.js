// Interactive tour engine. Renders a dimmed backdrop, a glowing spotlight
// over the current step's target element, and a tooltip card with title,
// body, and Prev / Next / Skip buttons. The engine navigates the app via
// `location.hash = step.pageRoute` before each step.
//
// Usage:
//   import { Tour } from './lib/tour.js';
//   import { buildDefaultTour } from './lib/tour-steps.js';
//   const tour = new Tour({
//     steps: buildDefaultTour(),
//     startAt: settings.tourLastStep || 0,
//     reducedMotion: settings.reducedMotion,
//     onAdvance: (i) => send('patch-settings', { tourLastStep: i }),
//     onFinish: () => send('patch-settings', { tourCompleted: true, tourLastStep: 0 }),
//   });
//   tour.start();
//
// The tour is intentionally stateless on disk — the parent wires onAdvance/
// onFinish to persist `settings.tourLastStep` and `settings.tourCompleted`.

const STYLE_ID = 'jat-tour-style';
const ROOT_ID = 'jat-tour-root';

const CSS = `
#${ROOT_ID} { position: fixed; inset: 0; z-index: 99999; pointer-events: none; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
#${ROOT_ID} .jt-backdrop { position: absolute; inset: 0; background: rgba(2,6,23,0.55); pointer-events: auto; transition: opacity 220ms ease; opacity: 0; }
#${ROOT_ID}.ready .jt-backdrop { opacity: 1; }
#${ROOT_ID} .jt-spot { position: absolute; border-radius: 12px; box-shadow: 0 0 0 9999px rgba(2,6,23,0.55), 0 0 0 3px rgba(99,102,241,0.85), 0 0 32px 6px rgba(139,92,246,0.55); transition: top 320ms cubic-bezier(.4,.0,.2,1), left 320ms cubic-bezier(.4,.0,.2,1), width 320ms cubic-bezier(.4,.0,.2,1), height 320ms cubic-bezier(.4,.0,.2,1); pointer-events: none; }
#${ROOT_ID} .jt-spot.pulse { animation: jt-pulse 2.2s ease-in-out infinite; }
@keyframes jt-pulse {
  0%, 100% { box-shadow: 0 0 0 9999px rgba(2,6,23,0.55), 0 0 0 3px rgba(99,102,241,0.85), 0 0 32px 6px rgba(139,92,246,0.55); }
  50%      { box-shadow: 0 0 0 9999px rgba(2,6,23,0.55), 0 0 0 4px rgba(139,92,246,0.95), 0 0 48px 12px rgba(99,102,241,0.65); }
}
#${ROOT_ID} .jt-tip { position: absolute; max-width: 340px; min-width: 260px; background: #1e293b; color: #f8fafc; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px 18px; box-shadow: 0 22px 50px rgba(0,0,0,0.55); pointer-events: auto; transform: translateY(8px); opacity: 0; transition: transform 240ms cubic-bezier(.4,.0,.2,1), opacity 240ms ease, top 320ms cubic-bezier(.4,.0,.2,1), left 320ms cubic-bezier(.4,.0,.2,1); }
#${ROOT_ID}.ready .jt-tip { transform: translateY(0); opacity: 1; }
#${ROOT_ID} .jt-tip h3 { margin: 0 0 6px; font-size: 15px; font-weight: 700; }
#${ROOT_ID} .jt-tip p { margin: 0 0 12px; font-size: 13px; line-height: 1.45; color: #cbd5e1; white-space: pre-wrap; }
#${ROOT_ID} .jt-progress { font-size: 11px; color: #94a3b8; margin-bottom: 8px; letter-spacing: 0.04em; text-transform: uppercase; }
#${ROOT_ID} .jt-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
#${ROOT_ID} .jt-actions .skip { margin-right: auto; background: transparent; color: #94a3b8; border: 0; cursor: pointer; font-size: 12px; padding: 6px 8px; }
#${ROOT_ID} .jt-actions .skip:hover { color: #f8fafc; }
#${ROOT_ID} .jt-btn { background: rgba(99,102,241,0.18); color: #c7d2fe; border: 0; border-radius: 8px; padding: 7px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
#${ROOT_ID} .jt-btn.primary { background: #6366f1; color: #fff; }
#${ROOT_ID} .jt-btn:disabled { opacity: 0.4; cursor: not-allowed; }
#${ROOT_ID} .jt-arrow { position: absolute; width: 12px; height: 12px; background: #1e293b; border: 1px solid rgba(255,255,255,0.1); transform: rotate(45deg); }
#${ROOT_ID}.reduced .jt-spot, #${ROOT_ID}.reduced .jt-tip { transition: none !important; animation: none !important; }
#${ROOT_ID} .jt-confetti { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
#${ROOT_ID} .jt-confetti span { position: absolute; top: -20px; width: 10px; height: 14px; opacity: 0.95; animation: jt-fall 2.6s linear forwards; }
@keyframes jt-fall { to { transform: translateY(110vh) rotate(720deg); opacity: 0; } }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export class Tour {
  constructor({ steps, startAt = 0, reducedMotion = false, onAdvance, onFinish, onExit, navigateDelayMs = 280 } = {}) {
    this.steps = Array.isArray(steps) ? steps : [];
    this.index = Math.max(0, Math.min(startAt, Math.max(0, this.steps.length - 1)));
    this.reducedMotion = !!reducedMotion;
    this.onAdvance = onAdvance || (() => {});
    this.onFinish = onFinish || (() => {});
    this.onExit = onExit || (() => {});
    // After hash navigation we wait briefly for the host app to re-render
    // before reading the target element rect. Reduced motion → shorter wait.
    this.navigateDelayMs = reducedMotion ? 60 : navigateDelayMs;
    this._root = null;
    this._onResize = () => this._reposition();
    this._onKey = (e) => this._handleKey(e);
  }

  start() {
    if (this.steps.length === 0) return;
    ensureStyle();
    if (!this._root) {
      this._root = document.createElement('div');
      this._root.id = ROOT_ID;
      this._root.innerHTML = `
        <div class="jt-backdrop"></div>
        <div class="jt-spot"></div>
        <div class="jt-tip" role="dialog" aria-live="polite">
          <div class="jt-progress"></div>
          <h3 class="jt-title"></h3>
          <p class="jt-body"></p>
          <div class="jt-actions">
            <button class="skip">Skip tour</button>
            <button class="jt-btn jt-prev">Prev</button>
            <button class="jt-btn primary jt-next">Next</button>
          </div>
        </div>`;
      document.body.appendChild(this._root);
      if (this.reducedMotion) this._root.classList.add('reduced');
      // Backdrop click closes only when on the welcome step (avoids accidental dismissal)
      this._root.querySelector('.jt-backdrop').addEventListener('click', () => { /* swallow */ });
      this._root.querySelector('.skip').addEventListener('click', () => this.exit());
      this._root.querySelector('.jt-prev').addEventListener('click', () => this.prev());
      this._root.querySelector('.jt-next').addEventListener('click', () => this.next());
      window.addEventListener('resize', this._onResize);
      window.addEventListener('scroll', this._onResize, true);
      window.addEventListener('keydown', this._onKey);
    }
    this._showCurrent();
  }

  _handleKey(e) {
    if (!this._root) return;
    if (e.key === 'Escape') { e.preventDefault(); this.exit(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); this.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.prev(); }
  }

  next() {
    if (this.index >= this.steps.length - 1) return this._finish();
    this.index += 1;
    try { this.onAdvance(this.index); } catch {}
    this._showCurrent();
  }

  prev() {
    if (this.index <= 0) return;
    this.index -= 1;
    try { this.onAdvance(this.index); } catch {}
    this._showCurrent();
  }

  exit() {
    this._teardown();
    try { this.onExit(); } catch {}
  }

  async _finish() {
    this._celebrate();
    try { this.onFinish(); } catch {}
    setTimeout(() => this._teardown(), 2400);
  }

  _teardown() {
    if (this._root) {
      this._root.remove();
      this._root = null;
    }
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onResize, true);
    window.removeEventListener('keydown', this._onKey);
  }

  async _showCurrent() {
    const step = this.steps[this.index];
    if (!step) return this._finish();
    // Navigate first so the target is in the DOM by the time we measure.
    const wantHash = step.pageRoute ? (step.pageRoute === '/' ? '#/' : ('#' + step.pageRoute)) : null;
    if (wantHash) {
      // Normalize current hash so we don't loop on equivalent values.
      const cur = location.hash || '#/';
      if (cur !== wantHash) {
        location.hash = wantHash;
      }
    }
    // Wait for the host app to re-render after the hash change.
    await new Promise((r) => setTimeout(r, this.navigateDelayMs));
    // Try to find the target selector — poll briefly so steps that need a
    // module to finish rendering get a chance.
    if (step.selector) {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        if (document.querySelector(step.selector)) break;
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    this._render(step);
  }

  _render(step) {
    if (!this._root) return;
    const tip = this._root.querySelector('.jt-tip');
    const spot = this._root.querySelector('.jt-spot');
    this._root.querySelector('.jt-title').textContent = step.title || '';
    this._root.querySelector('.jt-body').textContent = step.body || '';
    this._root.querySelector('.jt-progress').textContent = `Step ${this.index + 1} of ${this.steps.length}`;
    this._root.querySelector('.jt-prev').disabled = this.index === 0;
    const nextBtn = this._root.querySelector('.jt-next');
    nextBtn.textContent = this.index === this.steps.length - 1 ? 'Finish' : 'Next';
    spot.classList.toggle('pulse', !this.reducedMotion);

    // Mark ready so the backdrop and tip fade in (only first time)
    requestAnimationFrame(() => this._root && this._root.classList.add('ready'));
    this._currentStep = step;
    this._reposition();
  }

  _reposition() {
    if (!this._root || !this._currentStep) return;
    const step = this._currentStep;
    const spot = this._root.querySelector('.jt-spot');
    const tip = this._root.querySelector('.jt-tip');
    const target = step.selector ? document.querySelector(step.selector) : null;
    let rect;
    if (target) {
      rect = target.getBoundingClientRect();
      // If element is offscreen, scroll it into view first
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        try { target.scrollIntoView({ behavior: this.reducedMotion ? 'auto' : 'smooth', block: 'center' }); } catch {}
        rect = target.getBoundingClientRect();
      }
    }
    if (!target || !rect) {
      // No target on this page — keep the spotlight hidden but anchor the
      // tooltip to a reliable location (center). Prev/Next still work, so
      // the tour can't get stuck.
      spot.style.opacity = '0';
      const tipW = 340, tipH = 180;
      tip.style.left = Math.max(8, Math.round(window.innerWidth / 2 - tipW / 2)) + 'px';
      tip.style.top = Math.max(8, Math.round(window.innerHeight / 2 - tipH / 2)) + 'px';
      return;
    }
    spot.style.opacity = '1';
    const pad = 8;
    const x = Math.max(4, rect.left - pad);
    const y = Math.max(4, rect.top - pad);
    const w = rect.width + pad * 2;
    const h = rect.height + pad * 2;
    spot.style.left = x + 'px';
    spot.style.top = y + 'px';
    spot.style.width = w + 'px';
    spot.style.height = h + 'px';

    // Place tooltip
    const tipW = 340;
    const tipH = 180;
    const pos = step.position || 'right';
    let tx, ty;
    if (pos === 'right') { tx = x + w + 14; ty = y; }
    else if (pos === 'left') { tx = x - tipW - 14; ty = y; }
    else if (pos === 'top') { tx = x; ty = y - tipH - 14; }
    else /* bottom */ { tx = x; ty = y + h + 14; }
    // Clamp into viewport
    tx = Math.max(8, Math.min(tx, window.innerWidth - tipW - 8));
    ty = Math.max(8, Math.min(ty, window.innerHeight - tipH - 8));
    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
  }

  _celebrate() {
    if (!this._root) return;
    if (this.reducedMotion) return;
    const c = document.createElement('div');
    c.className = 'jt-confetti';
    const colors = ['#6366f1', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#22d3ee', '#ec4899'];
    for (let i = 0; i < 80; i++) {
      const s = document.createElement('span');
      s.style.left = (Math.random() * 100) + '%';
      s.style.background = colors[i % colors.length];
      s.style.animationDelay = (Math.random() * 0.6) + 's';
      s.style.transform = `rotate(${Math.random() * 360}deg)`;
      c.appendChild(s);
    }
    this._root.appendChild(c);
  }
}
