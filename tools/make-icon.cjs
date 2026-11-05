// Regenerate assets/startclip.ico (the Windows shortcut icon) from the favicon in index.html.
// Run after changing the logo:  node tools/make-icon.cjs
// Needs Playwright (LAUNCHPAD_TEST_TOOLS or ~/.cache/launchpad-test-tools, as for the browser tests).
// The .ico holds PNG images at each size; assets/startclip.ico.source records the SHA-256 of the
// favicon it was made from, so the unit tests notice when the logo changes without a rebuild.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const tools = process.env.LAUNCHPAD_TEST_TOOLS || path.join(os.homedir(), '.cache', 'launchpad-test-tools');
const { chromium } = require(path.join(tools, 'node_modules', 'playwright'));
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function favicon() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const match = html.match(/<link rel="icon" href="(data:image\/svg\+xml,[^"]+)">/);
  if (!match) throw new Error('index.html has no inline SVG favicon');
  return match[1];
}

function ico(pngs) {
  // ICONDIR, one ICONDIRENTRY per image (PNG payloads; 256 is written as 0), then the images.
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, at); head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt8(0, at + 2); head.writeUInt8(0, at + 3);
    head.writeUInt16LE(1, at + 4); head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8); head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map(item => item.png)]);
}

(async () => {
  const href = favicon();
  const browser = await chromium.launch();
  const pngs = [];
  try {
    for (const size of SIZES) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="${href}" width="${size}" height="${size}">`);
      await page.waitForFunction(() => document.querySelector('img').complete);
      pngs.push({ size, png: await page.locator('img').screenshot({ omitBackground: true }) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'startclip.ico'), ico(pngs));
  fs.writeFileSync(path.join(root, 'assets', 'startclip.ico.source'),
    crypto.createHash('sha256').update(href).digest('hex') + '  favicon in index.html (node tools/make-icon.cjs)\n');
  console.log('wrote assets/startclip.ico (' + SIZES.join(', ') + ' px)');
})();
