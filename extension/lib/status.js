// JAT v10 — status FSM.
// Mirrored on the app side in db.js. The dashboard, the popup, the detector,
// and the SQLite store all read from this exact ordering. Forward-only when
// driven by the pipeline; manual edits can move anywhere.

export const STATUSES = [
  { id: 'started',         label: 'Started',         order: 10, terminal: false, category: 'pre' },
  { id: 'submitted',       label: 'Submitted',       order: 20, terminal: false, category: 'active' },
  { id: 'contacted',       label: 'Contacted',       order: 30, terminal: false, category: 'active' },
  { id: 'interview_1',     label: 'First interview', order: 40, terminal: false, category: 'active' },
  { id: 'interview_2',     label: 'Second interview',order: 50, terminal: false, category: 'active' },
  { id: 'interview_final', label: 'Final interview', order: 60, terminal: false, category: 'active' },
  { id: 'offer',           label: 'Offer',           order: 70, terminal: false, category: 'win' },
  { id: 'hired',           label: 'Hired',           order: 80, terminal: true,  category: 'win' },
  { id: 'rejected',        label: 'Rejected',        order: 90, terminal: true,  category: 'loss' },
  { id: 'withdrawn',       label: 'Withdrawn',       order: 91, terminal: true,  category: 'loss' },
  { id: 'ghosted',         label: 'Ghosted',         order: 92, terminal: true,  category: 'loss' },
];

const BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

export function statusInfo(id) { return BY_ID[id] || null; }
export function statusLabel(id) { return BY_ID[id]?.label || id; }
export function isTerminal(id) { return !!BY_ID[id]?.terminal; }

// Forward-only elevation used by the pipeline (extension captures). Refuses
// to demote OR to move past a terminal status. Manual dashboard edits bypass
// this — they go through patchJob on the server.
export function elevatedStatus(current, incoming) {
  const co = BY_ID[current]?.order || 0;
  const ino = BY_ID[incoming]?.order || 0;
  if (isTerminal(current)) return current;
  if (ino > co) return incoming;
  return current;
}
