'use strict';

// The demo's owner page (demo/owner.js on the server). Every string from the
// attack log was typed by someone on the internet: it only ever goes into
// text nodes, never into HTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else n.setAttribute(k, v);
    }
    for (const k of kids) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  };
  const KIND = { 'owner-probe': 'Owner probe', scan: 'Scanner', exploit: 'Exploit', refused: 'Refused write', 'rate-limit': 'Rate limit', login: 'Wrong password', spam: 'Feedback spam', malformed: 'Malformed', ban: 'Ban' };
  const TONE = { exploit: 'red', ban: 'red', 'owner-probe': 'amber', login: 'amber', scan: 'blue', 'rate-limit': 'violet', spam: 'violet', refused: 'slate', malformed: 'slate' };
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : '-');
  const gb = (n) => (n == null ? '-' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
  const GROUPS_SHOWN = 50;
  const ENTRIES_SHOWN = 12;
  let sort = 'newest';
  let shown = GROUPS_SHOWN;

  async function call(method, url, body, raw) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'sentry-six-manager', ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}) },
      body: raw || (body ? JSON.stringify(body) : undefined)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status, data });
    return data;
  }
  const query = () => {
    const q = new URLSearchParams();
    if ($('kind').value) q.set('kind', $('kind').value);
    q.set('sort', sort);
    return q.toString();
  };
  const kv = (dl, rows) => dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v ?? '-')]));

  function render(s) {
    $('you').textContent = `You are at ${s.you}. Addresses are the real client's (Cloudflare-aware).`;
    const st = s.stats || {};
    const tiles = [[s.visitors.today, 'visitors today'], [st.addresses || 0, 'addresses in the log'], [st.last24h || 0, 'seen in the log in 24 h'], [s.bans.length, 'bans in force'], [st.rows || 0, 'log rows (5,000 at most)']];
    $('tiles').replaceChildren(...tiles.map(([n, label]) => el('div', { class: 'tile' }, el('b', {}, n), el('span', {}, label))));
    const days = Object.entries(s.visitors.days || {}).sort().slice(-7).map(([d, n]) => `${d.slice(5)}: ${n}`).join(' · ');
    const su = s.demo.sentryUsb;
    kv($('demo'), [
      ['Resets every', s.demo.resetHours ? `${s.demo.resetHours} h` : 'only on restart'],
      ['Kept across resets', s.demo.stateKept ? `yes (${s.demo.stateDir})` : 'no: mount the /demo-state volume (the log, bans and certificates are lost at each reset)'],
      ['Visitors, 7 days', days || '-'],
      ['Sentry USB', su ? `info for ${su.cars.join(', ') || 'no cars yet'}` : 'off'],
      ['Feedback', s.demo.feedback ? 'on (Discord)' : 'off (DEMO_FEEDBACK_WEBHOOK not set)']
    ]);
    $('reset').disabled = !s.demo.resetAvailable;
    const t = s.tls || {};
    kv($('cert'), [
      ['Source', t.source], ['Issuer', t.issuer], ['Names', (t.names || []).join(', ')], ['Expires', t.validTo],
      ["Let's Encrypt", t.acmeDomain ? `for ${t.acmeDomain}${t.acme?.lastError ? `: ${t.acme.lastError}` : t.acme?.issuedAt ? ', issued' : ', waiting'}` : 'off (TLS_ACME_DOMAIN not set)'],
      ['Kept across resets', t.kept ? 'yes (/demo-state/tls)' : 'no']
    ]);
    $('csv').href = `/api/owner/log.csv?${query()}`;
    // bans
    $('bans').replaceChildren(s.bans.length ? el('table', { class: 'table entries' }, el('tbody', {}, ...s.bans.map((b) => el('tr', {},
      el('td', { class: 'sample', 'data-l': 'Address' }, b.key), el('td', { 'data-l': 'Until' }, when(b.until)), el('td', { 'data-l': 'Why' }, b.reason),
      el('td', {}, el('button', { class: 'btn sm ghost', type: 'button', on: { click: async (e) => { e.target.disabled = true; await call('POST', '/api/owner/unban', { key: b.key }).catch(() => {}); load(); } } }, 'Lift')))))) : el('p', { class: 'muted small' }, 'No bans.'));
    // the log, grouped by address, each group folded
    const banned = new Set(s.bans.map((b) => b.key));
    if (!s.log.length) { $('groups').replaceChildren(el('p', { class: 'muted' }, 'Nothing in the log.')); return; }
    const groups = s.log.slice(0, shown).map((g) => group(g, banned));
    if (s.log.length > shown) groups.push(el('button', { class: 'btn sm ghost more', type: 'button', on: { click: () => { shown += GROUPS_SHOWN; render(s); } } }, `Show ${Math.min(GROUPS_SHOWN, s.log.length - shown)} more of ${s.log.length - shown}`));
    $('groups').replaceChildren(...groups);
  }

  function group(g, banned) {
    const isBanned = banned.has(g.address) || banned.has(`${g.address}`);
    const ban = el('button', { class: 'btn sm danger', type: 'button' }, isBanned ? 'Banned' : 'Ban');
    ban.disabled = isBanned;
    ban.addEventListener('click', async (e) => {
      e.preventDefault();
      ban.disabled = true;
      try { await call('POST', '/api/owner/ban', { address: g.address }); ban.textContent = 'Banned'; load(); } catch (err) { ban.disabled = false; $('err').textContent = err.message; }
    });
    const row = (e) => el('tr', {},
      el('td', { 'data-l': 'Kind' }, el('span', { class: `chip ${TONE[e.kind] || ''}` }, KIND[e.kind] || e.kind)),
      el('td', { 'data-l': 'Count' }, e.count), el('td', { 'data-l': 'First' }, when(e.firstSeen)), el('td', { 'data-l': 'Last' }, when(e.lastSeen)),
      el('td', { class: 'sample', 'data-l': 'Sample' }, e.sample || '-'), el('td', { class: 'agent', 'data-l': 'Agent' }, e.agent || '-'));
    const tbody = el('tbody', {}, ...g.entries.slice(0, ENTRIES_SHOWN).map(row));
    const rest = g.entries.length - ENTRIES_SHOWN;
    return el('details', { class: 'card group' },
      el('summary', {},
        el('div', {}, el('div', { class: 'addr' }, g.address), el('div', { class: 'muted small' }, `${g.count} attempt${g.count === 1 ? '' : 's'} · first ${when(g.firstSeen)} · last ${when(g.lastSeen)}`),
          el('div', { class: 'kinds' }, ...Object.entries(g.kinds).map(([k, n]) => el('span', { class: `chip ${TONE[k] || ''}` }, `${KIND[k] || k} ${n}`)))),
        ban),
      el('table', { class: 'table entries' }, el('thead', {}, el('tr', {}, ...['Kind', 'Count', 'First seen', 'Last seen', 'Sample', 'User agent'].map((h) => el('th', {}, h)))), tbody),
      rest > 0 ? el('button', { class: 'btn sm ghost more', type: 'button', on: { click: (e) => { tbody.append(...g.entries.slice(ENTRIES_SHOWN).map(row)); e.target.remove(); } } }, `Show ${rest} more`) : null);
  }

  // ---- visitors (demo/visitors.js): labels and pages are visitors' own: text nodes only
  const dur = (ms) => {
    const s = Math.round((ms || 0) / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} m ${s % 60 ? `${s % 60} s` : ''}`.trim() : `${Math.floor(m / 60)} h ${m % 60} m`;
  };
  const pageName = (p) => {
    const [ui, r] = String(p).split(':');
    return ui === 'studio' ? `Studio ${r === 'encoder' ? 'Encoder' : 'Viewer'}` : `${ui === 'horizon' ? 'Horizon' : 'Original'} · ${r}`;
  };
  const stamp = (ms, sec) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) }) : '-');
  const sum = (o) => Object.values(o || {}).reduce((n, x) => n + x, 0);
  const VCOLS = [
    ['ip', 'Address', (v) => v.ip], ['last', 'Last seen', (v) => v.last], ['first', 'First seen', (v) => v.first], ['visits', 'Visits', (v) => v.visits],
    ['active', 'Active', (v) => v.active], ['ui', 'Original / Horizon', (v) => v.time.horizon - v.time.original], ['swaps', 'Swaps', (v) => v.swaps],
    ['pages', 'Pages', (v) => Object.keys(v.pages).length], ['clicks', 'Controls', (v) => sum(v.clicks)], ['blocked', 'Blocked', (v) => v.blocked],
    ['device', 'Device', (v) => `${v.country} ${v.device}`], ['feedback', 'Feedback', (v) => v.feedback]
  ];
  // one event of a visitor, in words
  const what = (e) => {
    if (e.type === 'view') return `opened ${pageName(e.detail)}`;
    if (e.type === 'click') { const [kind, ...l] = e.detail.split('|'); return `${kind} “${l.join('|')}”`; }
    if (e.type === 'swap') return `swapped to ${e.detail === 'horizon' ? 'Horizon' : 'the original'}`;
    if (e.type === 'blocked') return `blocked by the demo: ${e.detail}`;
    if (e.type === 'feedback') return 'sent feedback';
    if (e.type === 'visit') return `visit ${e.detail} started`;
    if (e.type === 'device') return `device: ${e.detail}`;
    return `${e.type} ${e.detail}`;
  };
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 5 ? 'now' : s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} m ago`; };
  let vSort = { key: 'last', dir: -1 };
  let vData = null;
  const vOpen = new Set();
  async function loadVisitors() {
    $('vis-err').textContent = '';
    try { vData = await call('GET', '/api/owner/visitors'); renderVisitors(); } catch (err) { $('vis-err').textContent = err.message; }
  }
  function renderLive(live, you) {
    $('live-n').textContent = live.length ? `(${live.length})` : '';
    if (!live.length) { $('live').replaceChildren(el('p', { class: 'muted small' }, 'Nobody has the demo open right now.')); return; }
    $('live').replaceChildren(el('div', { class: 'live-list' }, ...live.sort((a, b) => b.since - a.since).map((v) => {
      const row = el('div', { class: 'live-row', tabindex: '0', title: 'Show in the list below' },
        el('div', {}, el('span', { class: 'ip' }, v.ip), v.ip === you ? el('span', { class: 'you' }, 'you') : null),
        el('div', { class: 'where' }, 'on ', el('b', {}, pageName(v.pageNow) || '-'), v.away ? el('span', { class: 'away' }, ' · tab in the background') : null),
        el('div', { class: 'muted small' }, `here ${dur(Math.max(0, Date.now() - v.since))} · ${sum(v.clicks)} controls${v.swaps ? ` · swapped ${v.swaps}×` : ''}`),
        el('div', { class: 'dev muted small' }, v.country ? `${v.country} · ` : '', v.device || ''),
        el('ol', { class: 'recent' }, ...((v.recent || []).length
          ? v.recent.map((e) => el('li', { class: e.type === 'blocked' ? 'bad' : '' }, el('span', {}, what(e)), el('time', {}, ago(e.t))))
          : [el('li', { class: 'muted' }, el('span', {}, 'Just looking so far'))])));
      return row;
    })));
  }
  function renderVisitors() {
    const { pages, you } = vData;
    const live = vData.visitors.filter((v) => v.live);
    renderLive(live, you);
    const visitors = vData.visitors.filter((v) => !v.live);
    const total = pages.length;
    const col = VCOLS.find((c) => c[0] === vSort.key);
    const rows = visitors.slice().sort((a, b) => { const x = col[2](a); const y = col[2](b); return (x > y ? 1 : x < y ? -1 : 0) * vSort.dir || b.last - a.last; });
    const head = el('tr', {}, ...VCOLS.map(([key, label]) => {
      const th = el('th', { scope: 'col' }, el('button', { type: 'button', on: { click: () => { vSort = { key, dir: vSort.key === key ? -vSort.dir : (key === 'ip' || key === 'device' ? 1 : -1) }; renderVisitors(); } } }, label));
      if (vSort.key === key) th.setAttribute('aria-sort', vSort.dir > 0 ? 'ascending' : 'descending');
      return th;
    }));
    const body = el('tbody');
    for (const v of rows) {
      const seen = Object.keys(v.pages).length;
      const tr = el('tr', { class: `vrow${vOpen.has(v.ip) ? ' open' : ''}`, tabindex: '0', 'aria-expanded': String(vOpen.has(v.ip)) },
        el('td', { class: 'ipcell' }, el('span', { class: 'ip' }, v.ip), v.ip === you ? el('span', { class: 'you' }, 'you') : null, el('div', { class: 'sub' }, `${v.events} events`)),
        el('td', { class: 'num', 'data-l': 'Last seen' }, stamp(v.last)),
        el('td', { class: 'num', 'data-l': 'First seen' }, stamp(v.first)),
        el('td', { class: 'num', 'data-l': 'Visits' }, v.visits),
        el('td', { class: 'num', 'data-l': 'Active' }, dur(v.active)),
        el('td', { class: 'num', 'data-l': 'Original / Horizon' }, `${dur(v.time.original)} / ${dur(v.time.horizon)}`),
        el('td', { class: 'num', 'data-l': 'Swaps' }, v.swaps ? `yes, ${v.swaps}×` : 'no'),
        el('td', { class: 'num', 'data-l': 'Pages' }, v.sawAll ? el('span', { class: 'yes', title: 'Saw every page' }, `✓ all ${seen}`) : `${seen} · ${v.never.length} not seen`),
        el('td', { class: 'num', 'data-l': 'Controls' }, sum(v.clicks)),
        el('td', { class: 'num', 'data-l': 'Blocked' }, v.blocked ? el('span', { class: 'bad' }, v.blocked) : '0'),
        el('td', { class: 'devcell', 'data-l': 'Device' }, v.country ? `${v.country} · ` : '', v.device || '-'),
        el('td', { class: 'num', 'data-l': 'Feedback' }, v.feedback ? el('span', { class: 'yes' }, `sent ${v.feedback > 1 ? `${v.feedback}×` : ''}`.trim()) : 'no'));
      const toggle = () => { if (vOpen.has(v.ip)) vOpen.delete(v.ip); else vOpen.add(v.ip); renderVisitors(); };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      body.append(tr);
      if (vOpen.has(v.ip)) body.append(el('tr', { class: 'drow' }, detail(v, total)));
    }
    $('vis').replaceChildren(el('thead', {}, head), body);
    if (!rows.length) $('vis').replaceChildren(el('tbody', {}, el('tr', {}, el('td', { class: 'muted' }, 'No visitors yet.'))));
    $('vis-sum').textContent = `${live.length} live now, ${rows.length} earlier visitor${rows.length === 1 ? '' : 's'} (2,000 at most, 30 days), newest first. Time counts only while the tab is visible; controls are their labels, never what was typed. Tap a row for its timeline.`;
  }
  function detail(v, total) {
    const chips = (entries) => el('div', { class: 'chips' }, ...(entries.length ? entries.map(([t, n]) => el('span', { class: 'chip' }, n ? `${t} ${n}` : t)) : [el('span', { class: 'muted small' }, 'none')]));
    const clicks = Object.entries(v.clicks).sort((a, b) => b[1] - a[1]).map(([k, n]) => { const [kind, ...l] = k.split('|'); return [`${l.join('|')} (${kind})`, n]; });
    const list = el('ol', {}, el('li', {}, el('span', { class: 'muted' }, 'Loading…')));
    call('GET', `/api/owner/visitor?ip=${encodeURIComponent(v.ip)}`).then((d) => {
      list.replaceChildren(...d.events.slice().reverse().map((e) => el('li', { class: e.type === 'blocked' ? 'bad' : '' }, el('time', {}, stamp(e.t, true)), el('span', {}, what(e)))));
    }).catch((err) => list.replaceChildren(el('li', {}, err.message)));
    return el('td', { class: 'detail', colspan: String(VCOLS.length) }, el('div', { class: 'vdet' },
      el('div', {}, el('h4', {}, `Pages opened (${Object.keys(v.pages).length} of ${total})`), chips(Object.entries(v.pages).sort((a, b) => b[1] - a[1]).map(([p, n]) => [pageName(p), n]))),
      el('div', {}, el('h4', {}, v.sawAll ? 'Never opened: none, saw every page ✓' : `Never opened (${v.never.length})`), chips(v.never.map((p) => [pageName(p), 0]))),
      el('div', {}, el('h4', {}, `Controls used (${sum(v.clicks)})`), chips(clicks)),
      el('div', { class: 'timeline' }, el('h4', {}, `Timeline (last ${v.events} events, newest first)`), list)));
  }

  let liveTimer = null;
  async function load() {
    $('err').textContent = '';
    try {
      const s = await call('GET', `/api/owner/state?${query()}`);
      $('login').hidden = true;
      $('page').hidden = false;
      render(s);
      loadVisitors();
      clearInterval(liveTimer);
      liveTimer = setInterval(() => { if (document.visibilityState === 'visible') loadVisitors(); }, 4_000);
    } catch (err) {
      if (err.status === 401) { $('page').hidden = true; $('login').hidden = false; return; }
      $('err').textContent = err.message;
    }
  }
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-err').textContent = '';
    try {
      await call('POST', '/api/owner/login', { password: e.target.password.value });
      e.target.reset();
      load();
    } catch (err) { $('login-err').textContent = err.message; }
  });
  $('logout').addEventListener('click', async () => { await call('POST', '/api/owner/logout').catch(() => {}); load(); });
  $('kind').addEventListener('change', () => { shown = GROUPS_SHOWN; load(); });
  $('refresh').addEventListener('click', load);
  for (const b of document.querySelectorAll('[data-sort]')) {
    b.addEventListener('click', () => {
      sort = b.dataset.sort;
      for (const x of document.querySelectorAll('[data-sort]')) x.classList.toggle('on', x === b);
      load();
    });
  }
  $('reset').addEventListener('click', async () => {
    if (!confirm('Reset the demo now? Everything visitors changed goes back to the start, and the app restarts (about a minute).')) return;
    $('reset').disabled = true;
    try { await call('POST', '/api/owner/reset'); $('reset-note').textContent = 'Restarting…'; setTimeout(load, 20000); } catch (err) { $('reset-note').textContent = err.message; }
  });
  load();
})();
