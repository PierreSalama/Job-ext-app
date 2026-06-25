// Detection harness — runs the REAL content-script signal modules against
// realistic ATS / job-board page structures in jsdom. This is what proves the
// engine recognizes an application form on each site type (the thing that was
// failing for external-ATS apply pages like Workday).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sig = (f) => pathToFileURL(path.join(here, '..', 'extension', 'content', 'signals', f)).href;

// Install a jsdom document as the globals the modules read, with layout faked
// (jsdom does no layout, so getBoundingClientRect would report 0×0 and every
// element would look invisible).
function mount(html, url = 'https://example.com/') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () { return { width: 120, height: 22, top: 10, left: 10, right: 130, bottom: 32, x: 10, y: 10 }; };
  Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 120; } });
  Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 22; } });
  for (const k of ['window', 'document', 'location', 'Element', 'Node', 'HTMLElement', 'HTMLInputElement', 'NodeFilter', 'getComputedStyle', 'MutationObserver']) {
    globalThis[k] = w[k];
  }
  globalThis.CSS = w.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  return w;
}

let forms, intent, success;
test.before(async () => {
  // jsdom globals must exist before the modules' transitive imports evaluate.
  mount('');
  forms = await import(sig('forms.js'));
  intent = await import(sig('intent.js'));
  success = await import(sig('success.js'));
});

const btn = (label, attrs = '') => `<button type="button" ${attrs}>${label}</button>`;

// ---------- fixtures ----------
const WORKDAY_MYINFO = `
<div data-automation-id="applyFlowPage">
  <h2 data-automation-id="applyFlowPageHeader">My Information</h2>
  <label for="src">How Did You Hear About Us?*</label>
  <select id="src" required><option>Select One</option><option>LinkedIn</option></select>
  <label for="country">Country*</label>
  <select id="country" required><option>Canada</option></select>
  <label for="fn">First Name*</label>
  <input id="fn" data-automation-id="legalNameSection_firstName" required />
  <label for="ln">Last Name*</label>
  <input id="ln" data-automation-id="legalNameSection_lastName" required />
  ${btn('Back', 'data-automation-id="bottom-navigation-back-button"')}
  ${btn('Next', 'data-automation-id="bottom-navigation-next-button"')}
</div>`;

const WORKDAY_REVIEW = `
<div data-automation-id="applyFlowPage">
  <h2>Review</h2>
  <label for="e">Email*</label><input id="e" type="email" required />
  <label for="p">Phone*</label><input id="p" required />
  <div data-automation-id="quickApplyReview">Please review your application before submitting.</div>
  ${btn('Submit', 'data-automation-id="bottom-navigation-submit-button"')}
</div>`;

const GREENHOUSE = `
<form id="application_form" class="application--form">
  <h1 class="app-title">Apply for this Job</h1>
  <label for="first_name">First Name *</label><input id="first_name" required />
  <label for="last_name">Last Name *</label><input id="last_name" required />
  <label for="email">Email *</label><input id="email" type="email" required />
  <label for="phone">Phone</label><input id="phone" />
  <label for="resume">Resume/CV *</label>
  <input id="resume" type="file" />
  <label for="cover">Cover Letter</label><input id="cover" type="file" />
  <label for="q1">Are you legally authorized to work in Canada? *</label>
  <select id="q1" required><option>Yes</option><option>No</option></select>
  <button id="submit_app" type="submit">Submit Application</button>
</form>`;

const LEVER = `
<form class="application-form" id="application-form">
  <h2 class="posting-headline">Apply for Senior Engineer</h2>
  <input name="name" placeholder="Full name" required />
  <input name="email" type="email" placeholder="Email" required />
  <input name="phone" placeholder="Phone" />
  <div class="application-question">Resume / CV<input type="file" name="resume" /></div>
  <label>LinkedIn URL<input name="urls[LinkedIn]" /></label>
  <button class="template-btn-submit" type="submit">Submit application</button>
</form>`;

const UNIVERSITY_BOARD = `
<main id="application">
  <h1>Application for Research Assistant — University Careers</h1>
  <p>* Indicates a required field</p>
  <label for="fn">First Name *</label><input id="fn" required />
  <label for="ln">Last Name *</label><input id="ln" required />
  <label for="em">Email Address *</label><input id="em" type="email" required />
  <label for="res">Upload your resume *</label><input id="res" type="file" required />
  <label for="auth">Work Authorization *</label><input id="auth" required />
  <label for="yrs">Years of experience</label><input id="yrs" />
  ${btn('Next', '')}
</main>`;

