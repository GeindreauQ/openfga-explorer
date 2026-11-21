// scripts/make-demo.mjs — Records the README demo (docs/demo.gif).
//
// A real browsing session is recorded as video (not stitched screenshots):
// a visible cursor glides to each target before clicking, text is typed at
// human speed, and pauses leave time to read. ffmpeg then puts the
// recording in a browser window on a gradient backdrop and encodes a GIF.
//
// Read-only: nothing is written to OpenFGA. Needs a running Explorer with
// auth disabled and the demo stores (docker compose -f docker-compose.yml
// -f examples/seeder.yml up), Playwright (`cd tests && npm install`) and
// ffmpeg. Run from the repo root: `node scripts/make-demo.mjs`.
//
//   BASE       Explorer URL         (default http://localhost:8000)
//   STORE      main demo store      (default example-07-lakekeeper)
//   K8S_STORE  Kubernetes store     (default example-08-kubernetes)
//   URL_LABEL  text of the address bar (default: host of BASE)
//   MP4        also keep an MP4 at this path

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8000';
const STORE = process.env.STORE || 'example-07-lakekeeper';
const K8S_STORE = process.env.K8S_STORE || 'example-08-kubernetes';
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const GIF = path.join(ROOT, 'docs', 'demo.gif');

const W = 1280, H = 800;          // recorded viewport
const BAR = 40;                   // window title bar
const PAD_X = 72, PAD_Y = 64;     // backdrop around the window
const CW = W + 2 * PAD_X, CH = H + BAR + 2 * PAD_Y;
const RADIUS = 14;

const work = await mkdtemp(path.join(tmpdir(), 'openfga-demo-'));
const browser = await chromium.launch();

// ── 1. Backdrop and corner mask ─────────────────────────────────────────

async function render(html, file, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html);
  await page.screenshot({ path: file, omitBackground: false });
  await page.close();
}

const host = process.env.URL_LABEL || new URL(BASE).host;
await render(`<!doctype html><style>
  body { margin: 0; width: ${CW}px; height: ${CH}px;
    background: radial-gradient(120% 90% at 0% 0%, #7c6ff2 0%, transparent 60%),
                radial-gradient(110% 90% at 100% 100%, #e48ad8 0%, transparent 55%),
                linear-gradient(135deg, #4b3fc4, #a35bd6); }
  .win { position: absolute; left: ${PAD_X}px; top: ${PAD_Y}px; width: ${W}px; height: ${H + BAR}px;
    border-radius: ${RADIUS}px; background: #fff; overflow: hidden;
    box-shadow: 0 40px 90px rgba(25, 10, 70, .45), 0 0 0 1px rgba(255, 255, 255, .25); }
  .bar { height: ${BAR}px; display: flex; align-items: center; gap: 8px; padding: 0 16px;
    background: #ecebf2; border-bottom: 1px solid #dcdbe4; font: 13px system-ui, sans-serif; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .url { margin: 0 auto; padding: 4px 60px; border-radius: 8px; background: #fff; color: #6b6b75; }
</style><div class="win"><div class="bar">
  <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>
  <span class="dot" style="background:#28c840"></span><span class="url">${host}</span><span style="width:52px"></span>
</div></div>`, path.join(work, 'backdrop.png'), CW, CH);

await render(`<!doctype html><style>body { margin: 0; background: #000; }
  div { width: ${W}px; height: ${H}px; background: #fff; border-radius: 0 0 ${RADIUS}px ${RADIUS}px; }</style><div></div>`,
  path.join(work, 'mask.png'), W, H);

// ── 2. Recording ────────────────────────────────────────────────────────

const stores = (await (await fetch(`${BASE}/api/stores`)).json()).stores || [];
const storeId = name => stores.find(s => s.name === name)?.id;
const demo = storeId(STORE);
const k8s = storeId(K8S_STORE);
if (!demo) throw new Error(`store ${STORE} not found on ${BASE}`);

const ctx = await browser.newContext({
  bypassCSP: true,   // le curseur et l'effet de clic sont du CSS injecté
  viewport: { width: W, height: H },
  recordVideo: { dir: work, size: { width: W, height: H } },
});
// Visible cursor: Playwright's synthetic mouse is not drawn in recordings.
await ctx.addInitScript(() => {
  try { localStorage.setItem('openfga-explorer.theme', 'light'); } catch {}
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 9.5-6.6 1.4L16 20l-2.8 1.3-3.6-7.2L4 18.5z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const pos = JSON.parse(sessionStorage.getItem('demo-cursor') || '{"x":640,"y":420}');
    Object.assign(c.style, { position: 'fixed', left: 0, top: 0, zIndex: 2147483647, pointerEvents: 'none',
      transform: `translate(${pos.x}px, ${pos.y}px)`, filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))' });
    document.body.appendChild(c);
    const style = document.createElement('style');
    style.textContent = '.demo-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(83,74,183,.35);pointer-events:none;z-index:2147483646;animation:demo-ripple .5s ease-out forwards}@keyframes demo-ripple{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}';
    document.head.appendChild(style);
  });
});

