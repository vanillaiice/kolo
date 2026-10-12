/* Enhancement only: every page, download and screenshot works without JavaScript. */
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