const LINKEDIN_EASYAPPLY = `
<div role="dialog" aria-modal="true" class="jobs-easy-apply-modal">
  <h2>Apply to Acme Corp</h2>
  <label for="em">Email address</label><input id="em" type="email" value="me@x.com" />
  <label for="ph">Mobile phone number</label><input id="ph" value="555-1212" />
  <div class="jobs-document-upload__file-name">Pierre_Resume_2024.pdf</div>
  <label for="q">How many years of experience do you have with React?</label>
  <input id="q" />
  <button aria-label="Submit application" type="button">Submit application</button>
</div>`;

const INDEED_SMARTAPPLY = `
<div data-testid="smartapply-container">
  <h1>Add your contact information</h1>
  <label for="fn">First name</label><input id="fn" required />
  <label for="ln">Last name</label><input id="ln" required />
  <label for="em">Email</label><input id="em" type="email" required />
  <label for="res">Resume</label><input id="res" type="file" />
  ${btn('Continue', '')}
</div>`;

// ---- negatives ----
const SIGNUP = `
<form>
  <h1>Create your account</h1>
  <label for="em">Email</label><input id="em" type="email" />
  <label for="pw">Password</label><input id="pw" type="password" />
  <label for="pw2">Confirm Password</label><input id="pw2" type="password" />
  ${btn('Create account', '')}
</form>`;

const CONTACT = `
<form>
  <h2>Contact us</h2>
  <label for="nm">Your name</label><input id="nm" />
  <label for="em">Your email</label><input id="em" type="email" />
  <label for="msg">Your message</label><textarea id="msg"></textarea>
  ${btn('Send', '')}
</form>`;

const NEWSLETTER = `
<form>
  <h3>Subscribe to our newsletter</h3>
  <input type="email" placeholder="you@example.com" />
  ${btn('Subscribe', '')}
</form>`;

const ICIMS = `
<div id="icims_content_iframe"><form id="jobApplicationForm">
  <h1>Application</h1>
  <label for="fn">First Name *</label><input id="fn" required />
  <label for="ln">Last Name *</label><input id="ln" required />
  <label for="em">Email *</label><input id="em" type="email" required />
  <label for="res">Attach Resume *</label><input id="res" type="file" required />
  ${btn('Submit', '')}
</form></div>`;

const SMARTRECRUITERS = `
<div data-test="application-form" class="application">
  <h2>Apply to Acme</h2>
  <label for="fn">First name *</label><input id="fn" required />
  <label for="ln">Last name *</label><input id="ln" required />
  <label for="em">Email *</label><input id="em" type="email" required />
  <div>Upload resume<input type="file" id="res" /></div>
  ${btn('Send application', 'data-test="form-apply-button"')}
</div>`;

const ASHBY = `
<form class="ashby-application-form">
  <h2>Submit your application</h2>
  <label for="nm">Name *</label><input id="nm" required />
  <label for="em">Email *</label><input id="em" type="email" required />
  <label for="res">Resume *</label><input id="res" type="file" required />
  <label for="q">Why do you want to work here?</label><textarea id="q"></textarea>
  ${btn('Submit Application', '')}
</form>`;

const BAMBOO = `
<div class="ats-application-form" id="application">
  <h1>Application for Marketing Lead</h1>
  <label for="fn">First Name*</label><input id="fn" required />
  <label for="ln">Last Name*</label><input id="ln" required />
  <label for="em">Email*</label><input id="em" type="email" required />
  <label for="ph">Phone*</label><input id="ph" required />
  <label for="res">Resume*</label><input id="res" type="file" required />
  ${btn('Submit Application', '')}
</div>`;

const SUCCESSFACTORS = `
<div data-automation-id="application" id="jobApplication">
  <h2>Job Application</h2>
  <label for="fn">First Name *</label><input id="fn" required />
  <label for="ln">Last Name *</label><input id="ln" required />
  <label for="em">E-mail *</label><input id="em" type="email" required />
  <label for="auth">Are you legally authorized to work? *</label>
  <select id="auth" required><option>Yes</option><option>No</option></select>
  <label for="res">Upload Resume / CV *</label><input id="res" type="file" required />
  ${btn('Apply', '')}
</div>`;

const GENERIC_CAREERS = `
<form action="/careers/apply" method="post">
  <h2>Apply for this position</h2>
  <label for="nm">Full Name *</label><input id="nm" name="name" required />
  <label for="em">Email Address *</label><input id="em" name="email" type="email" required />
  <label for="ph">Phone Number</label><input id="ph" name="phone" />
  <label for="res">Upload your resume *</label><input id="res" name="resume" type="file" required />
  <label for="cl">Cover letter</label><textarea id="cl" name="cover"></textarea>
  ${btn('Submit Application', '')}
</form>`;

