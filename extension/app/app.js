// JAT v10 dashboard SPA — front-end only skeleton.
// Two views: Dashboard (#/) and Applications (#/applications, optionally
// #/applications/<id> for a single detail). No data layer; everything is
// static empty-state markup for now. Functional wiring lands feature-by-feature.

// ---------- Runtime detection ----------
const RUNTIME = (() => {
  const isExt = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  const isElectron = !isExt && /electron/i.test(navigator.userAgent || '');
  return {
    isExt, isElectron,
    label: isExt ? 'Extension' : isElectron ? 'Desktop' : 'Web',
  };
})();

// ---------- Tiny utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Router ----------
const routes = [];
function route(pattern, render) { routes.push({ pattern, render }); }

function resolve(path) {
  for (const r of routes) {
    if (typeof r.pattern === 'string' && r.pattern === path) return { render: r.render, params: {} };
    if (r.pattern instanceof RegExp) {
      const m = path.match(r.pattern);
      if (m) return { render: r.render, params: m.groups || {} };
    }
  }
  return null;
}

function navigate() {
  const path = (location.hash.replace(/^#/, '') || '/').replace(/\/+$/, '') || '/';
  const match = resolve(path) || resolve('/');
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === path || (path === '/' && el.dataset.route === '/'));
  });
  const main = $('#main');
  main.innerHTML = '';
  main.appendChild(match.render(match.params));
}
window.addEventListener('hashchange', navigate);

// ---------- View: Dashboard ----------
route('/', () => h(`
  <div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">Overview</div>
        <h1 class="page-title">Dashboard</h1>
        <div class="page-sub">A considered record of your job search — every application, every conversation, every offer.</div>
      </div>
      <div>
        <a href="#/applications/new" class="btn primary">+ New application</a>
      </div>
    </header>

    <section class="stats">
      <div class="stat">
        <div class="stat-label">Applications</div>
        <div class="stat-value">—</div>
        <div class="stat-delta">All time</div>
      </div>
      <div class="stat">
        <div class="stat-label">This week</div>
        <div class="stat-value">—</div>
        <div class="stat-delta">Last 7 days</div>
      </div>
      <div class="stat">
        <div class="stat-label">In progress</div>
        <div class="stat-value">—</div>
        <div class="stat-delta">Interviews + offers pending</div>
      </div>
      <div class="stat">
        <div class="stat-label">Offers</div>
        <div class="stat-value gold">—</div>
        <div class="stat-delta">All time</div>
      </div>
    </section>

    <section class="section">
      <header class="section-header">
        <div>
          <div class="section-eyebrow">Status</div>
          <h2 class="section-title">Pipeline</h2>
        </div>
        <a href="#/applications" class="section-link">View all</a>
      </header>
      <div class="pipeline">
        <div class="pill" data-status="applied"><span class="dot"></span>Applied<span class="count">0</span></div>
        <div class="pill" data-status="screen"><span class="dot"></span>Screen<span class="count">0</span></div>
        <div class="pill" data-status="interview"><span class="dot"></span>Interview<span class="count">0</span></div>
        <div class="pill" data-status="offer"><span class="dot"></span>Offer<span class="count">0</span></div>
        <div class="pill" data-status="rejected"><span class="dot"></span>Rejected<span class="count">0</span></div>
        <div class="pill" data-status="archived"><span class="dot"></span>Archived<span class="count">0</span></div>
      </div>
    </section>

    <section class="section">
      <header class="section-header">
        <div>
          <div class="section-eyebrow">Recent</div>
          <h2 class="section-title">Latest applications</h2>
        </div>
        <a href="#/applications" class="section-link">All applications</a>
      </header>
      <div class="section-body">
        <div class="empty">
          <div class="empty-mark"></div>
          <div class="empty-eyebrow">Quiet ledger</div>
          <div class="empty-title">No applications yet</div>
          <div class="empty-sub">Apply to a job on LinkedIn and JAT will capture it here automatically. Or add one by hand.</div>
        </div>
      </div>
    </section>
  </div>
`));

// ---------- View: Applications list ----------
route('/applications', () => {
  const wrap = h(`
    <div>
      <header class="page-header">
        <div>
          <div class="page-eyebrow">Ledger</div>
          <h1 class="page-title">Applications</h1>
          <div class="page-sub">Every job you've applied to, in one place.</div>
        </div>
        <div>
          <button class="btn primary" id="btn-new">+ New application</button>
        </div>
      </header>

      <div class="toolbar">
        <input class="input" placeholder="Search title, company, location…" />
        <select class="select">
          <option>All statuses</option>
          <option>Applied</option>
          <option>Screen</option>
          <option>Interview</option>
          <option>Offer</option>
          <option>Rejected</option>
          <option>Archived</option>
        </select>
        <select class="select">
          <option>Any source</option>
          <option>LinkedIn</option>
          <option>Indeed</option>
          <option>Greenhouse</option>
          <option>Lever</option>
          <option>Other</option>
        </select>
      </div>

      <section class="section">
        <table class="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Company</th>
              <th>Status</th>
              <th>Source</th>
              <th>Applied</th>
              <th>Last update</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colspan="6">
                <div class="empty">
                  <div class="empty-mark"></div>
                  <div class="empty-eyebrow">No entries</div>
                  <div class="empty-title">The ledger is empty</div>
                  <div class="empty-sub">Hit Easy Apply on a LinkedIn job — JAT will record it here. Or click <strong>+ New application</strong> to add one by hand.</div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  `);
  wrap.querySelector('#btn-new').addEventListener('click', () => {
    location.hash = '#/applications/new';
  });
  return wrap;
});

