// Achievements — badge grid. 20 pre-defined badges, auto-unlock on render.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const CATALOG = [
  { id: 'first-application', title: 'First step', description: 'Captured your first application.', icon: '🌱', test: (s) => s.jobs.length >= 1 },
  { id: 'apps-10', title: '10 applications', description: 'Logged 10 applications.', icon: '🔟', test: (s) => s.jobs.length >= 10 },
  { id: 'apps-25', title: 'Quarter century', description: '25 applications captured.', icon: '🥉', test: (s) => s.jobs.length >= 25 },
  { id: 'apps-50', title: 'Half-century', description: '50 applications captured.', icon: '🥈', test: (s) => s.jobs.length >= 50 },
  { id: 'apps-100', title: 'Century club', description: '100 applications captured.', icon: '🥇', test: (s) => s.jobs.length >= 100 },
  { id: 'first-interview', title: 'First interview', description: 'Got an interview!', icon: '🎤', test: (s) => s.jobs.some((j) => j.status === 'interview' || (j.timeline || []).some((t) => /interview/i.test(t.summary || ''))) },
  { id: 'first-offer', title: 'First offer', description: 'Received an offer!', icon: '🏆', test: (s) => s.jobs.some((j) => j.status === 'offer') },
  { id: 'multi-source', title: 'Diversified', description: 'Applied across 3+ job boards.', icon: '🌐', test: (s) => new Set(s.jobs.map((j) => j.source)).size >= 3 },
  { id: 'streak-7', title: '7-day streak', description: 'Applied 7 days in a row.', icon: '🔥', test: (s) => streakLen(s.jobs) >= 7 },
  { id: 'streak-30', title: '30-day streak', description: '30 consecutive days. Wow.', icon: '🌋', test: (s) => streakLen(s.jobs) >= 30 },
  { id: 'tour-complete', title: 'Tour guide', description: 'Completed the interactive tour.', icon: '🎓', test: (s) => s.settings?.tourCompleted === true },
  { id: 'profile-complete', title: 'Profile pro', description: 'Filled in 10+ profile fields.', icon: '👤', test: (s) => Object.values(s.profile || {}).filter((v) => v && typeof v === 'string').length >= 10 },
  { id: 'has-resume', title: 'Resume on file', description: 'Uploaded a resume document.', icon: '📄', test: (s) => (s.documents || []).some((d) => d.type === 'resume') },
  { id: 'has-cover', title: 'Cover letter on file', description: 'Saved a cover letter.', icon: '✍️', test: (s) => (s.coverLetters || []).length >= 1 || (s.documents || []).some((d) => d.type === 'coverLetter') },
  { id: 'first-note', title: 'Notetaker', description: 'Wrote your first note.', icon: '🗒️', test: (s) => (s.notes || []).length >= 1 },
  { id: 'goal-set', title: 'Goal-setter', description: 'Created your first goal.', icon: '🎯', test: (s) => (s.goals || []).length >= 1 },
  { id: 'salary-tracked', title: 'Salary nerd', description: 'Logged a salary data point.', icon: '💰', test: (s) => (s.salaryEntries || []).length >= 1 },
  { id: 'practiced', title: 'Practice makes perfect', description: 'Practiced an interview answer.', icon: '🎙️', test: (s) => (s.interviewQuestions || []).some((q) => q.answer || q.audioBase64) },
  { id: 'theme-changed', title: 'Style-switcher', description: 'Tried a different theme.', icon: '🎨', test: (s) => s.settings?.theme && s.settings.theme !== 'midnight' },
  { id: 'network-builder', title: 'Networker', description: 'Tracked your first contact.', icon: '🤝', test: (s) => (s.contacts || []).length >= 1 }
];

function streakLen(jobs) {
  const days = new Set((jobs || []).filter((j) => j.applied && j.submittedAt).map((j) => new Date(j.submittedAt).toDateString()));
  let count = 0;
  let d = new Date(); d.setHours(0, 0, 0, 0);
  while (days.has(d.toDateString())) { count++; d.setDate(d.getDate() - 1); }
  return count;
}

const local = { freshlyUnlocked: new Set() };

export function render(state) {
  const unlocked = new Map((state.achievements || []).map((a) => [a.id, a]));
  return `
    <div class="page-h">
      <div><h1>Achievements</h1><div class="sub">${unlocked.size} of ${CATALOG.length} unlocked.</div></div>
    </div>
    <style>
      @keyframes confetti { 0% { transform: scale(0.3) rotate(0); opacity: 0 } 30% { opacity: 1 } 100% { transform: scale(1.15) rotate(8deg); opacity: 1 } }
      .ach-card.fresh { animation: confetti 0.6s ease-out; box-shadow: 0 0 0 2px var(--success), 0 0 24px rgba(16,185,129,0.4) }
    </style>
    <div class="grid-3">
      ${CATALOG.map((a) => {
        const u = unlocked.get(a.id);
        const fresh = local.freshlyUnlocked.has(a.id);
        return `<div class="card ach-card${fresh ? ' fresh' : ''}" style="text-align:center;${u ? '' : 'opacity:0.4;filter:grayscale(0.7)'}">
          <div style="font-size:42px;margin-bottom:6px">${a.icon}</div>
          <strong>${esc(a.title)}</strong>
          <div style="color:var(--muted);font-size:12px;margin-top:4px">${esc(a.description)}</div>
          <div style="margin-top:8px;font-size:11px;color:${u ? 'var(--success)' : 'var(--muted)'}">${u ? '✓ ' + new Date(u.unlockedAt).toLocaleDateString() : 'Locked'}</div>
        </div>`;
      }).join('')}
    </div>
  `;
}

export function attach($main, ctx) {
  // Check unlock conditions on render
  (async () => {
    const have = new Set((ctx.state.achievements || []).map((a) => a.id));
    let unlockedAny = false;
    for (const a of CATALOG) {
      if (have.has(a.id)) continue;
      let pass = false;
      try { pass = !!a.test(ctx.state); } catch {}
      if (pass) {
        await ctx.send('add-achievements', {
          id: a.id, // override generated UUID
          title: a.title, description: a.description, icon: a.icon, unlockedAt: new Date().toISOString()
        });
        local.freshlyUnlocked.add(a.id);
        unlockedAny = true;
      }
    }
    if (unlockedAny) await ctx.reload('achievements');
  })();
}
