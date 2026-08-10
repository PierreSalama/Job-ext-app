// INBOUND OR OUTBOUND — and why a pipeline that ignores the difference gets things wrong.
//
// The triage sweep found six "interviews", and three of them were Pierre's OWN replies:
//   "Monday at 12:00 works perfectly. I will watch for the invitation."
// As triage that is defensible — it is interview correspondence. As a PIPELINE SIGNAL it is not:
// an application's stage should move because an employer said something, not because Pierre did.
//
// The failure mode this prevents is sharper than a miscount. Pierre forwards or replies to a
// rejection; the classifier reads the quoted text; the job is marked `rejected` on the strength of
// Pierre's own message. Direction is what stops a quoted email from being treated as news.
//
// Detection is by SENDER, deliberately. `to_addr` is empty for everything the Gmail sync writes
// (measured: every row), so a recipient-based rule would classify the entire store as outbound.

function norm(addr) {
  const s = String(addr || '').trim().toLowerCase();
  // "Pierre Salama <p@x.com>" → p@x.com
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

// Gmail treats dots and +tags as noise in the local part. A reply sent from
// "pierre.salama115+jobs@gmail.com" is still Pierre, and must not read as an employer.
function canonical(addr) {
  const a = norm(addr);
  const at = a.lastIndexOf('@');
  if (at < 1) return a;
  let local = a.slice(0, at);
  const domain = a.slice(at + 1);
  local = local.split('+')[0];
  if (/^(gmail|googlemail)\.com$/.test(domain)) local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

// `selfAddresses` is every address that IS Pierre. Anything else is someone writing to him.
// An empty list means we cannot tell — and in that case everything is treated as INBOUND, which is
// the pre-existing behaviour. Failing to the old behaviour matters: a misconfigured address list
// must not silently stop the pipeline from ever elevating a job again.
function directionOf(email, selfAddresses = []) {
  const self = new Set((selfAddresses || []).map(canonical).filter(Boolean));
  if (!self.size) return 'inbound';
  const from = canonical((email && (email.fromAddr || email.from_addr || email.from)) || '');
  if (!from) return 'inbound';
  return self.has(from) ? 'outbound' : 'inbound';
}

// Only inbound mail may move an application's stage. Kept as its own named predicate so the rule
// reads the same at every call site, and so the reason is greppable when someone asks why a
// perfectly good rejection did not elevate anything.
function canElevate(direction) {
  return direction !== 'outbound';
}

module.exports = { directionOf, canElevate, canonical, norm };
