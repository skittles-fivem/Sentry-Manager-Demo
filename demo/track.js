'use strict';

// Visitor activity for the demo's owner page (demo/visitors.js): which pages
// and panels were opened, the labels of the buttons, links and inputs used,
// interface swaps, the device summary, and time with the tab visible
// (a heartbeat about every 15 s). Never what is typed into an input: labels
// only. Batched to POST /api/demo/track, the rest with sendBeacon when the
// page goes away. The demo note says visits are logged.
(() => {
  if (window.sentryDemoTrack) return;
  window.sentryDemoTrack = true;
  const URL_ = '/api/demo/track';
  const UI = document.querySelector('script[data-ui]')?.dataset.ui === 'horizon' ? 'horizon' : 'original';
  const top = window.top === window;
  const queue = [];
  const MAX = 60;

  const send = (beacon) => {
    if (!queue.length) return;
    const events = queue.splice(0, MAX);
    const body = JSON.stringify({ events });
    try {
      // text/plain: no preflight, and sendBeacon can carry it
      if (beacon && navigator.sendBeacon && navigator.sendBeacon(URL_, new Blob([body], { type: 'text/plain' }))) return;
      fetch(URL_, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body }).catch(() => {});
    } catch { /* never in the way */ }
    if (queue.length) send(beacon);
  };
  // what the visitor does reaches the owner page's Live now within a couple of seconds
  let soonTimer = 0;
  const soon = () => { if (!soonTimer) soonTimer = setTimeout(() => { soonTimer = 0; send(false); }, 1200); };
  const add = (e, now) => { queue.push(e); if (queue.length >= 20) send(false); else if (now) soon(); };

  // ---- the page or panel
  const studio = /^\/studio\/(?:index\.html)?$/.test(location.pathname) ? 'studio:viewer' : /^\/studio\/encoder\.html$/.test(location.pathname) ? 'studio:encoder' : null;
  let lastPage = '';
  const page = () => {
    if (studio) return studio;
    const route = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || (UI === 'horizon' ? 'dashboard' : 'overview');
    return `${UI}:${route.toLowerCase().slice(0, 30)}`;
  };
  const here = () => add({ type: 'here', page: page(), visible: document.visibilityState === 'visible' });
  const view = () => {
    const p = page();
    if (p === lastPage) return;
    lastPage = p;
    add({ type: 'view', page: p }, true);
    // the page the visitor is on now (the top page only: an embedded Viewer is part of it)
    if (top) here();
  };
  addEventListener('hashchange', view);
  // a route changed without a hashchange (history.replaceState)
  setInterval(view, 2000);

  // ---- controls used: their label, never their value
  const text = (n) => (n?.innerText || n?.textContent || '').replace(/\s+/g, ' ').trim();
  function labelOf(c) {
    const aria = c.getAttribute('aria-label') || '';
    if (aria) return aria;
    if (c.matches('input, select, textarea')) {
      const type = (c.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return c.value || type;
      const lab = (c.id && document.querySelector(`label[for="${CSS.escape(c.id)}"]`)) || c.closest('label');
      // a label's own text without the input's (a select's options are in it)
      if (lab) { const copy = lab.cloneNode(true); for (const x of copy.querySelectorAll('input, select, textarea, option')) x.remove(); if (text(copy)) return text(copy); }
      return c.getAttribute('placeholder') || c.getAttribute('title') || c.getAttribute('name') || type || c.tagName.toLowerCase();
    }
    return text(c) || c.getAttribute('title') || c.getAttribute('data-route') || '';
  }
  const kindOf = (c) => (c.matches('a') ? 'link' : c.matches('select') ? 'select' : c.matches('input, textarea') ? (['button', 'submit', 'reset'].includes((c.getAttribute('type') || '').toLowerCase()) ? 'button' : 'input') : c.matches('[role="tab"]') ? 'tab' : 'button');
  document.addEventListener('click', (e) => {
    const c = e.target?.closest?.('button, a, input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"]');
    if (!c) return;
    const label = labelOf(c).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (label) add({ type: 'click', kind: kindOf(c), label }, true);
    const swap = c.closest('.sentry-demo-swap');
    if (swap) { add({ type: 'swap', to: swap.dataset.ui === 'horizon' ? 'horizon' : 'original' }); send(false); }
  }, true);

  // ---- time with the tab visible (the top page only: an embedded Viewer is part of it)
  let since = top && document.visibilityState === 'visible' ? Date.now() : 0;
  let held = 0;
  const take = () => {
    if (since) { held += Date.now() - since; since = document.visibilityState === 'visible' ? Date.now() : 0; }
    const ms = held;
    held = 0;
    return ms;
  };
  const beat = () => { const ms = take(); if (ms > 500) add({ type: 'beat', ui: UI, ms }); };
  if (top) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { if (!since) since = Date.now(); } else { beat(); send(true); }
    });
    // "still here", for the owner page's Live now (also from a hidden tab: the browser may slow it to once a minute)
    setInterval(() => { beat(); here(); send(false); }, 15_000);
    setTimeout(() => { here(); send(false); }, 1500);
  }
  addEventListener('pagehide', () => { if (top) { beat(); add({ type: 'leave' }); } send(true); });

  // ---- start: the page, the device once per tab
  view();
  if (top) {
    let sent = false;
    try { sent = sessionStorage.getItem('sentry-demo-dev') === '1'; } catch { /* no storage */ }
    if (!sent && typeof window.sentryDemoDevice === 'function') {
      window.sentryDemoDevice().then((d) => {
        if (d) add({ type: 'device', device: { os: d.os, browser: d.browser, model: d.model, touch: d.touch } });
        try { sessionStorage.setItem('sentry-demo-dev', '1'); } catch { /* no storage */ }
        send(false);
      }).catch(() => {});
    } else send(false);
  } else send(false);
})();