const page = await ctx.newPage();
const recordStart = Date.now();
const pause = ms => page.waitForTimeout(ms);

async function glideTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const x = Math.round(box.x + Math.min(box.width / 2, 60)), y = Math.round(box.y + box.height / 2);
  const ms = await page.evaluate(({ x, y }) => {
    const c = document.getElementById('demo-cursor');
    const from = JSON.parse(sessionStorage.getItem('demo-cursor') || '{"x":640,"y":420}');
    const ms = Math.round(Math.min(900, Math.max(350, Math.hypot(x - from.x, y - from.y) * 0.9)));
    c.style.transition = `transform ${ms}ms cubic-bezier(.45, 0, .2, 1)`;
    c.style.transform = `translate(${x}px, ${y}px)`;
    sessionStorage.setItem('demo-cursor', JSON.stringify({ x, y }));
    return ms;
  }, { x, y });
  await page.mouse.move(x, y, { steps: 8 });
  await pause(ms + 120);
}

async function click(selector) {
  const target = page.locator(selector).first();
  await glideTo(target);
  await page.evaluate(() => {
    const p = JSON.parse(sessionStorage.getItem('demo-cursor'));
    const r = document.createElement('div');
    r.className = 'demo-ripple';
    Object.assign(r.style, { left: p.x + 'px', top: p.y + 'px' });
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 600);
  });
  await target.click();
}

async function type(selector, text) {
  await click(selector);
  await page.locator(selector).first().pressSequentially(text, { delay: 75 });
}

async function choose(selector, value) {
  await glideTo(page.locator(selector).first());
  await page.selectOption(selector, value);
}

async function scrollTo(selector) {
  await page.evaluate(sel => document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), selector);
  await pause(900);
}

await page.goto(`${BASE}/?store=${demo}`);
await page.waitForFunction(() => document.querySelector('#home-types li'), null, { timeout: 15000 });
const trim = (Date.now() - recordStart) / 1000 + 0.3;

// Home: the active store at a glance.
await pause(2200);

// Who has access to a warehouse, and why for one of them.
await click('.home-tile[data-tile="access"]:not([data-access-tab])');
await pause(900);
await choose('#access-form select[name="type"]', 'warehouse');
await type('#access-form input[name="id"]', 'warehouse_1_2');
await click('#access-form button[type="submit"]');
await page.waitForSelector('#access-results tr[data-subject]');
await pause(1800);
await click('#access-results tr[data-subject="user:grace"]');
await page.waitForSelector('#access-detail *');
await scrollTo('#access-detail');
await pause(2600);

// Tuples, as cards then as a graph.
await click('.nav-item[data-nav="manage_tuple"]');
await page.waitForSelector('#grid .card');
await pause(1600);
await click('#view-graph');
await pause(3200);

// The model editor (first visit shows its short tour).
await click('.nav-item[data-nav="admin_dsl"]');
await pause(2000);
await click('#dsl-tour-close');
await pause(2600);

// Kubernetes: simulate `kubectl auth can-i` against the webhook model.
if (k8s) {
  await choose('#store-select', k8s);
  await pause(1500);
  await click('.nav-item[data-nav="access"]');
  await page.waitForSelector('#access-tabs [data-access-tab="kubectl"]:not([hidden])');
  await click('#access-tabs [data-access-tab="kubectl"]');
  await pause(600);
  await type('#access-form input[name="user"]', 'alice');
  await type('#access-form input[name="groups"]', 'billing-team');
  await choose('#access-form select[name="verb"]', 'create');
  await type('#access-form input[name="subresource"]', 'exec');
  await type('#access-form input[name="namespace"]', 'billing');
  await click('#access-form button[type="submit"]');
  await page.waitForSelector('#access-results > *');
  await pause(1400);
  await scrollTo('#access-results');
  await pause(2400);
}

// Same screen in the dark theme.
await click('.theme-switch [data-theme-choice="dark"]');
await pause(2800);

await page.close();
await ctx.close();
await browser.close();

// ── 3. Composition ──────────────────────────────────────────────────────

const video = path.join(work, (await readdir(work)).find(f => f.endsWith('.webm')));
const mp4 = path.join(work, 'demo.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
  '-ss', String(trim), '-i', video,
  '-loop', '1', '-i', path.join(work, 'backdrop.png'),
  '-i', path.join(work, 'mask.png'),  // single frame, repeated until the video ends
  '-filter_complex', `[2:v]format=gray[m];[0:v]format=rgba[v];[v][m]alphamerge[w];[1:v][w]overlay=${PAD_X}:${PAD_Y + BAR}:shortest=1,format=yuv420p`,
  '-r', '30', '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', mp4]);

execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4,
  '-filter_complex', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  GIF]);

if (process.env.MP4) await copyFile(mp4, process.env.MP4);
await rm(work, { recursive: true, force: true });
const size = Number(execFileSync('stat', ['-c', '%s', GIF]).toString()) / 1024 / 1024;
console.log(`${path.relative(ROOT, GIF)} — ${size.toFixed(1)} MB`);
