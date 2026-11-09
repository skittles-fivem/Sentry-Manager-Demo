'use strict';

// The demo's note: what this is, and that changes are off. On a wide screen
// it sits in the sidebar, where it covers nothing; on a phone it shows as a
// pill at the bottom for a few seconds, then folds into a small "Demo" tab
// that opens it again.
(() => {
  const TEXT = '<b>Demo</b> · real highway drives · changes are turned off';
  const LINK = 'https://github.com/skittles-fivem/Sentry-Manager';

  const card = document.createElement('div');
  card.className = 'sentry-demo-card';
  card.setAttribute('role', 'note');
  card.innerHTML = `<span class="sentry-demo-dot" aria-hidden="true"></span><span class="sentry-demo-text">${TEXT}</span>`
    + `<a class="sentry-demo-link" href="${LINK}" target="_blank" rel="noopener">Get Sentry Six Manager</a>`;

  const pill = document.createElement('div');
  pill.className = 'sentry-demo-note';
  pill.setAttribute('role', 'note');
  pill.innerHTML = '<button type="button" class="sentry-demo-tab" aria-expanded="true" aria-label="About this demo"><span class="sentry-demo-dot" aria-hidden="true"></span><b>Demo</b></button>'
    + `<span class="sentry-demo-text">${TEXT}</span>`
    + `<a class="sentry-demo-link" href="${LINK}" target="_blank" rel="noopener">Get it</a>`
    + '<button type="button" class="sentry-demo-close" aria-label="Fold the demo note">×</button>';
  const tab = pill.querySelector('.sentry-demo-tab');
  let timer = null;
  const fold = (folded) => {
    pill.classList.toggle('folded', folded);
    tab.setAttribute('aria-expanded', String(!folded));
    clearTimeout(timer);
    if (!folded) timer = setTimeout(() => fold(true), 8000);
  };
  tab.addEventListener('click', () => fold(!pill.classList.contains('folded')));
  pill.querySelector('.sentry-demo-close').addEventListener('click', () => fold(true));

  const place = () => {
    const side = document.querySelector('.side-card');
    if (side && !side.contains(card)) {
      // above the sidebar's last control (Collapse), or at its end
      const last = side.lastElementChild;
      side.insertBefore(card, last && last.matches('button, .collapse, [data-collapse]') ? last : null);
    }
    if (!document.body.contains(pill)) {
      document.body.appendChild(pill);
      fold(false);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', place);
  else place();
  // the shell draws its sidebar after start: place the card once it is there
  new MutationObserver(() => { if (!card.isConnected && document.querySelector('.side-card')) place(); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
