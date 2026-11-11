'use strict';

// The demo's note: what this is, and that changes are off. On a wide screen
// it sits in the sidebar, where it covers nothing; on a phone it shows as a
// pill at the bottom for a few seconds, then folds into a small "Demo" tab
// that opens it again.
(() => {
  // which interface this browser sees (demo/uiSwap.js: the gate says so)
  const UI = document.currentScript?.dataset.ui === 'horizon' ? 'horizon' : 'original';
  const SWAP = UI === 'horizon' ? 'Swap to original UI' : 'Swap to Horizon UI';
  const swapButton = `<button type="button" class="sentry-demo-swap" data-ui="${UI === 'horizon' ? 'original' : 'horizon'}">${SWAP}</button>`;
  const TEXT = '<b>Demo</b> · real highway drives · changes are turned off · visits are logged';
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
    + `<span class="sentry-demo-text">${TEXT}</span>`
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
  wm.innerHTML = 'Not sponsored by <b>LTTSTORE.COM</b> <span class="sentry-demo-wm-arrow" aria-hidden="true">↗</span>';

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
  let timer = null;
  // the main dashboard (original: #/overview, Horizon: #/dashboard): the note stays open there
  const onDash = () => /^#?\/?(overview|dashboard)?$/.test(location.hash.split('?')[0]);
  const fold = (folded) => {
    pill.classList.toggle('folded', folded);
    tab.setAttribute('aria-expanded', String(!folded));
    clearTimeout(timer);
    if (!folded && !onDash()) timer = setTimeout(() => fold(true), 8000);
  };
  // the Viewer (the Original's is the Studio page, /studio/, in a frame): the note starts folded, a small tab on the right edge (demo/banner.css), so it
  // never sits on the playback controls (Play and the timeline are along the bottom there)
  const onViewer = () => /^#\/?(viewer|watch|play)\b/.test(location.hash) || location.pathname.startsWith('/studio/');
  const where = () => pill.classList.toggle('on-viewer', onViewer());
  addEventListener('hashchange', () => {
    where();
    if (onDash()) fold(false);
    else if (onViewer()) fold(true);
    else if (!pill.classList.contains('folded')) fold(false);
  });
  tab.addEventListener('click', () => fold(!pill.classList.contains('folded')));
  pill.querySelector('.sentry-demo-close').addEventListener('click', () => { clearTimeout(timer); pill.classList.add('folded'); tab.setAttribute('aria-expanded', 'false'); });

  const place = () => {
    const side = document.querySelector('.side-card');
    if (side && !side.contains(card)) {
      // above the sidebar's last control (Collapse), or at its end
      const last = side.lastElementChild;
      side.insertBefore(card, last && last.matches('button, .collapse, [data-collapse]') ? last : null);
    }
    if (!document.body.contains(pill)) {
      document.body.appendChild(pill);
      where();
      fold(onViewer());
    }
    if (!document.body.contains(wm)) document.body.appendChild(wm);
    // an interface with no sidebar (Horizon): the pill on every screen
    pill.classList.toggle('free', !document.querySelector('.side-card'));
  };
  // exports are pretend (demo/fakeExport.js): the Download link only says so
  let note = null;
  document.addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[href]');
    if (!a || !/\/api\/exports\/[^/]+\/file(?:$|\?)/.test(a.getAttribute('href') || '')) return;
    e.preventDefault();
    e.stopPropagation();
    if (!note) { note = document.createElement('div'); note.className = 'sentry-demo-toast'; note.setAttribute('role', 'status'); }
    note.textContent = 'Downloads are turned off in the demo. In your own Sentry Six Manager this saves the video.';
    document.body.appendChild(note);
    note.classList.remove('gone');
    clearTimeout(note.t);
    note.t = setTimeout(() => note.classList.add('gone'), 4500);
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', place);
  else place();
  // the shell draws its sidebar after start: place the card once it is there
  new MutationObserver(() => { if (!card.isConnected && document.querySelector('.side-card')) place(); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
