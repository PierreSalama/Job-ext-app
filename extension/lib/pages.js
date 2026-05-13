// Central page registry. Every sidebar page is defined here once and the
// app uses this to render the sidebar, route, and (when implemented) to
// drive the interactive tour.
//
// Each page entry:
//   id          — unique kebab-case route segment (also data-route value)
//   route       — hash route, e.g. '/jobs'  (or '/job/:id' for params)
//   label       — display name in sidebar
//   icon        — emoji used in sidebar + tour
//   section     — group name (e.g., 'Pipeline', 'Network', 'Knowledge', 'Workspace', 'System')
//   description — one-sentence pitch shown in the tour and search palette
//   tourSteps   — [{ selector, text, position }] interactive walkthrough hints
//   v6New       — true for pages added in v8 (used to mark "NEW" badges)
//   alwaysShow  — pages users can't hide (Dashboard, Settings)

export const SECTIONS = [
  { id: 'pipeline',  label: 'Pipeline',  icon: '🎯' },
  { id: 'inbox',     label: 'Inbox',     icon: '📨' },
  { id: 'network',   label: 'Network',   icon: '🌐' },
  { id: 'knowledge', label: 'Knowledge', icon: '📚' },
  { id: 'growth',    label: 'Growth',    icon: '📈' },
  { id: 'workspace', label: 'Workspace', icon: '🛠️' },
  { id: 'system',    label: 'System',    icon: '⚙️' }
];