const SCHOOL_PEOPLEADMIN = `
<div id="application_form">
  <h1>Apply for Teaching Assistant — District Careers</h1>
  <p>Fields marked with * are required.</p>
  <label for="fn">First Name *</label><input id="fn" required />
  <label for="ln">Last Name *</label><input id="ln" required />
  <label for="em">Email *</label><input id="em" type="email" required />
  <label for="cert">Teaching Certification</label><input id="cert" />
  <label for="res">Resume / CV *</label><input id="res" type="file" required />
  ${btn('Next', '')}
</div>`;

// ---------- apply-form detection (the core) ----------
const POSITIVE = [
  ['Workday — My Information', WORKDAY_MYINFO, 'https://co.wd3.myworkdayjobs.com/x/job/_R1/apply/applyManually'],
  ['Workday — Review/Submit', WORKDAY_REVIEW, 'https://co.wd3.myworkdayjobs.com/x/job/_R1/apply'],
  ['Greenhouse', GREENHOUSE, 'https://boards.greenhouse.io/acme/jobs/123'],
  ['Lever', LEVER, 'https://jobs.lever.co/acme/abc/apply'],
  ['University / generic ATS', UNIVERSITY_BOARD, 'https://careers.university.edu/postings/555/apply'],
  ['LinkedIn Easy Apply modal', LINKEDIN_EASYAPPLY, 'https://www.linkedin.com/jobs/view/123'],
  ['Indeed smartapply', INDEED_SMARTAPPLY, 'https://smartapply.indeed.com/beta/indeedapply/form'],
  ['iCIMS', ICIMS, 'https://careers-acme.icims.com/jobs/123/apply'],
  ['SmartRecruiters', SMARTRECRUITERS, 'https://jobs.smartrecruiters.com/acme/123/apply'],
  ['Ashby', ASHBY, 'https://jobs.ashbyhq.com/acme/abc/application'],
  ['BambooHR', BAMBOO, 'https://acme.bamboohr.com/careers/123/apply'],
  ['SuccessFactors', SUCCESSFACTORS, 'https://career.acme.com/careersection/apply'],
  ['Generic company careers form', GENERIC_CAREERS, 'https://acme.com/careers/apply'],
  ['School / PeopleAdmin board', SCHOOL_PEOPLEADMIN, 'https://district.schoolspring.com/job/apply/555'],
  // Minimal apply form: a file input WITH corroborating resume/apply text must still detect, so the
  // tightened file-input gate (corroboration-required) doesn't regress lean real forms.
  ['Minimal apply form (file input + résumé label)', `
    <form>
      <h2>Apply for this role</h2>
      <label for="r">Resume / CV</label>
      <input type="file" id="r" />
      <label for="n">Full name</label>
      <input id="n" />
      <button type="submit">Submit application</button>
    </form>`, 'https://acme.com/jobs/apply'],
];

for (const [name, html, url] of POSITIVE) {
  test(`detects apply form: ${name}`, () => {
    mount(html, url);
    const f = forms.detectApplyForm();
    assert.ok(f, `${name}: detectApplyForm returned null`);
    assert.ok(f.confidence >= 0.45, `${name}: confidence ${f?.confidence} too low`);
  });
}

// A media/streaming SPA (Plex) carries a utility file input (poster/avatar) + generic words
// (remote/benefits) but NO apply/résumé text — it must NOT be detected as an apply form. This is
// the Plex "popup on the right" bug: a bare file input used to make the page body a false candidate.
const PLEX_MEDIA = `
<div class="plex-app">
  <h1>Continue Watching</h1>
  <input type="search" placeholder="Search your library" />
  <input type="text" placeholder="Filter titles" />
  <select><option>All libraries</option></select>
  <input type="file" id="posterImg" />
  <button>Play</button>
  <button>Pause</button>
  <p>Stream your movies, shows and music anywhere. Remote access enabled. Premium benefits for Plex Pass members.</p>
</div>`;
const NEGATIVE = [
  ['Sign-up form', SIGNUP],
  ['Contact form', CONTACT],
  ['Newsletter', NEWSLETTER],
  ['Media SPA with a bare file input (Plex)', PLEX_MEDIA],
];
for (const [name, html] of NEGATIVE) {
  test(`rejects non-apply form: ${name}`, () => {
    mount(html);
    const f = forms.detectApplyForm();
    assert.ok(!f, `${name}: should NOT be an apply form (got confidence ${f?.confidence})`);
  });
}

