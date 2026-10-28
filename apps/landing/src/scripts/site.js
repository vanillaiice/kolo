/* Enhancement only: every page, download and screenshot works without JavaScript. */
import { detectPlatform } from '../lib/platform.mjs';

/** Groups that fade in as they scroll into view; items in one group follow each other briefly. */
const revealGroups = ['.section-heading', '.features', '.gallery', '.offline-items', '.download-grid', '.developer-layout', '.promoters', '.faq', '.post-list'];

/**
 * Fade in content below the fold. Only content the visitor has not seen yet is hidden, and
 * nothing is when motion is reduced, the observer is missing, or the script never runs.
 */
function revealOnScroll() {
  if (!window.IntersectionObserver || !matchMedia('(prefers-reduced-motion: no-preference)').matches) return;
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('revealed');
    observer.unobserve(entry.target);
    // Drop the stagger once shown so hover effects respond at once.
    setTimeout(() => entry.target.style.removeProperty('--reveal-delay'), 1000);
  }), { rootMargin: '0px 0px -8% 0px' });
  for (const group of document.querySelectorAll(revealGroups.join(','))) {
    const items = group.matches('.section-heading,.developer-layout,.promoters,.faq') ? [group] : [...group.children];
    items.forEach((item, i) => {
      if (item.getBoundingClientRect().top < innerHeight) return;
      item.dataset.reveal = '';
      // CSSOM changes are allowed by the CSP; style attributes in the markup are not.
      item.style.setProperty('--reveal-delay', `${Math.min(i, 5) * 70}ms`);
      observer.observe(item);
    });
  }
}

(() => {
  let savedLanguage;
  try { savedLanguage = localStorage.getItem('kolo-landing-language'); } catch { /* Storage can be disabled. */ }
  if (document.body.hasAttribute('data-language-entry')) {
    const lang = ['en', 'fr'].includes(savedLanguage) ? savedLanguage
      : (navigator.languages ?? [navigator.language]).some(value => value?.toLowerCase().startsWith('fr')) ? 'fr' : 'en';
    location.replace(`${lang}/${location.search}${location.hash}`);
    return;
  }
  document.querySelectorAll('.languages a').forEach(link => {
    link.addEventListener('click', () => {
      try { localStorage.setItem('kolo-landing-language', link.lang); } catch { /* Optional preference. */ }
      link.hash = location.hash;
    });
  });
  const reset = document.querySelector('[data-reset-language]');
  if (reset) {
    reset.hidden = false;
    reset.addEventListener('click', () => {
      const status = document.querySelector('[data-storage-status]');
      try {
        localStorage.removeItem('kolo-landing-language');
        status.textContent = reset.dataset.success;
      } catch { status.textContent = reset.dataset.error; }
    });
  }
  const downloads = document.querySelector('[data-suggested]');
  if (downloads) {
    // Read once to suggest a card; never stored or sent anywhere.
    const platform = detectPlatform({ userAgent: navigator.userAgent, userAgentData: navigator.userAgentData, maxTouchPoints: navigator.maxTouchPoints });
    const card = downloads.querySelector(`[data-platform="${platform}"]`);
    if (card) {
      card.classList.add('suggested');
      const badge = document.createElement('span');
      badge.className = 'suggested-badge';
      badge.textContent = downloads.dataset.suggested;
      card.prepend(badge);
      const hero = document.querySelector('[data-download-for]');
      const label = hero?.firstChild;
      if (label?.nodeType === Node.TEXT_NODE) label.textContent = hero.dataset.downloadFor.replace('{platform}', card.querySelector('h3').textContent);
    } else {
      const note = document.querySelector(`[data-platform-note="${platform}"]`);
      if (note) note.hidden = false;
    }
  }
  revealOnScroll();
  const dialog = document.querySelector('.lightbox');
  if (!dialog?.showModal) return;
  let trigger;
  const close = () => dialog.close();
  dialog.querySelector('button').addEventListener('click', close);
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('close', () => { trigger?.focus(); });
  document.querySelectorAll('.screenshot-link').forEach(link => {
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      trigger = link;
      const picture = dialog.querySelector('img');
      picture.src = link.href;
      picture.alt = link.dataset.caption;
      dialog.querySelector('p').textContent = link.dataset.caption;
      dialog.showModal();
    });
  });
})();
