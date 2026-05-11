// Default interactive tour: one step per page (targeting the sidebar nav link)
// plus a few feature spotlights for the highlight pages. Each step shape:
//   { pageRoute, selector, title, body, position }
//
// `pageRoute` is the hash route the engine should navigate to before showing
// the tooltip. `selector` is a CSS selector for the highlighted element on
// that page. `position` controls tooltip placement (defaults to 'right' on
// sidebar links, 'bottom' otherwise).
import { PAGES } from './pages.js';

export function buildDefaultTour() {
  const steps = [];

  // Welcome step — anchored on brand
  steps.push({
    pageRoute: '/',
    selector: '.brand',
    title: 'Welcome to Job Tracker v8',
    body: 'This quick tour shows every page in the app. Use Next/Prev to move around — Skip exits at any time.',
    position: 'right'
  });

  // One step per registered page (sidebar nav link)
  for (const p of PAGES) {
    const sel = `[data-tour="page-${p.id}"]`;
    steps.push({
      pageRoute: p.route,
      selector: sel,
      title: `${p.icon} ${p.label}`,
      body: p.description || '',
      position: 'right'
    });
    // Append feature spotlights for selected pages
    const extras = FEATURE_SPOTLIGHTS[p.id];
    if (Array.isArray(extras)) {
      for (const ex of extras) {
        steps.push({ pageRoute: p.route, ...ex });
      }
    }
  }

  // Closing celebration step
  steps.push({
    pageRoute: '/',
    selector: '.brand',
    title: 'Tour complete',
    body: 'You\'ve seen the whole app. Anything you missed lives in the sidebar — and you can always re-run the tour from the Tour page.',
    position: 'right'
  });

  return steps;
}

// Per-page follow-up steps that highlight a specific feature. Selectors must
// match elements actually rendered by that page module.
const FEATURE_SPOTLIGHTS = {
  dashboard: [
    { selector: '#tour-start-btn', title: 'Re-run the tour', body: 'You can boot this tour any time from this button.', position: 'bottom' },
    { selector: '#ai-nudges', title: 'AI nudges', body: 'When AI is configured, this gives you a prioritized list of jobs to follow up on.', position: 'bottom' },
    { selector: '#refresh-recs', title: 'Recommended searches', body: 'Refreshes a list of recommended job searches based on what you\'ve applied to.', position: 'bottom' }
  ],
  jobs: [
    { selector: '#search', title: 'Filter applications', body: 'Type to search across title, company, and location.', position: 'bottom' },
    { selector: '#filter-status', title: 'Filter by status', body: 'Narrow down by application stage.', position: 'bottom' }
  ],
  pipeline: [
    { selector: '.kanban', title: 'Drag to update', body: 'Drag a card between columns to move the application to a new status.', position: 'top' }
  ],
  calendar: [
    { selector: '.calendar-grid', title: 'Calendar view', body: 'Interviews and follow-up deadlines appear here.', position: 'top' }
  ],
  reminders: [
    { selector: '.reminders-list', title: 'Reminder list', body: 'Time-based nudges so nothing slips through.', position: 'top' }
  ],
  todos: [
    { selector: '.todos-add', title: 'Quick add', body: 'Per-application checklists or free-form todos.', position: 'bottom' }
  ],
  inbox: [
    { selector: '.inbox-list', title: 'Unified inbox', body: 'Recruiter messages from every connected source land here.', position: 'top' }
  ],
  templates: [
    { selector: '.tpl-add', title: 'Save a template', body: 'Cover letter and outreach snippets you can reuse.', position: 'bottom' }
  ],
  contacts: [
    { selector: '.contacts-add', title: 'Track contacts', body: 'Recruiters, hiring managers, and referrers — all in one place.', position: 'bottom' }
  ],
  companies: [
    { selector: '.companies-list', title: 'Company list', body: 'Aggregates every company touchpoint across your applications.', position: 'top' }
  ],
  network: [
    { selector: '.network-canvas', title: 'Your network', body: 'Visualizes who connected you to which job.', position: 'top' }
  ],
  sources: [
    { selector: '.source-card', title: 'Job sources', body: 'Sync past applications from LinkedIn, Indeed, Glassdoor, and more.', position: 'top' }
  ],
  profile: [
    { selector: '#p-save', title: 'Save your profile', body: 'Used for AI features and universal autofill across every site.', position: 'bottom' }
  ],
  documents: [
    { selector: '#doc-upload-btn', title: 'Upload documents', body: 'Resumes, cover letters, transcripts — stored locally.', position: 'bottom' }
  ],
  'resume-builder': [
    { selector: '#rb-generate', title: 'Generate a resume', body: 'Tailors a resume to the selected job description using AI.', position: 'bottom' }
  ],
  'cover-studio': [
    { selector: '#cs-generate', title: 'Generate a cover letter', body: 'Drafts a cover letter you can edit and store per application.', position: 'bottom' }
  ],
  'interview-prep': [
    { selector: '#ip-generate', title: 'Practice questions', body: 'Get likely interview questions and rate your own answers.', position: 'bottom' }
  ],
  salary: [
    { selector: '.salary-add', title: 'Comp data', body: 'Track comp ranges by role and company.', position: 'bottom' }
  ],
  notes: [
    { selector: '.notes-add', title: 'Notes', body: 'Markdown notes — per application or free-form.', position: 'bottom' }
  ],
  analytics: [
    { selector: '.analytics-grid', title: 'Funnels and trends', body: 'Response rates, conversion by source, time-to-offer.', position: 'top' }
  ],
  goals: [
    { selector: '.goals-add', title: 'Set a goal', body: 'Weekly or monthly application targets keep you on pace.', position: 'bottom' }
  ],
  achievements: [
    { selector: '.achv-grid', title: 'Achievements', body: 'Milestones unlock as you hit your goals.', position: 'top' }
  ],
  skills: [
    { selector: '.skills-add', title: 'Track skills', body: 'Skills you have vs the gap to roles you want.', position: 'bottom' }
  ],
  recommendations: [
    { selector: '.rec-card', title: 'Recommended jobs', body: 'AI-suggested searches across LinkedIn, Indeed, Glassdoor.', position: 'top' }
  ],
  ai: [
    { selector: '.ai-card', title: 'AI providers', body: 'Connect Ollama (local), OpenAI, or Chrome\'s built-in AI.', position: 'top' }
  ],
  'ai-lab': [
    { selector: '#lab-prompt', title: 'Free-form prompt', body: 'Try arbitrary prompts and compare providers side-by-side.', position: 'bottom' }
  ],
  integrations: [
    { selector: '.integration-card', title: 'Integrations', body: 'Calendar, Gmail, Slack, and the desktop sync app live here.', position: 'top' }
  ],
  tour: [
    { selector: '#tour-restart', title: 'Restart the tour', body: 'Run this tour again any time.', position: 'bottom' }
  ],
  settings: [
    { selector: '.theme-grid', title: 'Themes', body: '40+ themes built-in. Pick one — the change applies instantly.', position: 'top' }
  ],
  audit: [
    { selector: '#audit-verify', title: 'Verify chain', body: 'Recomputes every audit hash to detect tampering.', position: 'bottom' }
  ],
  backup: [
    { selector: '#backup-export', title: 'Export everything', body: 'Downloads a JSON snapshot of every store, settings, and profiles.', position: 'bottom' }
  ],
  logs: [
    { selector: '.logs-tabs', title: 'Live logs', body: 'Tail-follows the activity log. Filter by errors, warnings, AI, capture.', position: 'bottom' }
  ]
};