// ---------- uploaded-resume filename detection ----------
// The Workday/Greenhouse "uploaded file" chip shows the real filename in its own
// element. These can be long, multi-word names — the bug Pierre hit was an
// 8-word filename not being detected, with instruction text not rejected.
const WORKDAY_UPLOADED = `
<div data-automation-id="applyFlowPage">
  <h2>My Information</h2>
  <div data-automation-id="resumeSection">
    <p>Upload either a .pdf or .docx version of your resume. Please ensure you use a consistent format.</p>
    <div data-automation-id="file-upload-item">
      <span data-automation-id="fileName">Website Sale and Transfer Agreement - Ayhans Barbershop.pdf</span>
      <span>Successfully Uploaded!</span>
    </div>
  </div>
</div>`;

test('detects a long multi-word uploaded resume filename', () => {
  mount(WORKDAY_UPLOADED, 'https://co.wd3.myworkdayjobs.com/x/job/_R1/apply/applyManually');
  const name = forms.findResumeFilename(document.querySelector('[data-automation-id="applyFlowPage"]'));
  assert.equal(name, 'Website Sale and Transfer Agreement - Ayhans Barbershop.pdf');
});

test('does not mistake upload-instruction text for a filename', () => {
  mount(`<div data-automation-id="applyFlowPage">
    <p>Please upload a .pdf or .docx file. Maximum file size is 5 MB. Accepted file types: .pdf, .docx.</p>
  </div>`, 'https://co.wd3.myworkdayjobs.com/x/job/_R1/apply/applyManually');
  const name = forms.findResumeFilename(document.querySelector('[data-automation-id="applyFlowPage"]'));
  assert.equal(name, '', `instruction text was mistaken for a filename: "${name}"`);
});

// ---------- button intent ----------
test('step-advance + submit button classification', () => {
  mount(WORKDAY_MYINFO);
  const next = document.querySelector('[data-automation-id="bottom-navigation-next-button"]');
  assert.ok(intent.isStepAdvanceClick(next), 'Workday Next not a step-advance');

  mount(WORKDAY_REVIEW);
  const submit = document.querySelector('[data-automation-id="bottom-navigation-submit-button"]');
  assert.ok(intent.isSubmitClick(submit), 'Workday Submit not a submit');

  mount(GREENHOUSE);
  assert.ok(intent.isSubmitClick(document.querySelector('#submit_app')), 'Greenhouse Submit Application not a submit');

  mount(LEVER);
  assert.ok(intent.isSubmitClick(document.querySelector('.template-btn-submit')), 'Lever submit not a submit');

  mount(INDEED_SMARTAPPLY);
  assert.ok(intent.isStepAdvanceClick([...document.querySelectorAll('button')].find((b) => /continue/i.test(b.textContent))), 'Continue not a step-advance');
});

test('apply-button classification + signup rejection', () => {
  mount('<a href="/apply" class="jobs-apply-button">Easy Apply</a>');
  assert.ok(intent.isApplyClick(document.querySelector('a')), 'Easy Apply not an apply click');
  mount('<a class="cta-apply">Apply</a>');
  assert.ok(intent.isApplyClick(document.querySelector('a')), 'Apply not an apply click');
  mount(SIGNUP);
  assert.ok(!intent.isApplyClick([...document.querySelectorAll('button')][0]), '"Create account" must NOT be an apply click');
});

// ---------- success detection ----------
const SUCCESS_PAGES = [
  ['Workday', 'You have submitted your application. Thank you for your interest.'],
  ['Greenhouse', 'Thank you for applying. We have received your application.'],
  ['Generic', 'Your application was submitted successfully.'],
  ['French', 'Votre candidature a bien été envoyée. Merci d\'avoir postulé.'],
];
for (const [name, text] of SUCCESS_PAGES) {
  test(`detects success page: ${name}`, () => {
    mount(`<div>${text}</div>`);
    assert.ok(success.pageTextLooksLikeSuccess(), `${name}: success text not detected`);
  });
}
test('does not false-positive success on a plain job page', () => {
  mount('<div>Senior Engineer at Acme. Apply now to join our team.</div>');
  assert.ok(!success.pageTextLooksLikeSuccess(), 'plain job text wrongly flagged success');
});

// ---------- field capture ----------
test('snapshotAnswers captures the FILLED application fields', () => {
  mount(GREENHOUSE);
  document.querySelector('#first_name').value = 'Pierre';
  document.querySelector('#last_name').value = 'Salama';
  document.querySelector('#email').value = 'pierre@example.com';
  document.querySelector('#phone').value = '555-1212';
  const ans = forms.snapshotAnswers(document.querySelector('#application_form'));
  assert.ok(Object.keys(ans).length >= 3, `expected ≥3 captured fields, got ${Object.keys(ans).length}: ${JSON.stringify(ans)}`);
});