// ---------- View: Application detail (also used for "new") ----------
route(/^\/applications\/(?<id>.+)$/, ({ id }) => {
  const isNew = id === 'new';
  const wrap = h(`
    <div>
      <header class="page-header">
        <div>
          <a href="#/applications" class="back-link">← All applications</a>
          <h1 class="page-title" style="margin-top:10px">${isNew ? 'New application' : esc(id)}</h1>
          <div class="page-sub">${isNew ? 'Capture the essentials. The timeline grows as you advance.' : 'View and edit this application.'}</div>
        </div>
        <div style="display:flex; gap:10px">
          <button class="btn" id="btn-cancel">${isNew ? 'Cancel' : 'Archive'}</button>
          <button class="btn primary">${isNew ? 'Save application' : 'Save changes'}</button>
        </div>
      </header>

      <div class="app-detail">
        <div>
          <section class="section">
            <header class="section-header">
              <div>
                <div class="section-eyebrow">Job</div>
                <h2 class="section-title">Posting</h2>
              </div>
            </header>
            <dl class="kv">
              <dt>Title</dt>      <dd><input class="input" placeholder="Senior Frontend Engineer" /></dd>
              <dt>Company</dt>    <dd><input class="input" placeholder="Acme Corp" /></dd>
              <dt>Location</dt>   <dd><input class="input" placeholder="Remote · Toronto, ON" /></dd>
              <dt>Comp</dt>       <dd><input class="input" placeholder="$120k–$160k CAD" /></dd>
              <dt>Source</dt>
              <dd>
                <select class="select">
                  <option>LinkedIn</option><option>Indeed</option><option>Greenhouse</option><option>Lever</option><option>Other</option>
                </select>
              </dd>
              <dt>Job URL</dt>    <dd><input class="input" placeholder="https://www.linkedin.com/jobs/view/…" /></dd>
            </dl>
          </section>

          <section class="section">
            <header class="section-header">
              <div>
                <div class="section-eyebrow">Marginalia</div>
                <h2 class="section-title">Notes</h2>
              </div>
            </header>
            <div style="padding: 20px 24px">
              <textarea class="input" rows="6" style="width:100%; resize:vertical" placeholder="Anything worth remembering — recruiter contact, salary signals, follow-up reminders…"></textarea>
            </div>
          </section>
        </div>

        <div>
          <section class="section">
            <header class="section-header">
              <div>
                <div class="section-eyebrow">Standing</div>
                <h2 class="section-title">Status</h2>
              </div>
            </header>
            <dl class="kv">
              <dt>Status</dt>
              <dd>
                <select class="select">
                  <option>Applied</option><option>Screen</option><option>Interview</option><option>Offer</option><option>Rejected</option><option>Archived</option>
                </select>
              </dd>
              <dt>Applied</dt>     <dd><input class="input" type="date" /></dd>
              <dt>Next action</dt> <dd><input class="input" placeholder="Follow up via email" /></dd>
              <dt>Due</dt>         <dd><input class="input" type="date" /></dd>
            </dl>
          </section>

          <section class="section">
            <header class="section-header">
              <div>
                <div class="section-eyebrow">Record</div>
                <h2 class="section-title">Timeline</h2>
              </div>
            </header>
            <div class="timeline">
              <div class="empty" style="padding: 36px 24px">
                <div class="empty-sub">${isNew ? 'Save the application to start a timeline.' : 'No events yet.'}</div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  `);
  wrap.querySelector('#btn-cancel').addEventListener('click', () => { location.hash = '#/applications'; });
  return wrap;
});

// ---------- Footer status ----------
function paintRuntime() {
  const dot = $('#runtime-dot');
  const txt = $('#runtime-text');
  const vEl = $('#brand-version');
  let version = '';
  try { if (RUNTIME.isExt) version = chrome.runtime.getManifest().version; } catch {}
  vEl.textContent = version ? `v${version}` : 'v10';
  dot.classList.add('ok');
  txt.textContent = RUNTIME.label;
}

// ---------- Boot ----------
paintRuntime();
if (!location.hash) location.hash = '#/';
navigate();
