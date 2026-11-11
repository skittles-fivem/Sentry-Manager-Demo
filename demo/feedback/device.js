'use strict';

// The sender's machine as their browser describes it, sent with demo
// feedback (the form says so) to track down bugs on particular hardware:
// OS, browser, device, CPU threads, memory, graphics, screen and window,
// touch, language, time zone, connection, interface. Nothing is stored here.
window.sentryDemoDevice = async () => {
  const n = navigator;
  const d = {};
  const ua = n.userAgentData;
  let hi = {};
  try { if (ua?.getHighEntropyValues) hi = await ua.getHighEntropyValues(['platform', 'platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList']); } catch { /* not offered */ }
  const brand = (hi.fullVersionList || ua?.brands || []).filter((b) => !/not.?a.?brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`);
  if (hi.platform || ua?.platform) {
    let os = hi.platform || ua.platform;
    // Windows 11 reports itself as platform version 13 or later
    if (os === 'Windows' && hi.platformVersion) os += Number(hi.platformVersion.split('.')[0]) >= 13 ? ' 11' : ' 10 or older';
    else if (hi.platformVersion) os += ` ${hi.platformVersion}`;
    d.os = os;
  } else {
    const u = n.userAgent;
    d.os = (/Windows NT [\d.]+|Mac OS X [\d_]+|Android [\d.]+|iPhone OS [\d_]+|iPad; CPU OS [\d_]+|CrOS [^)]+|Linux [^;)]+/.exec(u) || [n.platform || '?'])[0].replace(/_/g, '.');
  }
  if (brand.length) d.browser = brand.slice(-2).join(', ');
  else {
    const m = /(Edg|OPR|Firefox|FxiOS|CriOS|Chrome|Version)\/([\d.]+)/.exec(n.userAgent);
    if (m) d.browser = `${{ Edg: 'Edge', OPR: 'Opera', FxiOS: 'Firefox iOS', CriOS: 'Chrome iOS', Version: 'Safari' }[m[1]] || m[1]} ${m[2]}`;
  }
  if (hi.model) d.model = hi.model;
  else if (/iPhone|iPad|iPod/.exec(n.userAgent)) d.model = /iPhone|iPad|iPod/.exec(n.userAgent)[0];
  if (hi.architecture) d.arch = `${hi.architecture}${hi.bitness ? ` ${hi.bitness}-bit` : ''}`;
  if (n.hardwareConcurrency) d.cores = n.hardwareConcurrency;
  if (n.deviceMemory) d.memory = `${n.deviceMemory} GB or more`;
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (gl) d.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch { /* no WebGL */ }
  const dpr = window.devicePixelRatio || 1;
  d.screen = `${screen.width}×${screen.height} at ${Math.round(dpr * 100) / 100}x (${Math.round(screen.width * dpr)}×${Math.round(screen.height * dpr)} px)`;
  d.viewport = `${innerWidth}×${innerHeight}${document.fullscreenElement ? ', full screen' : ''}`;
  d.touch = n.maxTouchPoints > 0 ? `yes (${n.maxTouchPoints} points)` : 'no';
  d.language = (n.languages || [n.language]).slice(0, 3).join(', ');
  try { d.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* none */ }
  const c = n.connection;
  if (c) d.connection = [c.effectiveType, c.downlink ? `${c.downlink} Mb/s` : '', c.rtt ? `${c.rtt} ms` : ''].filter(Boolean).join(', ');
  d.ui = `${document.querySelector('script[data-ui]')?.dataset.ui || 'original'}${matchMedia('(prefers-color-scheme: light)').matches ? ', light' : ', dark'}${matchMedia('(prefers-reduced-motion: reduce)').matches ? ', reduced motion' : ''}`;
  return d;
};
