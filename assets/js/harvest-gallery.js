/* Public data contains only approved artwork and the responder form link. */
(async function () {
  const grid = document.querySelector('#player-gallery');
  const empty = document.querySelector('#gallery-empty');
  try {
    const response = await fetch('assets/data/harvest-gallery.json');
    if (!response.ok) throw new Error('Gallery unavailable');
    const data = await response.json();
    if (typeof data.submissionFormUrl === 'string' && data.submissionFormUrl) {
      const form = new URL(data.submissionFormUrl);
      const valid = form.protocol === 'https:' && ((form.hostname === 'docs.google.com' && form.pathname.startsWith('/forms/') && form.pathname.endsWith('/viewform')) || form.hostname === 'forms.gle');
      if (valid) {
        const link = document.querySelector('#creation-form-link');
        const agreement = document.querySelector('#gallery-agreement');
        const updateAgreement = () => {
          link.setAttribute('aria-disabled', String(!agreement.checked));
          link.tabIndex = agreement.checked ? 0 : -1;
          if (agreement.checked) link.href = form.href;
          else link.removeAttribute('href');
        };
        agreement.addEventListener('change', updateAgreement);
        window.addEventListener('pageshow', updateAgreement);
        link.addEventListener('click', event => {
          if (!agreement.checked) { event.preventDefault(); agreement.focus(); }
        });
        updateAgreement();
        link.hidden = false;
        document.querySelector('#upload-unavailable').hidden = true;
      }
    }
    for (const entry of data.creations || []) {
      // Public images live with the site, never in a public submission folder.
      if (!/^assets\/img\/[a-zA-Z0-9_-]+\.(webp|jpg|jpeg|png)$/.test(entry.image)) continue;
      const article = document.createElement('article'); article.className = 'card';
      const image = document.createElement('img'); image.src = entry.image; image.alt = entry.alt || entry.title; image.loading = 'lazy';
      const body = document.createElement('div'); body.className = 'card-body';
      const title = document.createElement('h3'); title.textContent = entry.title;
      const credit = document.createElement('p'); credit.textContent = 'Grown by ' + entry.credit;
      const description = document.createElement('p'); description.textContent = entry.description || '';
      body.append(title, credit, description); article.append(image, body); grid.append(article);
    }
    empty.hidden = grid.children.length > 0;
  } catch {
    empty.querySelector('h3').textContent = 'The gallery is taking a breather.';
    empty.querySelector('p').textContent = 'Please try again shortly.';
  }
})();
