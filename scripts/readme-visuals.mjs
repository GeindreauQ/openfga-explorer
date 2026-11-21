// scripts/readme-visuals.mjs — Builds the framed README images in
// docs/readme/ from the raw captures of docs/screenshots/ (run
// take-screenshots.mjs first). Same look as the demo: a browser window
// with a soft shadow on a gradient backdrop.
//
//   hero.png       home page, light and dark split along a diagonal
//   <name>.png     one framed capture per feature

import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const OUT = path.join(ROOT, 'docs', 'readme');
const W = 1440, H = 900, BAR = 40, PAD = 64;

const dataUri = async name => `data:image/png;base64,${(await readFile(path.join(SHOTS, `${name}.png`))).toString('base64')}`;

function frame(content, url = 'localhost:8000') {
  return `<!doctype html><style>
    body { margin: 0; width: ${W + 2 * PAD}px; height: ${H + BAR + 2 * PAD}px;
      background: radial-gradient(120% 90% at 0% 0%, #7c6ff2 0%, transparent 60%),
                  radial-gradient(110% 90% at 100% 100%, #e48ad8 0%, transparent 55%),
                  linear-gradient(135deg, #4b3fc4, #a35bd6); }
    .win { position: absolute; left: ${PAD}px; top: ${PAD}px; width: ${W}px; border-radius: 14px; overflow: hidden;
      background: #fff; box-shadow: 0 40px 90px rgba(25, 10, 70, .45), 0 0 0 1px rgba(255, 255, 255, .25); }
    .bar { height: ${BAR}px; display: flex; align-items: center; gap: 8px; padding: 0 16px;
      background: #ecebf2; border-bottom: 1px solid #dcdbe4; font: 13px system-ui, sans-serif; }
    .dot { width: 12px; height: 12px; border-radius: 50%; }
    .url { margin: 0 auto; padding: 4px 60px; border-radius: 8px; background: #fff; color: #6b6b75; }
    .view { position: relative; width: ${W}px; height: ${H}px; }
    .view img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    .dark { clip-path: polygon(62% 0, 100% 0, 100% 100%, 38% 100%); }
    .seam { position: absolute; inset: 0; background: linear-gradient(to bottom right, transparent calc(50% - 1px), rgba(255,255,255,.7) 50%, transparent calc(50% + 1px));
      clip-path: polygon(61.9% 0, 62.1% 0, 38.1% 100%, 37.9% 100%); }
  </style><div class="win"><div class="bar">
    <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span><span class="url">${url}</span><span style="width:52px"></span>
  </div><div class="view">${content}</div></div>`;
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W + 2 * PAD, height: H + BAR + 2 * PAD } });

async function render(name, html) {
  await page.setContent(html);
  await page.waitForFunction(() => [...document.images].every(i => i.complete));
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  ✓ readme/${name}.png`);
}

await render('hero', frame(`<img src="${await dataUri('dashboard')}" alt=""><img class="dark" src="${await dataUri('dashboard-dark')}" alt=""><div class="seam"></div>`));
for (const name of ['access-object', 'access-kubectl', 'dsl', 'tuples-graph', 'audit']) {
  await render(name, frame(`<img src="${await dataUri(name)}" alt="">`));
}
await browser.close();