export const PAGES = [
  // ===== Pipeline =====
  { id: 'dashboard', route: '/',          label: 'Dashboard',     icon: '📊', section: 'pipeline', alwaysShow: true,
    description: 'Daily overview, AI nudges, recent activity, recommended searches.' },
  { id: 'jobs',      route: '/jobs',      label: 'Applications',  icon: '📋', section: 'pipeline',
    description: 'Every application across every source, filterable.' },
  { id: 'pipeline',  route: '/pipeline',  label: 'Pipeline (Kanban)', icon: '🗂️', section: 'pipeline', v6New: true,
    description: 'Kanban view by status with drag-to-update.' },
  { id: 'calendar',  route: '/calendar',  label: 'Calendar',      icon: '📅', section: 'pipeline', v6New: true,
    description: 'Interviews, follow-up dates, deadlines.' },
  { id: 'reminders', route: '/reminders', label: 'Reminders',     icon: '⏰', section: 'pipeline', v6New: true,
    description: 'Time-based nudges and deadline alerts.' },
  { id: 'todos',     route: '/todos',     label: 'To-dos',        icon: '✅', section: 'pipeline', v6New: true,
    description: 'Per-application checklists and free-form todos.' },

  // ===== Inbox / messages =====
  { id: 'inbox',     route: '/inbox',     label: 'Inbox',         icon: '📨', section: 'inbox', v6New: true,
    description: 'Unified messages from LinkedIn, recruiter emails, and Gmail.' },
  { id: 'threads',   route: '/threads',   label: 'Threads',       icon: '💬', section: 'inbox', v6New: true,
    description: 'Group messages by recruiter / thread.' },
  { id: 'templates', route: '/templates', label: 'Email templates', icon: '📝', section: 'inbox', v6New: true,
    description: 'Reusable email + cover letter templates.' },

  // ===== Network =====
  { id: 'contacts',  route: '/contacts',  label: 'Contacts',      icon: '👥', section: 'network', v6New: true,
    description: 'Recruiters, hiring managers, referrers.' },
  { id: 'companies', route: '/companies', label: 'Companies',     icon: '🏢', section: 'network', v6New: true,
    description: 'Track every company you\'ve interacted with.' },
  { id: 'network',   route: '/network',   label: 'Network graph', icon: '🕸️', section: 'network', v6New: true,
    description: 'Visualize who introduced whom across your jobs.' },
  { id: 'sources',   route: '/sources',   label: 'Job sources',   icon: '🌐', section: 'network',
    description: 'LinkedIn, Indeed, Glassdoor, etc. — sync past applications.' },

  // ===== Knowledge =====
  { id: 'profile',   route: '/profile',   label: 'Profile',       icon: '👤', section: 'knowledge',
    description: 'Your master profile, named profiles, learned answers.' },
  { id: 'documents', route: '/documents', label: 'Documents',     icon: '📁', section: 'knowledge',
    description: 'Resumes, cover letters, transcripts, portfolios.' },
  { id: 'resume-builder', route: '/resume-builder', label: 'Resume Builder', icon: '📄', section: 'knowledge', v6New: true,
    description: 'AI-powered resume drafts tailored to job descriptions.' },
  { id: 'cover-studio',   route: '/cover-studio',   label: 'Cover Letter Studio', icon: '✍️', section: 'knowledge', v6New: true,
    description: 'Generate, edit, and store cover letters per application.' },
  { id: 'interview-prep', route: '/interview-prep', label: 'Interview Prep',   icon: '🎤', section: 'knowledge', v6New: true,
    description: 'AI-generated questions + practice mode with self-rating.' },
  { id: 'salary',         route: '/salary',         label: 'Salary research', icon: '💰', section: 'knowledge', v6New: true,
    description: 'Track comp ranges by role + company.' },
  { id: 'notes',          route: '/notes',          label: 'Notes',           icon: '🗒️', section: 'knowledge', v6New: true,
    description: 'Markdown notes per application or standalone.' },

  // ===== Growth =====
  { id: 'analytics',    route: '/analytics',    label: 'Analytics',     icon: '📈', section: 'growth', v6New: true,
    description: 'Funnel, response rate, time-to-offer, conversion by source.' },
  { id: 'goals',        route: '/goals',        label: 'Goals',         icon: '🎯', section: 'growth', v6New: true,
    description: 'Weekly / monthly application + interview targets.' },
  { id: 'achievements', route: '/achievements', label: 'Achievements',  icon: '🏆', section: 'growth', v6New: true,
    description: 'Milestones unlocked as you hit your goals.' },
  { id: 'skills',       route: '/skills',       label: 'Skills',        icon: '🧰', section: 'growth', v6New: true,
    description: 'Skills you list + the gap to roles you\'re targeting.' },
  { id: 'recommendations', route: '/recommendations', label: 'Recommended jobs', icon: '🔍', section: 'growth', v6New: true,
    description: 'AI-suggested searches across LinkedIn, Indeed, Glassdoor.' },

  // ===== Workspace =====
  { id: 'ai',           route: '/ai',           label: 'AI Assistant',  icon: '✨', section: 'workspace',
    description: 'Connect Ollama / OpenAI / Chrome AI. Setup wizard.' },
  { id: 'ai-lab',       route: '/ai-lab',       label: 'AI Lab',        icon: '🧪', section: 'workspace', v6New: true,
    description: 'Tinker with prompts and feature toggles.' },
  { id: 'integrations', route: '/integrations', label: 'Integrations',  icon: '🔌', section: 'workspace', v6New: true,
    description: 'Calendar, Gmail, Slack, desktop app sync.' },
  { id: 'install-app',  route: '/install-app',  label: 'Install desktop app', icon: '🖥️', section: 'workspace', v6New: true,
    description: 'Install the optional desktop companion for real-time sync, folder watching, and background scrapes.' },
  { id: 'tour',         route: '/tour',         label: 'Take the tour', icon: '🎓', section: 'workspace', v6New: true,
    description: 'Interactive walkthrough of every feature.' },

  // ===== v8 new pages =====
  { id: 'mock-interview', route: '/mock-interview', label: 'Mock Interview', icon: '🎙️', section: 'knowledge', v6New: true,
    description: 'Live AI interview studio — chat with the interviewer, get inline feedback.' },
  { id: 'company-hub', route: '/company-hub', label: 'Company Hub', icon: '🏢', section: 'knowledge', v6New: true,
    description: 'Per-company research, related jobs, contacts, and news.' },
  { id: 'references', route: '/references', label: 'References', icon: '🔖', section: 'knowledge', v6New: true,
    description: 'Track professional references and outreach status.' },
  { id: 'offer-compare', route: '/offer-compare', label: 'Offer Compare', icon: '⚖️', section: 'growth', v6New: true,
    description: 'Side-by-side compare every active offer with an AI winner call-out.' },
  { id: 'negotiation', route: '/negotiation', label: 'Negotiation Studio', icon: '🤝', section: 'growth', v6New: true,
    description: 'Run offer evaluation + negotiation strategy with iterative AI follow-ups.' },
  { id: 'roadmap', route: '/roadmap', label: 'Career Roadmap', icon: '🗺️', section: 'growth', v6New: true,
    description: '1/3/5-year career milestones projected from your history.' },
  { id: 'ai-coach', route: '/ai-coach', label: 'AI Coach', icon: '💡', section: 'workspace', v6New: true,
    description: 'Free-form chat about your job search with full state context.' },
  { id: 'daily-digest', route: '/daily-digest', label: 'Daily Digest', icon: '📰', section: 'workspace', v6New: true,
    description: 'Auto-generated daily summary with nudges and calendar events.' },

  // ===== System =====
  { id: 'settings',     route: '/settings',     label: 'Settings',      icon: '⚙️', section: 'system', alwaysShow: true,
    description: 'Themes, icons, AI providers, customization.' },
  { id: 'audit',        route: '/audit',        label: 'Audit log',     icon: '🔍', section: 'system', v6New: true,
    description: 'Tamper-evident log of every state change.' },
  { id: 'backup',       route: '/backup',       label: 'Backup & export', icon: '💾', section: 'system', v6New: true,
    description: 'Encrypted export, JSON download, restore.' },
  { id: 'logs',         route: '/logs',         label: 'Activity logs', icon: '📜', section: 'system', v6New: true,
    description: 'Live log stream from background + content scripts.' },

  // ===== Workspace (v8.5 QoL additions) =====
  { id: 'bulk-tools',    route: '/bulk-tools',    label: 'Bulk tools',    icon: '📦', section: 'workspace', v6New: true,
    description: 'Bulk import/export jobs as CSV or JSON snapshots.' },
  { id: 'pomodoro',      route: '/pomodoro',      label: 'Pomodoro',      icon: '🍅', section: 'workspace', v6New: true,
    description: 'Focus timer with daily session tracking.' },

  // ===== v9 NEW PAGES =====
  { id: 'fit-scores',  route: '/fit-scores',  label: 'Fit Scores',     icon: '🎯', section: 'growth', v8New: true,
    description: 'Per-job AI-computed match score with explanation and skill gap.' },
  { id: 'red-flags',   route: '/red-flags',   label: 'JD Red Flags',   icon: '🚩', section: 'pipeline', v8New: true,
    description: 'Detected warning signs across job descriptions in your pipeline.' },
  { id: 'autopsy',     route: '/autopsy',     label: 'Application Autopsy', icon: '🩺', section: 'growth', v8New: true,
    description: 'Post-rejection AI breakdown of likely gaps and what to learn.' },
  { id: 'tags',        route: '/tags',        label: 'Tags',           icon: '🏷️', section: 'workspace', v8New: true,
    description: 'Manage tags + smart-tag rules that auto-apply across applications.' },
  { id: 'saved-views', route: '/saved-views', label: 'Saved Views',    icon: '⭐', section: 'pipeline', v8New: true,
    description: 'Pin filter combinations as quick-access tabs.' },
  { id: 'health',      route: '/health',      label: 'Health Check',   icon: '🩻', section: 'system', v8New: true,
    description: 'Verify extension permissions, sync, AI provider, and DB integrity.' },
  { id: 'sandbox',     route: '/sandbox',     label: 'Sandbox',        icon: '🧰', section: 'workspace', v8New: true,
    description: 'Interactive demo data you can wipe — try the app without committing real data.' },
  { id: 'permissions', route: '/permissions', label: 'Permissions',    icon: '🛡️', section: 'system', v8New: true,
    description: 'Audit every Chrome permission this extension uses, with rationale.' },
  { id: 'recipes',     route: '/recipes',     label: 'Recipes',        icon: '🧪', section: 'workspace', v8New: true,
    description: 'Saved automation flows — when X happens, do Y.' },
  { id: 'webhooks',    route: '/webhooks',    label: 'Webhooks',       icon: '🪝', section: 'system', v8New: true,
    description: 'Outbound webhook configuration for n8n / Zapier / Slack.' },
  { id: 'voice',       route: '/voice',       label: 'Voice quick-add', icon: '🎙️', section: 'workspace', v8New: true,
    description: 'Speak a sentence — AI parses it into a job application entry.' },
  { id: 'timeline',    route: '/timeline',    label: 'Timeline',       icon: '📜', section: 'pipeline', v8New: true,
    description: 'Single chronological view of every event across every application.' }
];

