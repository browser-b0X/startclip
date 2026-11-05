// Rebuild the README images in docs/: banners, light and dark screenshots, the hover-trace GIF and the GitHub social
// preview. They show the synthetic map in tests/support/demo-map.json, in a temp copy of the page, so no personal app
// reaches them. Run after changing the demo map or the look:  node tools/make-docs-images.cjs
// Needs Playwright (LAUNCHPAD_TEST_TOOLS or ~/.cache/launchpad-test-tools, as for the browser tests), ffmpeg for the
// GIF and Fira Sans for the wordmark (pacman: ttf-fira-sans).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { demoPage, emptyPage, removePage, writePage } = require('../tests/support/pages.cjs');

const root = path.join(__dirname, '..');
const tools = process.env.LAUNCHPAD_TEST_TOOLS || path.join(os.homedir(), '.cache', 'launchpad-test-tools');
const { chromium } = require(path.join(tools, 'node_modules', 'playwright'));
const docs = path.join(root, 'docs');
const demoFile = writePage(demoPage()), emptyFile = writePage(emptyPage());
const LIME = '#c9f53f', INK = '#14170f', FPS = 20, REST = 0.4, SECONDS = 3.4;
const logo = fs.readFileSync(path.join(root, 'assets', 'startclip-icon.svg'), 'utf8').trim();
const fontStack = "font-family:'Fira Sans',system-ui,sans-serif";

function banner(background, text, muted) {
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent}
.card{box-sizing:border-box;height:100%;border-radius:20px;background:${background};display:flex;align-items:center;justify-content:center;gap:40px;${fontStack}}
.card svg{width:148px;height:148px}
h1{margin:0;color:${text};font-size:92px;line-height:1;font-weight:800;letter-spacing:-.015em}
p{margin:12px 0 0;color:${muted};font-size:29px;font-weight:500}
</style><div class="card">${logo}<div><h1>Startclip</h1><p>Your local startup map</p></div></div>`;
}

function socialPreview(shot) {
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1280px;height:640px;overflow:hidden;background:#0f110c;${fontStack}}
.glow{position:absolute;left:-180px;top:-200px;width:900px;height:900px;background:radial-gradient(closest-side,rgba(201,245,63,.17),rgba(201,245,63,0))}
.copy{position:absolute;left:72px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center}
.copy svg{width:112px;height:112px}
h1{margin:30px 0 0;color:#f4f7e8;font-size:82px;line-height:1;font-weight:800;letter-spacing:-.015em}
p{margin:20px 0 0;color:#c8ccb8;font-size:30px;line-height:1.3;font-weight:500}
p b{color:${LIME};font-weight:600}
img{position:absolute;left:590px;top:64px;width:1020px;border-radius:16px;border:1px solid #3a3f2e;box-shadow:0 18px 70px rgba(0,0,0,.6)}
</style><div class="glow"></div><div class="copy">${logo}<h1>Startclip</h1><p>Click a card. The command is copied. <b>Nothing runs.</b></p></div><img src="data:image/png;base64,${shot.toString('base64')}">`;
}

async function openPage(browser, theme, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript(chosen => { localStorage.setItem('launchpad', JSON.stringify({ theme: chosen })); }, theme);
  const page = await context.newPage();
  await page.goto(demoFile.url);
  await page.waitForSelector('.node');
  return page;
}

// Hover Ledger, let the page's hover-intent delay fire, then freeze every clock and step it frame by frame.
async function hoverTraceGif(browser, out) {
  const page = await openPage(browser, 'dark', { width: 1280, height: 800 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startclip-docs-'));
  try {
    await page.mouse.move(1270, 790);
    await page.waitForTimeout(500);
    const frame = i => path.join(dir, String(i).padStart(4, '0') + '.png');
    const rest = Math.round(REST * FPS), total = Math.round(SECONDS * FPS);
    await page.screenshot({ path: frame(0) });
    for (let i = 1; i < rest; i++) fs.copyFileSync(frame(0), frame(i));
    const box = await page.locator('.node[data-id="ledger"]').boundingBox();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
    await page.waitForFunction(() => document.getElementById('board').classList.contains('tracing'));
    await page.evaluate(() => {
      const edges = document.querySelector('.edges');
      edges.pauseAnimations();
      window.__dots = edges.getCurrentTime();
      window.__clocks = document.getAnimations().map(animation => { animation.pause(); return [animation, animation.currentTime || 0]; });
    });
    for (let i = rest; i < total; i++) {
      await page.evaluate(ms => {
        document.querySelector('.edges').setCurrentTime(window.__dots + ms / 1000);
        window.__clocks.forEach(([animation, start]) => { animation.currentTime = start + ms; });
      }, ((i - rest) * 1000) / FPS);
      await page.screenshot({ path: frame(i) });
    }
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', path.join(dir, '%04d.png'),
      '-vf', 'split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
      '-loop', '0', out]);
  } finally {
    await page.context().close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  fs.mkdirSync(docs, { recursive: true });
  const browser = await chromium.launch();
  try {
    const shots = {};
    for (const theme of ['dark', 'light']) {
      const page = await openPage(browser, theme, { width: 1440, height: 900 });
      await page.locator('.node[data-id="ledger"]').hover();
      await page.waitForTimeout(1500);
      shots[theme] = await page.screenshot();
      // The README screenshot shows a second workspace; focus selects a card without copying it.
      await page.mouse.move(1, 1);
      await page.click('.view[data-view="ai"]');
      await page.click('#filters .filter[data-group="models"]');
      await page.focus('.node[data-id="orbit35"]');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(docs, `screenshot-${theme}.png`) });
      await page.context().close();
      const first = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })).newPage();
      await first.goto(emptyFile.url);
      await first.evaluate(chosen => { localStorage.setItem('launchpad', JSON.stringify({ theme: chosen })); }, theme);
      await first.reload();
      await first.waitForSelector('#first-run:not([hidden])');
      await first.screenshot({ path: path.join(docs, `first-run-${theme}.png`) });
      await first.context().close();
    }
    const sheet = await browser.newPage({ viewport: { width: 1280, height: 300 }, deviceScaleFactor: 2 });
    for (const [name, colours] of [['dark', [INK, '#f4f7e8', '#c8ccb8']], ['light', ['#eef2dc', INK, '#4b5138']]]) {
      await sheet.setContent(banner(...colours));
      await sheet.evaluate(() => document.fonts.ready);
      await sheet.screenshot({ path: path.join(docs, `banner-${name}.png`), omitBackground: true });
    }
    await sheet.setViewportSize({ width: 1280, height: 640 });
    await sheet.setContent(socialPreview(shots.dark));
    await sheet.evaluate(() => document.fonts.ready);
    if (!await sheet.evaluate(() => document.fonts.check("800 40px 'Fira Sans'"))) console.warn('Fira Sans not found: the wordmark fell back to a system font');
    await sheet.screenshot({ path: path.join(docs, 'social-preview.png') });
    await sheet.close();
    await hoverTraceGif(browser, path.join(docs, 'hover-trace.gif'));
  } finally {
    await browser.close();
    removePage(demoFile);
    removePage(emptyFile);
  }
  for (const file of fs.readdirSync(docs)) console.log(file, Math.round(fs.statSync(path.join(docs, file)).size / 1024) + ' KB');
})();
