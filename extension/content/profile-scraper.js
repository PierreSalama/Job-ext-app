// Source-profile scrapers. Activated on profile pages of supported sources
// (LinkedIn /in/ / Indeed /career-services / Glassdoor /member/profile).
// Returns a partial profile shape that the user can review and import as a
// named profile assigned to that source.

import { text, find, firstText } from './adapters/base.js';

export const PROFILE_SCRAPERS = {
  linkedin: {
    matches: (url) => /^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(url),
    isOwnProfile: () => Boolean(document.querySelector('a[href*="/in/me/"]') || document.querySelector('button[aria-label*="Edit intro" i]')),
    scrape() {
      const root = document;
      const name = firstText([
        'h1.text-heading-xlarge', 'h1.top-card-layout__title', 'h1[class*="hero"]', 'h1'
      ], root);
      const headline = firstText([
        '.text-body-medium.break-words', 'div.top-card-layout__headline', 'h2.top-card-layout__headline', '[data-anonymize="headline"]'
      ], root);
      const location = firstText([
        '.text-body-small.inline.t-black--light.break-words',
        '.top-card__subline-item:not(:last-child)',
        '[data-anonymize="location"]'
      ], root);
      // About / summary
      const about = firstText([
        'section[id*="about"] [class*="display-flex full-width"] span[aria-hidden="true"]',
        'section[id*="about"] .pv-shared-text-with-see-more',
        'section.summary .pv-about__summary-text'
      ], root);
      // Headline-derived years experience: just leave blank, user can edit
      // Experience top entry
      const experiences = Array.from(root.querySelectorAll('section[id*="experience"] li, .experience-item, .experience-section li'))
        .slice(0, 8)
        .map((li) => {
          const title = firstText(['span[aria-hidden="true"]', '.t-bold', '.experience-item__title'], li);
          const company = firstText(['span[class*="t-14"][class*="t-normal"] span[aria-hidden="true"]', '.experience-item__subtitle', '.pv-entity__secondary-title'], li);
          const dates = firstText(['.experience-item__date-range', '.pv-entity__date-range span:nth-child(2)', 'span[class*="date"]'], li);
          return { title, company, dates };
        }).filter((e) => e.title);
      const education = Array.from(root.querySelectorAll('section[id*="education"] li, .education-item'))
        .slice(0, 5)
        .map((li) => {
          const school = firstText(['span[aria-hidden="true"]', '.t-bold', '.education-item__school'], li);
          const degree = firstText(['span[class*="t-14"] span[aria-hidden="true"]', '.education-item__degree-info'], li);
          return { school, degree };
        }).filter((e) => e.school);
      const skills = Array.from(root.querySelectorAll('section[id*="skills"] li span[aria-hidden="true"], .skill-pill, .pv-skill-category-entity__name-text'))
        .slice(0, 30)
        .map((el) => text(el))
        .filter(Boolean);
      // Compute years experience from earliest experience year
      let yearsExperience = '';
      try {
        const allYears = experiences.map((e) => {
          const m = String(e.dates || '').match(/(19|20)\d{2}/);
          return m ? Number(m[0]) : null;
        }).filter(Boolean);
        if (allYears.length) {
          const earliest = Math.min(...allYears);
          yearsExperience = String(Math.max(0, new Date().getFullYear() - earliest));
        }
      } catch {}
      const [first, ...rest] = (name || '').split(/\s+/);
      return {
        firstName: first || '',
        lastName: rest.join(' ') || '',
        fullName: name || '',
        headline: headline || '',
        city: (location || '').split(',')[0]?.trim() || '',
        country: ((location || '').split(',').pop() || '').trim() || '',
        summary: about || '',
        yearsExperience,
        skills,
        linkedinUrl: location.href || window.location.href,
        _experience: experiences,
        _education: education,
        _source: 'LinkedIn'
      };
    }
  },

  indeed: {
    matches: (url) => /^https?:\/\/(www\.|profile\.|my\.)?indeed\.com\/(profile|p\/)/i.test(url),
    isOwnProfile: () => true, // Indeed only shows your own profile under /profile
    scrape() {
      const name = firstText(['h1[data-testid="resume-header-name"]', 'h1.profile-name', 'h1']);
      const headline = firstText(['[data-testid="resume-header-current-position"]', '.headline']);
      const loc = firstText(['[data-testid="resume-header-location"]', '.location']);
      const summary = firstText(['[data-testid="summary-section-content"]', '.summary-section .text']);
      const skills = Array.from(document.querySelectorAll('[data-testid="skill-pill"], .skill-pill, .pp-skill'))
        .map(text).filter(Boolean).slice(0, 30);
      const experiences = Array.from(document.querySelectorAll('[data-testid="work-experience-item"], .work-experience-item'))
        .slice(0, 8)
        .map((li) => ({
          title: firstText(['[data-testid="work-experience-title"]', '.title'], li),
          company: firstText(['[data-testid="work-experience-company"]', '.company'], li),
          dates: firstText(['[data-testid="work-experience-dates"]', '.dates'], li)
        })).filter((e) => e.title);
      const [first, ...rest] = (name || '').split(/\s+/);
      return {
        firstName: first || '',
        lastName: rest.join(' ') || '',
        fullName: name || '',
        headline: headline || '',
        city: (loc || '').split(',')[0]?.trim() || '',
        country: ((loc || '').split(',').pop() || '').trim() || '',
        summary,
        skills,
        _experience: experiences,
        _source: 'Indeed'
      };
    }
  },

  glassdoor: {
    matches: (url) => /^https?:\/\/(www\.)?glassdoor\.[^/]+\/member\/profile/i.test(url),
    isOwnProfile: () => true,
    scrape() {
      const name = firstText(['.profile-name', 'h1']);
      const headline = firstText(['.profile-headline', '.headline']);
      const loc = firstText(['.profile-location', '.location']);
      const [first, ...rest] = (name || '').split(/\s+/);
      return {
        firstName: first || '',
        lastName: rest.join(' ') || '',
        fullName: name || '',
        headline: headline || '',
        city: (loc || '').split(',')[0]?.trim() || '',
        _source: 'Glassdoor'
      };
    }
  }
};

// Pick the right scraper for the current URL.
export function pickProfileScraper() {
  const url = location.href;
  for (const [id, s] of Object.entries(PROFILE_SCRAPERS)) {
    if (s.matches(url)) return { id, ...s };
  }
  return null;
}
