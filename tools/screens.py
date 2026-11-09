#!/usr/bin/env python3
"""Screenshots of every page of a running demo, desktop and phone, plus the
page errors each one logged. Used to check the demo after a change.

    python3 tools/screens.py https://localhost:9000 out/
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip('/')
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
PAGES = ['overview', 'footage', 'viewer', 'drives', 'encoder', 'jobs', 'bin', 'policies', 'health', 'notifications', 'settings', 'account']
SIZES = {'desktop': {'width': 1440, 'height': 900}, 'phone': {'width': 393, 'height': 852}}

report = {}
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', args=['--ignore-certificate-errors'])
    for size, viewport in SIZES.items():
        ctx = browser.new_context(viewport=viewport, ignore_https_errors=True,
                                  device_scale_factor=2 if size == 'phone' else 1,
                                  is_mobile=size == 'phone', has_touch=size == 'phone')
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type in ('error',) else None)
        page.on('response', lambda r: errors.append(f'{r.status} {r.request.method} {r.url}') if r.status >= 400 else None)
        for name in PAGES:
            errors.clear()
            page.goto(f'{BASE}/#/{name}', wait_until='load')
            page.wait_for_timeout(6000 if name == 'viewer' else 3000)
            page.screenshot(path=str(OUT / f'{size}-{name}.png'))
            report[f'{size}-{name}'] = list(errors)
        ctx.close()
    browser.close()
(OUT / 'report.json').write_text(json.dumps(report, indent=1))
for k, v in report.items():
    print(k, len(v), *v[:4], sep='\n  ' if v else ' ')
