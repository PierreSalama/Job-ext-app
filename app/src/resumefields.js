// JAT v11 — deterministic résumé field extraction (contacts + links).
// Pure, no deps → unit-testable, and merged with the AI parse so the obvious
// things always come through even when the AI is slow, unavailable, or terse.
function deterministicResumeFields(text) {
  const t = String(text || '');
  const out = {};
  const email = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+\.?\w+/);
  if (email) out.email = email[0].replace(/\.$/, '');
  const phone = t.match(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
  if (phone) out.phone = phone[0].trim();
  const li = t.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[\w\-/%]+/i);
  if (li) out.linkedinUrl = li[0];
  const gh = t.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w\-/%]+/i);
  if (gh) out.githubUrl = gh[0];
  const site = t.match(/https?:\/\/(?!.*(?:linkedin|github)\.com)[\w.-]+\.[a-z]{2,}(?:\/[\w\-/%.#?=&]*)?/i);
  if (site) out.portfolioUrl = site[0];
  return out;
}

module.exports = { deterministicResumeFields };
