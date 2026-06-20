// Browser-fallback search-URL builder: a location is ALWAYS a geography (empty → country),
// work-mode is a SEPARATE filter (LinkedIn f_WT / Indeed remote attr), and the newest-first
// freshness ramp emits LinkedIn f_TPR / Indeed fromage. Pure helper in extension/lib/search-url.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl } from '../extension/lib/search-url.js';

test('LinkedIn: geography is mandatory — empty location falls back to the country', () => {
  const url = buildSearchUrl('linkedin', 'developer', '', { country: 'Canada' });
  assert.match(url, /^https:\/\/www\.linkedin\.com\/jobs\/search\//);
  assert.match(url, /[?&]location=Canada(?:&|$)/, 'empty location clamped to country');
  assert.match(url, /[?&]keywords=developer(?:&|$)/);
});

test('LinkedIn: a real geography is used verbatim (URL-encoded)', () => {
  const url = buildSearchUrl('linkedin', 'data analyst', 'Toronto, ON', { country: 'Canada' });
  assert.match(url, /location=Toronto%2C%20ON/);
  assert.doesNotMatch(url, /location=Canada/, 'a provided geography is NOT overwritten by country');
});

test('LinkedIn: work modes map to f_WT (1=onsite,2=remote,3=hybrid), joined with %2C', () => {
  assert.match(buildSearchUrl('linkedin', 'dev', 'Toronto', { workModes: ['remote'] }), /[?&]f_WT=2(?:&|$)/);
  assert.match(buildSearchUrl('linkedin', 'dev', 'Toronto', { workModes: ['onsite'] }), /[?&]f_WT=1(?:&|$)/);
  // remote + hybrid → ordered 2,3 joined with %2C
  assert.match(buildSearchUrl('linkedin', 'dev', 'Toronto', { workModes: ['hybrid', 'remote'] }), /[?&]f_WT=2%2C3(?:&|$)/);
});

test('LinkedIn: no work modes → no f_WT param at all (means "any")', () => {
  assert.doesNotMatch(buildSearchUrl('linkedin', 'dev', 'Toronto', {}), /f_WT/);
});

test('LinkedIn: freshness tier emits f_TPR=r<seconds>; absence omits it', () => {
  assert.match(buildSearchUrl('linkedin', 'dev', 'Toronto', { freshnessSeconds: 3600 }), /[?&]f_TPR=r3600(?:&|$)/);
  assert.match(buildSearchUrl('linkedin', 'dev', 'Toronto', { freshnessSeconds: 604800 }), /[?&]f_TPR=r604800(?:&|$)/);
  assert.doesNotMatch(buildSearchUrl('linkedin', 'dev', 'Toronto', {}), /f_TPR/);
});

test('LinkedIn: easyApplyOnly toggles f_AL', () => {
  assert.match(buildSearchUrl('linkedin', 'dev', 'Toronto', { easyApplyOnly: true }), /f_AL=true/);
  assert.doesNotMatch(buildSearchUrl('linkedin', 'dev', 'Toronto', { easyApplyOnly: false }), /f_AL=true/);
});

test('LinkedIn: a full combo (remote + fresh + easy-apply + geo)', () => {
  const url = buildSearchUrl('linkedin', 'software engineer', 'Vancouver, BC', {
    easyApplyOnly: true, workModes: ['remote'], country: 'Canada', freshnessSeconds: 7200,
  });
  assert.match(url, /f_AL=true/);
  assert.match(url, /keywords=software%20engineer/);
  assert.match(url, /location=Vancouver%2C%20BC/);
  assert.match(url, /f_WT=2/);
  assert.match(url, /f_TPR=r7200/);
});

test('Indeed: keeps &l=<geo> (empty → country) and coarse fromage in DAYS', () => {
  const url = buildSearchUrl('indeed', 'dev', '', { country: 'Canada', freshnessSeconds: 3600 });
  assert.match(url, /^https:\/\/www\.indeed\.com\/jobs/);
  assert.match(url, /[?&]l=Canada(?:&|$)/, 'empty location clamped to country');
  assert.match(url, /[?&]fromage=1(?:&|$)/, 'sub-day tier clamps to 1 day');
});

test('Indeed: remote folds into the single 0kf attribute group with easy-apply (no duplicate &sc)', () => {
  const url = buildSearchUrl('indeed', 'dev', 'Toronto', { easyApplyOnly: true, workModes: ['remote'] });
  const scCount = (url.match(/&sc=/g) || []).length;
  assert.equal(scCount, 1, 'exactly one &sc filter group');
  assert.match(url, /DSQF7/, 'easy-apply attr present');
  assert.match(url, /DGTV2/, 'remote attr present');
});

test('Indeed: 7d tier maps to fromage=7', () => {
  assert.match(buildSearchUrl('indeed', 'dev', 'Toronto', { freshnessSeconds: 604800 }), /fromage=7(?:&|$)/);
});

test('Glassdoor: geography clamps to country when empty', () => {
  const url = buildSearchUrl('glassdoor', 'dev', '', { country: 'Canada' });
  assert.match(url, /locKeyword=Canada/);
});
