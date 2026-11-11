'use strict';

// The demo's feedback page (the server side is demo/feedback.js). The page
// gets a token when it opens; the server only takes a message sent at least
// a few seconds later. The browser only ever hears "Thanks, sent" or
// "Couldn't send, try again later".
(() => {
  const $ = (id) => document.getElementById(id);
  const H = { 'X-Requested-With': 'sentry-six-manager', 'Content-Type': 'application/json' };
  const from = new URLSearchParams(location.search).get('from') || '';
  $('page').value = from.slice(0, 200);
  if (from) $('back').href = from.startsWith('/') && !from.startsWith('//') ? from : '/';
  let token = '';
  const note = (text, ok) => { $('note').textContent = text; $('note').className = `fb-note ${ok ? 'ok' : ok === false ? 'bad' : ''}`; };
  const URLS = /\bhttps?:\/\/\S+/gi;
  $('message').addEventListener('input', () => { $('count').textContent = `${$('message').value.length} / 2000`; });

  fetch('/api/demo/feedback', { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager' } })
    .then((r) => r.json()).then((s) => {
      if (!s.enabled) { $('off').hidden = false; $('form').hidden = true; $('intro').hidden = true; return; }
      token = s.token;
    }).catch(() => note("Couldn't send, try again later", false));

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $('message').value.trim();
    if (!message) { note('Write a message first.', false); return; }
    if (message.replace(URLS, '').replace(/[\s\p{P}\p{S}]/gu, '').length < 2) { note('Add a few words, not only a link.', false); return; }
    $('send').disabled = true;
    try {
      const r = await fetch('/api/demo/feedback', {
        method: 'POST', credentials: 'same-origin', headers: H,
        body: JSON.stringify({ message, contact: $('contact').value.trim(), page: $('page').value.trim(), website: $('website').value, token, device: await window.sentryDemoDevice?.().catch(() => null) })
      });
      const d = await r.json().catch(() => ({}));
      note(d.message || "Couldn't send, try again later", r.ok && d.ok);
      if (r.ok && d.ok) $('message').value = '';
    } catch {
      note("Couldn't send, try again later", false);
    }
    $('send').disabled = false;
  });
})();