// Lookup helpers
export function pageById(id) { return PAGES.find((p) => p.id === id); }
export function pageByRoute(route) {
  // Exact match first, then prefix match for /job/:id-style
  const exact = PAGES.find((p) => p.route === route);
  if (exact) return exact;
  return PAGES.find((p) => route && route.startsWith(p.route + '/'));
}

// Compute the user's effective sidebar from settings
export function computeSidebar(settings = {}) {
  const order = Array.isArray(settings.sidebarOrder) && settings.sidebarOrder.length
    ? settings.sidebarOrder
    : PAGES.map((p) => p.id);
  const hidden = new Set(settings.sidebarHidden || []);
  const pinned = new Set(settings.sidebarPinned || []);

  // Pinned at top, then ordered, then anything new not in user's order
  const seen = new Set();
  const out = [];
  for (const id of pinned) {
    const p = pageById(id);
    if (p && !seen.has(id) && !hidden.has(id)) { out.push(p); seen.add(id); }
  }
  for (const id of order) {
    const p = pageById(id);
    if (p && !seen.has(id) && !hidden.has(id) && !p.alwaysShow) { out.push(p); seen.add(id); }
  }
  // Always-show pages that haven't been added (Dashboard, Settings)
  for (const p of PAGES) {
    if (p.alwaysShow && !seen.has(p.id) && !hidden.has(p.id)) {
      // Insert always-show pages at appropriate place: dashboard first, settings before audit
      if (p.id === 'dashboard') out.unshift(p);
      else out.push(p);
      seen.add(p.id);
    }
  }
  // Append any registry pages the user hasn't seen yet (newly added)
  for (const p of PAGES) {
    if (!seen.has(p.id) && !hidden.has(p.id)) out.push(p);
  }
  return out;
}

// Group sidebar pages by section for the default rendering
export function groupBySection(pages) {
  const groups = SECTIONS.map((s) => ({ ...s, pages: [] }));
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  const orphan = { id: 'other', label: 'Other', icon: '•', pages: [] };
  for (const p of pages) {
    const g = byId[p.section] || orphan;
    g.pages.push(p);
  }
  if (orphan.pages.length) groups.push(orphan);
  return groups.filter((g) => g.pages.length);
}
