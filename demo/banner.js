'use strict';

// The demo's note: what this is, and that changes are off. On a wide screen
// it sits in the sidebar, where it covers nothing; on a phone it shows as a
// pill at the bottom for a few seconds, then folds into a small "Demo" tab
// that opens it again.
(() => {
  // which interface this browser sees (demo/uiSwap.js: the gate says so)
  const UI = document.currentScript?.dataset.ui === 'horizon' ? 'horizon' : 'original';
  const SWAP = UI === 'horizon' ? 'Swap to original UI' : 'Swap to Horizon UI';
  // Each interface names a few pages its own way (Horizon's home is #/dashboard,
  // Sentry Six's #/overview): a page name from the other one, after a swap or
  // from an old link, becomes this one's before the page draws, never "Page not found"
  const RAW_UI = document.currentScript?.dataset.ui || 'original';
  const SAME_PAGE = RAW_UI === 'horizon'
    ? { overview: 'dashboard', notifications: 'alerts', activity: 'jobs' }
    : RAW_UI === 'original' ? { dashboard: 'overview', alerts: 'notifications' } : {};
  const samePage = () => {
    if (window.top !== window) return;
    const m = /^#\/?([\w-]+)(.*)$/.exec(location.hash);
    if (m && SAME_PAGE[m[1]]) history.replaceState(null, '', `${location.pathname}${location.search}#/${SAME_PAGE[m[1]]}${m[2]}`);
  };
  samePage();
  addEventListener('hashchange', samePage);
  const swapButton = `<button type="button" class="sentry-demo-swap" data-ui="${UI === 'horizon' ? 'original' : 'horizon'}" aria-label="${SWAP}"><span class="sentry-demo-swap-to">Swap to </span><span class="sentry-demo-swap-name">${SWAP.replace(/^Swap to /, '')}</span></button>`;
  const TEXT = '<b>Demo</b> · real highway drives · changes are turned off · visits are logged';
  // the pill already starts with its own "Demo" tab: the rest without a leading dot
  const PILL_TEXT = 'Real highway drives · changes are turned off · visits are logged';
  const LINK = 'https://github.com/skittles-fivem/Sentry-Manager';

  const card = document.createElement('div');
  card.className = 'sentry-demo-card';
  card.setAttribute('role', 'note');
  card.innerHTML = `<span class="sentry-demo-dot" aria-hidden="true"></span><span class="sentry-demo-text">${TEXT}</span>`
    + `<a class="sentry-demo-link" href="${LINK}" target="_blank" rel="noopener">Get Sentry Six Manager</a>`
    + swapButton
    + '<a class="sentry-demo-feedback" href="/demo/feedback">Send feedback</a>';

  const pill = document.createElement('div');
  pill.className = 'sentry-demo-note';
  pill.setAttribute('role', 'note');
  pill.innerHTML = '<button type="button" class="sentry-demo-tab" aria-expanded="true" aria-label="About this demo"><span class="sentry-demo-dot" aria-hidden="true"></span><b>Demo</b></button>'
    + `<span class="sentry-demo-text">${PILL_TEXT}</span>`
    + swapButton
    + `<a class="sentry-demo-link" href="${LINK}" target="_blank" rel="noopener">Get it</a>`
    + '<a class="sentry-demo-feedback" href="/demo/feedback">Feedback</a>'
    + '<button type="button" class="sentry-demo-close" aria-label="Fold the demo note">×</button>';
  // the watermark, bottom right on every page
  const wm = document.createElement('a');
  wm.className = 'sentry-demo-wm';
  wm.href = 'https://www.lttstore.com/';
  wm.target = '_blank';
  wm.rel = 'noopener noreferrer';
  wm.innerHTML = 'Not sponsored by <b>LTTSTORE.COM</b>&nbsp;<span class="sentry-demo-wm-arrow" aria-hidden="true">↗</span>';

  const tab = pill.querySelector('.sentry-demo-tab');
  // this browser only: a cookie, then the page again in the other interface
  for (const b of [card, pill].map((n) => n.querySelector('.sentry-demo-swap'))) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await fetch('/demo/ui', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' }, body: JSON.stringify({ ui: b.dataset.ui }) });
        if (r.ok) { location.reload(); return; }
      } catch { /* try again */ }
      b.disabled = false;
    });
  }
  // Feedback: a pop-up over the page (the form at /demo/feedback without it)
  const H = { 'X-Requested-With': 'sentry-six-manager', 'Content-Type': 'application/json' };
  const FAILED = "Couldn't send, try again later";
  let dialog = null;
  function openFeedback() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'sentry-demo-fb';
      dialog.innerHTML = '<form method="dialog" novalidate>'
        + '<div class="sentry-demo-fb-head"><b>Feedback</b><button type="button" class="sentry-demo-fb-x" aria-label="Close">×</button></div>'
        + '<p class="sentry-demo-fb-intro">What worked, what didn\'t, what you\'d want. It goes to the person who runs this demo, with your IP address and your device\'s details (OS, browser, screen, graphics) to help track down bugs.</p>'
        + '<label>Your message<textarea name="message" rows="6" maxlength="2000" required></textarea></label>'
        + '<label>Name or contact <span>(optional)</span><input name="contact" maxlength="100" autocomplete="off"></label>'
        + '<div class="sentry-demo-fb-hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>'
        + '<p class="sentry-demo-fb-note" role="status" aria-live="polite"></p>'
        + '<div class="sentry-demo-fb-actions"><button type="submit" class="sentry-demo-fb-send">Send</button><button type="button" class="sentry-demo-fb-cancel">Close</button></div>'
        + '</form>';
      document.body.appendChild(dialog);
      const f = dialog.querySelector('form');
      const note = (t, ok) => { const n = dialog.querySelector('.sentry-demo-fb-note'); n.textContent = t; n.className = `sentry-demo-fb-note ${ok ? 'ok' : ok === false ? 'bad' : ''}`; };
      for (const b of dialog.querySelectorAll('.sentry-demo-fb-x, .sentry-demo-fb-cancel')) b.addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = f.message.value.trim();
        if (!message) { note('Write a message first.', false); return; }
        const send = dialog.querySelector('.sentry-demo-fb-send');
        send.disabled = true;
        try {
          const device = await window.sentryDemoDevice?.().catch(() => null);
          const r = await fetch('/api/demo/feedback', { method: 'POST', credentials: 'same-origin', headers: H,
            body: JSON.stringify({ message, contact: f.contact.value.trim(), page: (location.pathname + location.hash).slice(0, 200), website: f.website.value, token: dialog.dataset.token || '', device }) });
          const d = await r.json().catch(() => ({}));
          note(d.message || FAILED, r.ok && d.ok);
          if (r.ok && d.ok) f.message.value = '';
        } catch { note(FAILED, false); }
        send.disabled = false;
      });
    }
    dialog.querySelector('.sentry-demo-fb-note').textContent = '';
    // a fresh token each time it opens (the server wants a few seconds before sending)
    fetch('/api/demo/feedback', { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager' } })
      .then((r) => r.json()).then((s) => {
        if (!s.enabled) { dialog.querySelector('.sentry-demo-fb-note').textContent = 'Feedback is off on this demo.'; return; }
        dialog.dataset.token = s.token;
      }).catch(() => {});
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('textarea').focus();
  }
  for (const a of [card, pill].map((n) => n.querySelector('.sentry-demo-feedback'))) {
    a.addEventListener('click', (e) => {
      if (typeof HTMLDialogElement !== 'function') { a.href = `/demo/feedback?from=${encodeURIComponent((location.pathname + location.hash).slice(0, 200))}`; return; }
      e.preventDefault();
      openFeedback();
    });
  }
  // In a page inside another (the Viewer the interfaces embed) the outer page
  // already has the note and the watermark: here they would sit on the
  // playback controls.
  const embedded = window.top !== window;
  let timer = null;
  // the main dashboard (original: #/overview, Horizon: #/dashboard): the note stays open there
  const onDash = () => /^#?\/?(overview|dashboard)?$/.test(location.hash.split('?')[0]);
  const fold = (folded) => {
    pill.classList.toggle('folded', folded);
    tab.setAttribute('aria-expanded', String(!folded));
    clearTimeout(timer);
    // on a phone the open note covers the page, so it folds on the dashboard too
    const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
    if (!folded && (!onDash() || phone)) timer = setTimeout(() => fold(true), 8000);
  };
  // the Viewer: its playback controls run along the bottom, so the note starts
  // folded there and the watermark goes in the sidebar's demo card (or, with no
  // card showing, stays off that page) instead of over the controls
  const onViewer = () => /^#\/?(viewer|watch|play)\b/.test(location.hash) || location.pathname.startsWith('/studio/');
  const placeWm = () => {
    if (embedded) return;
    pill.classList.toggle('on-viewer', onViewer());
    const inCard = onViewer() && card.isConnected && card.offsetParent !== null;
    wm.classList.toggle('in-card', inCard);
    if (inCard) { if (wm.previousElementSibling !== card) card.after(wm); }
    else if (onViewer()) wm.remove();
    else if (wm.parentElement !== document.body) document.body.appendChild(wm);
  };
  addEventListener('hashchange', () => {
    if (onViewer()) fold(true);
    else if (onDash()) fold(false);
    else if (!pill.classList.contains('folded')) fold(false);
    placeWm();
  });
  addEventListener('resize', () => placeWm());
  // the sidebar collapsed or opened: the card shows or not
  if (!embedded) setInterval(() => { if (onViewer() || wm.classList.contains('in-card')) placeWm(); }, 1000);
  tab.addEventListener('click', () => fold(!pill.classList.contains('folded')));
  pill.querySelector('.sentry-demo-close').addEventListener('click', () => { clearTimeout(timer); pill.classList.add('folded'); tab.setAttribute('aria-expanded', 'false'); });

  const place = () => {
    if (embedded) return;
    const side = document.querySelector('.side-card');
    if (side && !side.contains(card)) {
      // above the sidebar's last control (Collapse), or at its end
      const last = side.lastElementChild;
      side.insertBefore(card, last && last.matches('button, .collapse, [data-collapse]') ? last : null);
    }
    if (!document.body.contains(pill)) {
      document.body.appendChild(pill);
      fold(onViewer());
    }
    placeWm();
    // an interface with no sidebar (Horizon): the pill on every screen
    pill.classList.toggle('free', !document.querySelector('.side-card'));
  };
  // Settings > "Use this interface": this browser only, straight away, with no
  // password (the app's page asks for one before it sends the change; the
  // demo's server makes the change for this browser alone: demo/uiSwap.js)
  document.addEventListener('click', (e) => {
    const b = e.target?.closest?.('button[data-pack]');
    if (!b || b.disabled) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    b.disabled = true;
    fetch('/api/ui-packs/active', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' }, body: JSON.stringify({ id: b.dataset.pack || null }) })
      .then((r) => { if (r.ok) location.reload(); else b.disabled = false; })
      .catch(() => { b.disabled = false; });
  }, true);
  // No downloads on the demo: a link that saves a file (a download link, a
  // file made in the page, or one of the app's download addresses) only says
  // so. The server refuses them too (demo/preload.js: a response sent as a
  // file comes back empty).
  const DL = /\/api\/(?:exports\/[^/]+\/file|logs\/download|logs\/archive\/|support-bundle|security\/ca\.crt|stats\/export|can\/files\/|can\/export|ui-packs\/[^/]+\.zip)|[?&]download=1/;
  const isDownload = (a) => a.hasAttribute('download') || /^(?:blob|data):/i.test(a.getAttribute('href') || '') || DL.test(a.getAttribute('href') || '');
  let note = null;
  const noDownload = () => {
    if (!note) { note = document.createElement('div'); note.className = 'sentry-demo-toast'; note.setAttribute('role', 'status'); }
    note.textContent = 'Downloads are turned off in the demo. In your own Sentry Six Manager this saves the file.';
    document.body.appendChild(note);
    note.classList.remove('gone');
    clearTimeout(note.t);
    note.t = setTimeout(() => note.classList.add('gone'), 4500);
  };
  document.addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[href]');
    if (!a || !isDownload(a)) return;
    e.preventDefault();
    e.stopPropagation();
    noDownload();
  }, true);
  // a file link clicked from a script without being in the page
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function demoClick() {
    if (this.getAttribute('href') && isDownload(this)) { noDownload(); return; }
    return click.call(this);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { place(); fitViewer(); });
  else { place(); fitViewer(); }
  // The Viewer (Sentry Studio): its car-data bar lies over the cameras, at
  // the bottom. At any window size and display scaling, the cameras end above
  // the bar instead, and the Clips panel ends above it too, so the bar covers
  // neither. Nothing changes while the bar is hidden, floating or moved, or
  // when the window is too short to leave the cameras room (then as before).
  function fitViewer() {
    const box = document.getElementById('videoContainer');
    const grid = document.getElementById('multiCamGrid');
    if (!box || !grid || fitViewer.on) return;
    fitViewer.on = true;
    const clips = () => document.getElementById('clipBrowser');
    let raf = 0;
    let last = '';
    const clear = () => {
      if (last === '') return;
      last = '';
      grid.style.removeProperty('bottom');
      grid.classList.remove('sentry-demo-fit');
      if (clips()?.style.getPropertyValue('max-height')) clips().style.removeProperty('max-height');
    };
    const fit = () => {
      raf = 0;
      const bar = [...box.children].find((n) => n.classList?.contains('sentry-sd') && n.classList.contains('over') && !n.classList.contains('sd-listpanel'));
      if (!bar || !bar.offsetHeight || getComputedStyle(bar).display === 'none') return clear();
      const b = bar.getBoundingClientRect();
      const c = box.getBoundingClientRect();
      const room = Math.ceil(c.bottom - b.top + 6);
      // a bar dragged up, or a window with too little left for the cameras: as it was
      if (room <= 0 || room > c.height * 0.6 || c.height - room < 140) return clear();
      const key = `${room}`;
      if (key !== last) { last = key; grid.classList.add('sentry-demo-fit'); grid.style.setProperty('bottom', `${room}px`, 'important'); }
      const cb = clips();
      if (cb && cb.offsetHeight) {
        const top = cb.getBoundingClientRect().top;
        const max = Math.floor(b.top - top - 8);
        const want = max > 120 ? `${max}px` : '';
        if (cb.style.getPropertyValue('max-height') !== want) {
          if (want) { cb.style.setProperty('max-height', want, 'important'); cb.style.overflowY = 'auto'; } else cb.style.removeProperty('max-height');
        }
      }
    };
    const soon = () => { if (!raf) raf = requestAnimationFrame(fit); };
    new ResizeObserver(soon).observe(box);
    new MutationObserver((list) => { if (list.some((m) => m.target !== grid && !grid.contains(m.target))) soon(); })
      .observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    addEventListener('resize', soon);
    soon();
  }
  // An interface with a bar fixed along the bottom of a phone (Sentry Six's
  // #phone-nav): the watermark and the note sit above it instead of on its
  // buttons, the folded note as a small pill on the right; on a wide screen
  // the note sits just right of its sidebar
  function aboveBottomBar() {
    if (embedded || aboveBottomBar.on) return;
    const BARS = '#phone-nav, #dock, #tabbar'; // Sentry Six's phone bar, Aurora's dock, Daylight's phone tab bar
    const SIDES = '#sidebar, aside.side, #side'; // Sentry Six's, Daylight's and Flux's sidebars
    if (!document.querySelector(BARS) && !document.querySelector(SIDES)) return;
    aboveBottomBar.on = true;
    const root = document.documentElement;
    const shownFixed = (n) => {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && (cs.position === 'fixed' || cs.position === 'sticky') && r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth;
    };
    const fit = () => {
      const bar = [...document.querySelectorAll(BARS)].find((n) => shownFixed(n) && innerHeight - n.getBoundingClientRect().bottom < 60);
      root.classList.toggle('sentry-demo-bottombar', Boolean(bar));
      if (bar) root.style.setProperty('--sentry-demo-bar', `${Math.round(innerHeight - bar.getBoundingClientRect().top)}px`);
      // a wide screen: the note just right of the sidebar, off its links
      const side = [...document.querySelectorAll(SIDES)].find((n) => { const r = n.getBoundingClientRect(); return !bar && r.left <= 1 && r.right > 40 && r.height > innerHeight * 0.6 && getComputedStyle(n).display !== 'none'; });
      root.classList.toggle('sentry-demo-sidebar', Boolean(side));
      if (side) root.style.setProperty('--sentry-demo-side', `${Math.round(side.getBoundingClientRect().right)}px`);
    };
    for (const n of document.querySelectorAll(`${BARS}, ${SIDES}`)) new ResizeObserver(fit).observe(n);
    addEventListener('resize', fit);
    setTimeout(fit, 1500);
    fit();
  }
  // the shell draws its sidebar after start: place the card once it is there
  new MutationObserver(() => { if (!card.isConnected && document.querySelector('.side-card')) place(); if (!aboveBottomBar.on) aboveBottomBar(); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
