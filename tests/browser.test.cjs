'use strict';
/*
 * Startclip browser checks (node:test and Playwright). They replace the retired tests/browser_checks.py.
 *
 *   node --test tests/browser.test.cjs
 *
 * Environment
 *   LAUNCHPAD_TEST_TOOLS  A node_modules directory that contains `playwright` and
 *                         `axe-core`. Default: ~/.cache/launchpad-test-tools/node_modules when it
 *                         exists, else ../node_modules relative to this file.
 *                         NODE_PATH is tried as a fallback. When Playwright cannot be
 *                         resolved the whole file is reported as skipped, with the path
 *                         that was searched.
 *   LAUNCHPAD_SHOTS       Directory for screenshots (created if missing). Default: a fresh
 *                         mkdtemp directory under the OS temp dir. The project tree is
 *                         refused.
 *   LAUNCHPAD_CLIPBOARD   stub (default) | real | both
 *                         stub  navigator.clipboard.writeText is replaced by a recorder
 *                               installed with page.addInitScript; the last copied text is
 *                               exposed on window.__copied (all copies on window.__copies,
 *                               the path on window.__copiedVia). document.execCommand('copy')
 *                               is wrapped the same way so the legacy fallback is observable.
 *                         real  no stub; clipboard permissions are granted through
 *                               context.grantPermissions (file:// origin first, then the
 *                               whole context) and copies are read back with
 *                               navigator.clipboard.readText(). Skipped when Chromium
 *                               refuses the grant.
 *                         both  run the full flow in both modes.
 *                               (screenshots of the real-mode flow are prefixed "real-").
 *                         Independently of the mode, a real-clipboard round-trip test
 *                         always runs (and skips itself when the grant is refused).
 *   LAUNCHPAD_HEADED      1 to watch the browser.
 *
 * The page under test is the shipped engine filled with the synthetic demo map from
 * tests/support/demo-map.json, in a temp folder, so the suite holds for any map index.html
 * carries; tests/first-run.test.cjs checks the empty map and the page as it stands. All
 * counts (nodes per view, per group, connectors, prerequisites) and node names are derived
 * from that map. The few literal command fragments checked on purpose are marked
 * "literal kept".
 */

const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { TOOLS_DIR, resolveTool, clipboardHarness, installContrast, contrastFailures } = require('./support/browser.cjs');
const { coreOf, demoPage, jsonBlock, removePage, writePage } = require('./support/pages.cjs');
const CHECK_TIMEOUT = 2000; // a check must turn true within this budget
const TOAST_TIMEOUT = 5000; // the page hides its toast after 3600 ms
const HEADLESS = process.env.LAUNCHPAD_HEADED !== '1';
const CLIPBOARD_MODES = { stub: ['stub'], real: ['real'], both: ['stub', 'real'] }[process.env.LAUNCHPAD_CLIPBOARD || 'stub'];
const CLIPBOARD_PERMISSIONS = ['clipboard-read', 'clipboard-write'];

const playwrightEntry = resolveTool('playwright');
if (!playwrightEntry) {
  test('Startclip browser checks', {
    skip: 'Playwright is not resolvable from ' + TOOLS_DIR + ' (or NODE_PATH). Point LAUNCHPAD_TEST_TOOLS at a node_modules directory that contains playwright and axe-core.'
  }, () => {});
  return;
}
if (!CLIPBOARD_MODES) throw new Error('LAUNCHPAD_CLIPBOARD must be stub, real or both');
const playwright = require(playwrightEntry);
const AXE_PATH = resolveTool('axe-core/axe.min.js');

// ---------------------------------------------------------------------------
// Catalog, core script and view configuration, parsed out of the HTML
// ---------------------------------------------------------------------------
const html = demoPage();
const pageFile = writePage(html);
process.on('exit', () => removePage(pageFile));
const PAGE_URL = pageFile.url;
const catalog = jsonBlock(html, 'catalog'), views = jsonBlock(html, 'views'), catalogMeta = jsonBlock(html, 'catalog-meta');
const core = coreOf(html);
assert.ok(views && views.ai && views.services && views.desktop, 'views configuration parsed from the page');

const byId = id => {
  const app = catalog.find(item => item.id === id);
  assert.ok(app, 'catalog has an entry with id ' + id);
  return app;
};
const count = (view, group = 'all', status) => catalog.filter(app =>
  app.view === view && (group === 'all' || app.group === group) && (status === undefined || app.status === status)).length;
const visibleIds = (view, group) => core.filterApps(catalog, view, group, '').map(app => app.id);
// drawEdges() draws every connection whose two ends are rendered (optional ones too).
const connectorsAmong = ids => core.connections.filter(edge => ids.includes(edge.from) && ids.includes(edge.to)).length;
const plan = id => core.startupPlan(catalog, core.connections, id);
const chainNames = id => plan(id).apps.map(app => app.name).join(' → ');
const prerequisiteCount = id => plan(id).apps.length - 1;
const copiedPrefix = app => 'Copied ' + app.name;

// Anchors from the original script, resolved through the catalog (names are never typed).
const modeler = byId('modeler'), gamehub = byId('gamehub'), gameeditor = byId('gameeditor');
const pilot = byId('pilot'), coder = byId('coder'), gatemcp = byId('gatemcp');
const cedar = byId('cedar'), stalled = byId('stalled'), engine = byId('engine');
const ledger = byId('ledger'), scraper = byId('scraper'), shelf = byId('shelf');
assert.equal(stalled.status, 'blocked', 'the "needs attention" anchor is blocked in the catalog');

// ---------------------------------------------------------------------------
// Screenshot directory — never the project tree
// ---------------------------------------------------------------------------
const PROJECT_DIR = path.resolve(__dirname, '..');
const SHOTS_DIR = process.env.LAUNCHPAD_SHOTS
  ? path.resolve(process.env.LAUNCHPAD_SHOTS)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-shots-'));
if (SHOTS_DIR === PROJECT_DIR || SHOTS_DIR.startsWith(PROJECT_DIR + path.sep)) {
  throw new Error('LAUNCHPAD_SHOTS must point outside the project tree: ' + SHOTS_DIR);
}
fs.mkdirSync(SHOTS_DIR, { recursive: true });
const shotPath = name => path.join(SHOTS_DIR, name);

// A first visit opens Web services. Most checks were written from Desktop apps, so they start there;
// tests of the first visit pass firstVisit. Seeds a test already wrote are left alone.
function startOnDesktop() {
  try {
    if (sessionStorage.getItem('start-seeded')) return;
    sessionStorage.setItem('start-seeded', '1');
    if (localStorage.getItem('launchpad') === null) localStorage.setItem('launchpad', JSON.stringify({ workspace: 'desktop', selected: 'modeler' }));
  } catch {}
}

async function grantClipboard(context) {
  // Chromium (156+) treats file:// as an opaque origin and refuses per-origin grants;
  // a context-wide grant still works there. Returns null on success, else the reason.
  const reasons = [];
  for (const options of [{ origin: 'file://' }, undefined]) {
    try { await context.grantPermissions(CLIPBOARD_PERMISSIONS, options); return null; }
    catch (error) { reasons.push(error.message.split('\n')[0]); }
  }
  return reasons.join(' / ');
}

// ---------------------------------------------------------------------------
// Polling assertion with the original script's semantics (true within 2 s)
// ---------------------------------------------------------------------------
async function check(page, label, predicate, arg, timeout = CHECK_TIMEOUT) {
  try {
    await page.waitForFunction(predicate, arg, { timeout, polling: 50 });
  } catch (error) {
    if (!(error instanceof playwright.errors.TimeoutError)) throw error;
    let last;
    try { last = await page.evaluate(predicate, arg); } catch (inner) { last = 'threw: ' + inner.message.split('\n')[0]; }
    throw new assert.AssertionError({
      message: label + ' — still false after ' + timeout + ' ms (last value: ' + JSON.stringify(last) + ')',
      actual: last, expected: true, operator: 'check'
    });
  }
}

const describeOptions = { timeout: 180000 };

describe('Startclip browser checks', describeOptions, () => {
  let browser;
  before(async () => { browser = await playwright.chromium.launch({ headless: HEADLESS }); });
  after(async () => { if (browser) await browser.close(); });

  for (const mode of CLIPBOARD_MODES) defineFlow(mode, () => browser);
  defineRealClipboardRoundTrip(() => browser);
  defineCatalogGuards(() => browser);
  defineBehaviour(() => browser);
  defineAccessibleLayout(() => browser);
  defineThemesPrintAndPolicy(() => browser);
  defineFeatures(() => browser);
  defineWorkspaces(() => browser);
  defineReviewFixes(() => browser);
  defineQaFixes(() => browser);
  defineAxeScan(() => browser);
});

// ---------------------------------------------------------------------------
// The ported flow (one browser context, sequential tests sharing one page)
// ---------------------------------------------------------------------------
function defineFlow(mode, getBrowser) {
  describe('flow (clipboard: ' + mode + ')', describeOptions, () => {
    const S = { context: null, page: null, unavailable: null, pageErrors: [], consoleErrors: [], shots: [] };
    const node = app => S.page.locator('.node[data-id="' + app.id + '"]');
    const filter = group => S.page.locator('#filters .filter[data-group="' + group + '"]');
    const workspace = view => S.page.locator('.view[data-view="' + view + '"]');
    const viewport = (width, height) => S.page.setViewportSize({ width, height });
    const evaluate = (fn, arg) => S.page.evaluate(fn, arg);
    const nodesEqual = (label, expected) => check(S.page, label + ' (' + expected + ')', n => document.querySelectorAll('.node').length === n, expected);
    const fits = label => check(S.page, label, () => document.documentElement.scrollWidth <= innerWidth);
    const copiedMatchesInspector = label => check(S.page, label, async () => (await window.__readCopied()) === document.getElementById('command').value);
    const shot = async (t, name) => { const file = shotPath(mode === 'stub' ? name : mode + '-' + name); await S.page.screenshot({ path: file }); S.shots.push(file); t.diagnostic('screenshot: ' + file); };
    const it = (name, fn) => test(name, async t => { if (S.unavailable) return t.skip(S.unavailable); await fn(t); });

    before(async () => {
      S.context = await getBrowser().newContext({ viewport: { width: 1440, height: 1000 } });
      if (mode === 'real') {
        const refused = await grantClipboard(S.context);
        if (refused) S.unavailable = 'real clipboard mode unavailable: ' + refused;
      }
      await S.context.addInitScript(clipboardHarness, { mode });
      await S.context.addInitScript(startOnDesktop);
      S.page = await S.context.newPage();
      S.page.setDefaultTimeout(5000);
      S.page.on('pageerror', error => S.pageErrors.push(error));
      S.page.on('console', message => { if (message.type() === 'error') S.consoleErrors.push(message.text()); });
      await S.page.goto(PAGE_URL);
      if (mode === 'real' && !S.unavailable) {
        const probe = await S.page.evaluate(async () => {
          try { await navigator.clipboard.writeText('launchpad-probe'); return await navigator.clipboard.readText(); }
          catch (error) { return 'ERR ' + error.message; }
        });
        if (probe !== 'launchpad-probe') S.unavailable = 'real clipboard mode unavailable: readText() -> ' + probe;
      }
    });
    after(async () => { if (S.context) await S.context.close(); });
    afterEach(async () => {
      if (S.page && !S.page.isClosed()) await S.page.evaluate(() => window.__restoreClipboard && window.__restoreClipboard()).catch(() => {});
    });

    it('standalone file loads every desktop node and fits the width', async t => {
      await nodesEqual('standalone file loads the desktop nodes', count('desktop'));
      await fits('desktop document fits width');
      await shot(t, 'desktop.png');
    });

    it('clicking a node copies its exact command', async () => {
      await node(modeler).click();
      await check(S.page, 'copy reports success', prefix => document.getElementById('toast').textContent.startsWith(prefix), copiedPrefix(modeler));
      await copiedMatchesInspector('clipboard matches the inspector command');
      // literal kept on purpose
      await check(S.page, 'clipboard contains exact Modeler command', async () => (await window.__readCopied()) === '/usr/bin/modeler');
    });

    it('search narrows, shows the empty state and clears', async () => {
      const narrowed = core.filterApps(catalog, 'desktop', 'all', modeler.command).length;
      assert.ok(narrowed >= 1 && narrowed < count('desktop'), 'searching the Modeler command narrows the desktop view');
      await S.page.fill('#search', modeler.command);
      await nodesEqual('search narrows to the matching nodes', narrowed);
      await S.page.fill('#search', 'not-an-installed-app');
      await check(S.page, 'empty state is visible', () => !document.getElementById('empty').hidden);
      await S.page.getByRole('button', { name: 'Clear search and filters', exact: true }).click();
      await nodesEqual('empty state reset restores nodes', count('desktop'));
    });

    it('keyboard: Enter and Space copy, / focuses search, Escape clears it', async () => {
      await S.page.locator('.node[data-id="' + modeler.id + '"]').focus();
      await evaluate(() => { document.getElementById('toast').textContent = ''; });
      await S.page.keyboard.press('Enter');
      await check(S.page, 'Enter copies focused node', prefix => document.getElementById('toast').textContent.startsWith(prefix), copiedPrefix(modeler));
      await evaluate(() => { document.getElementById('toast').textContent = ''; });
      await S.page.keyboard.press('Space');
      await check(S.page, 'Space copies focused node', prefix => document.getElementById('toast').textContent.startsWith(prefix), copiedPrefix(modeler));
      await S.page.keyboard.press('/');
      await check(S.page, 'slash focuses search', () => document.activeElement.id === 'search');
      await S.page.fill('#search', modeler.name.toLowerCase());
      await S.page.keyboard.press('Escape');
      await check(S.page, 'Escape clears search', n => document.getElementById('search').value === '' && document.querySelectorAll('.node').length === n, count('desktop'));
    });

    it('inspector copy preserves the exact command', async () => {
      await S.page.locator('#copy-command').click();
      await copiedMatchesInspector('inspector copy matches the inspector command');
      // literal kept on purpose
      await check(S.page, 'inspector preserves exact command', () => document.getElementById('command').value === '/usr/bin/modeler');
    });

    it('zoom in increases and fit resets the zoom', async () => {
      await S.page.locator('#zoom-in').click();
      await check(S.page, 'zoom increases', () => parseInt(document.getElementById('zoom-value').textContent) > 100);
      await S.page.locator('#zoom-fit').click();
      await check(S.page, 'fit resets zoom', () => parseInt(document.getElementById('zoom-value').textContent) <= 100);
    });

    it('dragging the background pans the canvas', async () => {
      await evaluate(() => document.getElementById('canvas').scrollTo(0, 0));
      // Count-agnostic guard: a small catalog may not overflow the canvas at fit zoom.
      for (let attempt = 0; attempt < 9; attempt++) {
        const scrollable = await evaluate(() => { const c = document.getElementById('canvas'); return c.scrollHeight > c.clientHeight + 20; });
        if (scrollable) break;
        await S.page.locator('#zoom-in').click();
      }
      const box = await S.page.locator('#canvas').boundingBox();
      const x = box.x + 10, y = box.y + 120;
      await S.page.mouse.move(x, y);
      await S.page.mouse.down();
      await S.page.mouse.move(x, y - 70, { steps: 4 });
      await S.page.mouse.up();
      await check(S.page, 'background drag pans canvas', () => document.getElementById('canvas').scrollTop > 0 && !document.getElementById('canvas').classList.contains('dragging'));
      await S.page.locator('#zoom-fit').click();
    });

    it('AI view defaults to its configured group', async () => {
      await workspace('ai').click();
      const group = views.ai.default;
      await check(S.page, 'AI default is the ' + group + ' group (' + count('ai', group) + ' nodes)',
        ({ n, group }) => document.querySelectorAll('.node').length === n && document.querySelector('[data-group="' + group + '"]').getAttribute('aria-pressed') === 'true',
        { n: count('ai', group), group });
    });

    it('A connection shows its connector and copies the whole chain', async t => {
      await filter(gatemcp.group).click();
      await check(S.page, 'Dependency connector exists', n => document.querySelectorAll('.edges path').length === n, connectorsAmong(visibleIds('ai', gatemcp.group)));
      await node(gatemcp).click();
      await copiedMatchesInspector('Chain clipboard matches the inspector');
      // literals kept on purpose
      await check(S.page, 'The chain copies the HTTP prerequisite and MCP target', async () => { const text = await window.__readCopied(); return text.includes('start_gate_server.sh') && text.includes('start_gate_mcp.sh') && text.includes('/health'); });
      await check(S.page, 'inspector shows the full chain', names => !document.getElementById('chain-summary').hidden && document.getElementById('chain-summary').textContent.includes(names), chainNames(gatemcp.id));
      await shot(t, 'connections.png');
    });

    it('model group lists every model server and keeps a long command intact', async () => {
      await filter(cedar.group).click();
      await nodesEqual('model group contains every alternative', count('ai', cedar.group));
      await node(cedar).click();
      // literal kept on purpose
      await check(S.page, 'long command preserved in full', () => document.getElementById('command').value.endsWith('serve-12gb-lean.sh'));
      await copiedMatchesInspector('clipboard contains full long command');
    });

    it('a blocked node cannot copy', async () => {
      await filter(stalled.group).click();
      await node(stalled).click();
      await check(S.page, 'blocked node cannot copy', () => document.getElementById('copy-command').disabled && !document.getElementById('detail-warning').hidden);
    });

    it('denied clipboard falls back to the legacy copy path, then to manual copy', async () => {
      await filter(pilot.group).click();
      await evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; });
      await node(pilot).click();
      await copiedMatchesInspector('legacy fallback clipboard matches the inspector');
      // literal kept on purpose
      await check(S.page, 'legacy fallback copies exact command', async () => (await window.__readCopied()) === '/usr/bin/pilot');
      await evaluate(() => { document.execCommand = () => false; });
      await node(coder).click();
      await check(S.page, 'denied clipboard offers manual copy', () => !document.getElementById('manual-hint').hidden && document.getElementById('toast').textContent.startsWith('Clipboard blocked'));
      await check(S.page, 'manual text is selected', () => document.getElementById('command').selectionEnd === document.getElementById('command').value.length);
      await evaluate(() => window.__restoreClipboard());
    });

    it('services view: nodes, connectors, and a filtered node still copies its chain', async () => {
      await workspace('services').click();
      await nodesEqual('service view shows every service node', count('services'));
      await check(S.page, 'service graph has dependency paths', n => document.querySelectorAll('.edges path').length === n, connectorsAmong(visibleIds('services', views.services.default)));
      assert.notEqual(engine.group, ledger.group, 'the prerequisite lives outside the filtered group');
      await filter(ledger.group).click();
      await check(S.page, 'filter hides prerequisite nodes', id => !document.querySelector('.node[data-id="' + id + '"]'), engine.id);
      await node(ledger).click();
      await copiedMatchesInspector('filtered node still copies its full dependency chain');
      // literals kept on purpose
      await check(S.page, 'chain includes the engine, compose and readiness probe', async () => { const text = await window.__readCopied(); return text.includes('/usr/bin/demo-engine') && text.includes('docker compose up -d') && text.includes('docker info'); });
      await check(S.page, 'chain order is visible in inspector', names => document.getElementById('chain-summary').textContent.includes(names), chainNames(ledger.id));
      const prerequisites = prerequisiteCount(ledger.id) + ' prerequisite';
      await check(S.page, 'chain feedback names prerequisites', text => document.getElementById('toast').textContent.includes(text), prerequisites);
      await evaluate(id => { document.getElementById('toast').textContent = ''; document.querySelector('.node[data-id="' + id + '"]').focus(); }, ledger.id);
      await S.page.keyboard.press('Enter');
      await check(S.page, 'keyboard copies the same startup chain', text => document.getElementById('toast').textContent.includes(text), prerequisites);
      await S.page.locator('#copy-command').click();
      await copiedMatchesInspector('inspector copy matches the preview exactly');
    });

    it('a blocked dependency disables downstream copying and leaves the clipboard alone', async () => {
      await evaluate(id => { window.chainBeforeBlocked = document.getElementById('command').value; apps.find(app => app.id === id).status = 'blocked'; }, engine.id);
      try {
        await node(ledger).click();
        await check(S.page, 'blocked dependency disables downstream copying', name => document.getElementById('copy-command').disabled && document.getElementById('detail-warning').textContent.includes(name), engine.name);
        await check(S.page, 'blocked dependency leaves clipboard unchanged', async () => (await window.__readCopied()) === window.chainBeforeBlocked);
      } finally {
        await evaluate(id => { delete apps.find(app => app.id === id).status; }, engine.id);
      }
    });

    it('manual fallback selects the entire chain', async () => {
      await evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; document.execCommand = () => false; });
      await node(ledger).click();
      // literal kept on purpose
      await check(S.page, 'manual fallback selects the entire chain', () => !document.getElementById('manual-hint').hidden && document.getElementById('command').value.includes('docker info') && document.getElementById('command').selectionEnd === document.getElementById('command').value.length);
      await evaluate(() => window.__restoreClipboard());
    });

    it('the toast dismisses itself', async t => {
      await filter('all').click();
      await node(ledger).click();
      await check(S.page, 'toast is shown', () => document.getElementById('toast').classList.contains('show'));
      await check(S.page, 'toast dismisses', () => !document.getElementById('toast').classList.contains('show'), undefined, TOAST_TIMEOUT);
      await shot(t, 'services.png');
    });

    it('mobile layout uses one column, hides connectors and still copies chains', async t => {
      await viewport(390, 844);
      await fits('mobile has no horizontal document overflow');
      await check(S.page, 'mobile uses one column', () => getComputedStyle(document.querySelector('.node-grid')).gridTemplateColumns.split(' ').length === 1);
      await check(S.page, 'mobile hides desktop connectors', () => getComputedStyle(document.querySelector('.edges')).display === 'none');
      await evaluate(() => window.scrollTo(0, 0));
      await shot(t, 'mobile.png');
      await node(ledger).click();
      await copiedMatchesInspector('mobile copies the complete startup chain');
      // literals kept on purpose
      await check(S.page, 'mobile chain includes the engine and compose', async () => { const text = await window.__readCopied(); return text.includes('/usr/bin/demo-engine') && text.includes('docker compose up -d'); });
      await node(shelf).click();
      await check(S.page, 'mobile copy works', prefix => document.getElementById('toast').textContent.startsWith(prefix), copiedPrefix(shelf));
    });

    it('no document overflow at 320/700/768/1024/1170', async () => {
      for (const width of [320, 700, 768, 1024, 1170]) {
        await viewport(width, 900);
        await fits(width + 'px viewport has no document overflow');
      }
    });

    it('reduced motion disables transitions', async () => {
      await S.page.emulateMedia({ reducedMotion: 'reduce' });
      await check(S.page, 'reduced motion disables transitions', () => getComputedStyle(document.querySelector('.node')).transitionDuration === '0s');
      await S.page.emulateMedia({ reducedMotion: null });
    });

    it('footer: preservation is locked where cleanup is unverified; re-launch and removal copy only', async () => {
      await viewport(1440, 1000);
      await workspace('desktop').click();
      await evaluate(() => window.scrollTo(0, 0));
      await node(modeler).click();
      await check(S.page, 'footer preservation is checked and locked where cleanup is unverified', () => document.getElementById('preserve-settings').checked && document.getElementById('preserve-settings').disabled);
      await S.page.locator('#copy-relaunch').click();
      // literal kept on purpose
      await check(S.page, 're-launch clipboard exactly matches preview', async () => { const text = await window.__readCopied(); return text === document.getElementById('relaunch-command').value && text.includes('RELAUNCH modeler'); });
      await check(S.page, 'copy confirms nothing executed', () => document.getElementById('toast').textContent.includes('Nothing executed'));
      await S.page.locator('#relaunch-preview summary').click();
      await check(S.page, 're-launch preview expands', () => document.getElementById('relaunch-preview').open);
      await S.page.locator('#copy-remove').click();
      // literal kept on purpose
      await check(S.page, 'package removal clipboard exactly matches preview', async () => { const text = await window.__readCopied(); return text === document.getElementById('remove-command').value && text.includes('sudo pacman -R -- modeler'); });
      await S.page.locator('#remove-preview summary').click();
      await check(S.page, 'removal preview expands', () => document.getElementById('remove-preview').open);
      await evaluate(() => { document.getElementById('copy-remove').focus(); document.getElementById('toast').textContent = ''; });
      await S.page.keyboard.press('Enter');
      await check(S.page, 'keyboard copies removal only', text => document.getElementById('toast').textContent === text, 'Copied ' + modeler.name + ' removal script. Nothing executed.');
    });

    it('footer: legacy and manual fallbacks select the right preview', async () => {
      await evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; });
      await S.page.locator('#copy-relaunch').click();
      await check(S.page, 'action legacy fallback copies exact script', async () => (await window.__readCopied()) === document.getElementById('relaunch-command').value);
      await evaluate(() => { document.execCommand = () => false; });
      await S.page.locator('#copy-remove').click();
      await check(S.page, 'manual removal copy reveals and selects the full preview', () => document.getElementById('remove-preview').open && !document.getElementById('remove-manual').hidden && document.activeElement.id === 'remove-command' && document.getElementById('remove-command').selectionEnd === document.getElementById('remove-command').value.length);
      await S.page.locator('#copy-relaunch').click();
      await check(S.page, 'manual re-launch copy selects the correct preview', () => !document.getElementById('relaunch-manual').hidden && document.activeElement.id === 'relaunch-command' && document.getElementById('relaunch-command').selectionEnd === document.getElementById('relaunch-command').value.length);
      await evaluate(() => window.__restoreClipboard());
    });

    it('footer: an unverified removal explains itself and disables its copy', async () => {
      await node(gameeditor).click();
      await check(S.page, 'unverified removal has an explanation, disabled copy, and no stale script', name => document.getElementById('copy-remove').disabled && document.getElementById('remove-command').value === '' && document.getElementById('remove-preview').hidden && document.getElementById('remove-note').textContent.includes(name), gamehub.name);
    });

    it('footer: a broken entry disables both actions', async () => {
      await workspace('ai').click();
      await filter(stalled.group).click();
      await node(stalled).click();
      await check(S.page, 'broken entry disables footer actions', () => document.getElementById('copy-relaunch').disabled && document.getElementById('copy-remove').disabled);
    });

    it('header shows the logo and the inline favicon loads under the page policy', async () => {
      await check(S.page, 'the header mark draws the logo', () => { const svg = document.querySelector('.brand-mark svg'); const mark = document.querySelector('.brand-mark'), logo = svg && svg.querySelector('path'); return !!logo && svg.children.length === 1 && getComputedStyle(logo).fill === 'rgb(20, 23, 15)' && getComputedStyle(mark).backgroundColor === 'rgb(201, 245, 63)' && svg.getBoundingClientRect().width === mark.getBoundingClientRect().width; });
      await check(S.page, 'the favicon loads with img-src data: only', () => new Promise(done => { const link = document.querySelector('link[rel="icon"]'); if (!link) return done(false); const img = new Image(); img.onload = () => done(img.naturalWidth > 0); img.onerror = () => done(false); img.src = link.href; }));
    });

    it('hovering a card traces its startup chain without moving the layout', async () => {
      await viewport(1440, 1000);
      await workspace('services').click();
      const before = await evaluate(() => Array.from(document.querySelectorAll('.node')).map(n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(); }).join('|'));
      await node(ledger).hover();
      await check(S.page, 'the chain lights up in order and the rest fades', () => document.getElementById('board').classList.contains('tracing')
        && document.querySelector('.node[data-id="ledger"]').classList.contains('on-trace') && document.querySelector('.node[data-id="engine"]').classList.contains('on-trace')
        && !document.querySelector('.node[data-id="scraper"]').classList.contains('on-trace')
        && document.querySelectorAll('.edges path.trace').length === 1 && document.querySelector('.edges path.trace').dataset.from === 'engine');
      await check(S.page, 'dots flow along the traced link', () => document.querySelectorAll('.edges .trace-dot animateMotion').length > 0);
      const during = await evaluate(() => Array.from(document.querySelectorAll('.node')).map(n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(); }).join('|'));
      assert.equal(during, before, 'no card moves or resizes while tracing');
      await S.page.mouse.move(2, 2);
      await check(S.page, 'leaving the map clears the trace', () => !document.getElementById('board').classList.contains('tracing') && !document.querySelector('.on-trace') && !document.querySelector('.edges .trace, .edges .trace-dot'));
      await S.page.emulateMedia({ reducedMotion: 'reduce' });
      await S.page.mouse.move(2, 2);
      await node(ledger).hover();
      await check(S.page, 'reduced motion: the chain still lights, nothing travels', () => document.querySelector('.node[data-id="engine"]').classList.contains('on-trace') && !document.querySelector('.edges .trace-dot'));
      await S.page.emulateMedia({ reducedMotion: null });
      await S.page.mouse.move(2, 2);
    });

    it('footer: map entry copies the check and the Claude prompts, with a manual fallback', async () => {
      await workspace('desktop').click();
      await node(modeler).click();
      await check(S.page, 'map entry preview starts on the update prompt', () => document.getElementById('map-command').value.startsWith("claude '") && document.getElementById('map-command').value.includes('update modeler'));
      await S.page.locator('#copy-map-check').click();
      await check(S.page, 'map check copies the read-only check', async () => (await window.__readCopied()) === 'python3 ~/.claude/skills/launchpad-add-cell/scripts/add_cell.py check' && document.getElementById('map-command').value === window.__copied);
      await S.page.locator('#copy-map-update').click();
      await check(S.page, 'update prompt copies what the preview shows', async () => { const text = await window.__readCopied(); return text === document.getElementById('map-command').value && text.includes('update modeler'); });
      await check(S.page, 'update copy says nothing executed', () => document.getElementById('toast').textContent.includes('Nothing executed'));
      await S.page.locator('#copy-map-remove').click();
      await check(S.page, 'remove prompt edits the map only', async () => { const text = await window.__readCopied(); return text === document.getElementById('map-command').value && text.includes('remove modeler') && text.includes('do not uninstall'); });
      await evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; document.execCommand = () => false; });
      await S.page.locator('#copy-map-update').click();
      await check(S.page, 'manual map copy reveals and selects the full command', () => document.getElementById('map-preview').open && !document.getElementById('map-manual').hidden && document.activeElement.id === 'map-command' && document.getElementById('map-command').selectionEnd === document.getElementById('map-command').value.length && document.getElementById('map-command').value.includes('update modeler'));
      await evaluate(() => window.__restoreClipboard());
      await workspace('ai').click();
      await filter(stalled.group).click();
      await node(stalled).click();
      await check(S.page, 'a broken entry keeps its map entry buttons, the fix it needs', () => !document.getElementById('copy-map-update').disabled && !document.getElementById('copy-map-remove').disabled && document.getElementById('map-manual').hidden);
    });

    it('footer: compose removal preserves volumes unless cleanup is explicit', async () => {
      await workspace('services').click();
      await node(ledger).click();
      await check(S.page, 'compose removal preserves volumes by default', () => document.getElementById('preserve-settings').checked && !document.getElementById('preserve-settings').disabled && !document.getElementById('remove-command').value.includes('--volumes'));
      await S.page.locator('#copy-relaunch').click();
      // literal kept on purpose
      await check(S.page, 'compose re-launch clipboard matches restart preview', async () => { const text = await window.__readCopied(); return text === document.getElementById('relaunch-command').value && text.includes('restart'); });
      await S.page.getByRole('checkbox', { name: 'Preserve settings & saved data' }).click();
      // literals kept on purpose
      await check(S.page, 'explicit cleanup changes preview and shows data loss warning', () => !document.getElementById('data-warning').hidden && document.getElementById('remove-command').value.includes('--volumes') && document.getElementById('remove-command').value.includes('DELETE DATA ledger'));
      await S.page.locator('#copy-remove').click();
      await check(S.page, 'destructive clipboard matches the reviewed script', async () => (await window.__readCopied()) === document.getElementById('remove-command').value);
      await node(scraper).click();
      await check(S.page, 'selecting another app resets preservation', () => document.getElementById('preserve-settings').checked && document.getElementById('data-warning').hidden && !document.getElementById('remove-command').value.includes('--volumes'));
    });

    it('a delayed clipboard failure cannot select an old app or run a stale fallback', async () => {
      await evaluate(() => {
        navigator.clipboard.writeText = () => new Promise((resolve, reject) => { window.rejectActionCopy = reject; });
        window.staleFallbackCalls = 0;
        document.execCommand = () => { window.staleFallbackCalls++; return false; };
      });
      await S.page.locator('#copy-remove').click();
      await evaluate(id => { select(id); window.rejectActionCopy(Error('delayed denial')); }, ledger.id);
      await check(S.page, 'delayed clipboard failure cannot select an old app', name => document.getElementById('detail-name').textContent === name && document.getElementById('remove-manual').hidden && !document.getElementById('copy-remove').disabled, ledger.name);
      await check(S.page, 'delayed clipboard failure never invokes a stale fallback', () => window.staleFallbackCalls === 0);
      await check(S.page, 'footer names the selected app even when inspector header is offscreen', name => document.getElementById('action-app-name').textContent === name, ledger.name);
      await evaluate(() => window.__restoreClipboard());
    });

    it('footer screenshots on desktop and mobile; mobile footer copy works', async t => {
      await viewport(1440, 1000);
      await evaluate(() => document.querySelector('.maintenance').scrollIntoView({ block: 'start' }));
      await shot(t, 'actions-desktop.png');
      await viewport(390, 844);
      await S.page.locator('#copy-remove').click();
      await check(S.page, 'mobile footer copy works', async () => (await window.__readCopied()) === document.getElementById('remove-command').value);
      await evaluate(() => document.querySelector('.maintenance').scrollIntoView({ block: 'start' }));
      await shot(t, 'actions-mobile.png');
    });

    it('expanded footer fits every viewport and action buttons meet the touch target minimum', async () => {
      await S.page.locator('#remove-preview summary').click();
      await check(S.page, 'removal preview is expanded', () => document.getElementById('remove-preview').open);
      for (const width of [320, 390, 700, 768, 1024, 1170, 1440]) {
        await viewport(width, 900);
        await fits(width + 'px expanded footer fits viewport');
        await check(S.page, width + 'px action buttons meet touch target minimum', () => Array.from(document.querySelectorAll('.action-copy')).every(el => el.getBoundingClientRect().height >= 44));
      }
      // Leave the selected service in its safe default state.
      await evaluate(() => { document.getElementById('remove-preview').open = false; document.querySelector('.maintenance').scrollIntoView({ block: 'start' }); });
    });

    it('no uncaught runtime exceptions', async t => {
      if (S.consoleErrors.length) t.diagnostic('console errors (not asserted): ' + JSON.stringify(S.consoleErrors));
      assert.deepEqual(S.pageErrors.map(error => error.message), [], 'uncaught exceptions on the page');
      t.diagnostic('screenshots in ' + SHOTS_DIR + ': ' + S.shots.map(file => path.basename(file)).join(', '));
      for (const file of S.shots) assert.ok(fs.statSync(file).size > 0, 'screenshot written: ' + file);
    });
  });
}

// ---------------------------------------------------------------------------
// Real clipboard round-trip (always attempted; skips when Chromium refuses the grant)
// ---------------------------------------------------------------------------
function defineRealClipboardRoundTrip(getBrowser) {
  test('real clipboard: granted permissions let the page write what the inspector shows', { timeout: 30000 }, async t => {
    const context = await getBrowser().newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const refused = await grantClipboard(context);
      if (refused) return t.skip('Chromium refused clipboard permissions for this context: ' + refused);
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(PAGE_URL);
      await page.locator('.view[data-view="desktop"]').click();
      await page.locator('.node[data-id="' + modeler.id + '"]').click();
      let text;
      try { text = await page.evaluate(() => navigator.clipboard.readText()); }
      catch (error) { return t.skip('navigator.clipboard.readText() is not available on the file:// origin: ' + error.message.split('\n')[0]); }
      assert.equal(text, await page.locator('#command').inputValue(), 'real clipboard matches the inspector textarea');
      // The legacy execCommand path writes to the same clipboard.
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; });
      await page.locator('.node[data-id="' + gamehub.id + '"]').click();
      await check(page, 'real clipboard receives the legacy fallback copy', async () => (await navigator.clipboard.readText()) === document.getElementById('command').value);
      await page.locator('#copy-relaunch').click();
      await check(page, 'real clipboard receives the footer re-launch script', async () => (await navigator.clipboard.readText()) === document.getElementById('relaunch-command').value);
    } finally {
      await context.close();
    }
  });
}

// ---------------------------------------------------------------------------
// axe-core scan at desktop and phone widths
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Catalog guards: a broken cell stays visible and the page says what is wrong
// ---------------------------------------------------------------------------
async function withPage(getBrowser, pageHtml, fn, options = {}) {
  const dir = pageHtml === null ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-page-'));
  const context = await getBrowser().newContext({ viewport: options.viewport || { width: 1440, height: 1000 }, colorScheme: options.colorScheme || 'dark' });
  try {
    await context.addInitScript(clipboardHarness, { mode: 'stub' });
    await context.addInitScript(startOnDesktop);
    if (options.theme) await context.addInitScript(theme => { try { if (!sessionStorage.getItem('theme-seeded')) { localStorage.setItem('launchpad', JSON.stringify({ theme, workspace: 'desktop' })); sessionStorage.setItem('theme-seeded', '1'); } } catch {} }, options.theme);
    if (dir) fs.writeFileSync(path.join(dir, 'index.html'), pageHtml);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(dir ? pathToFileURL(path.join(dir, 'index.html')).href : PAGE_URL);
    await fn(page);
    assert.deepEqual(errors, [], 'no uncaught exceptions');
  } finally {
    await context.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}
function defineCatalogGuards(getBrowser) {
  describe('catalog guards', describeOptions, () => {
    test('a cell in an undeclared group is still drawn, and the page names the problem', async () => {
      const probe = { ...modeler, id: 'zz-probe', name: 'Zed Probe', group: 'mystery', icon: 'unicorn' };
      const altered = html.replace(/\n\{"id":"modeler"[^\n]*\n/, line => line + JSON.stringify(probe) + ',\n');
      assert.notEqual(altered, html, 'probe cell inserted');
      await withPage(getBrowser, altered, async page => {
        await check(page, 'the unlisted cell is drawn', () => !!document.querySelector('.node[data-id="zz-probe"]'));
        await check(page, 'the banner names both problems', () => {
          const banner = document.getElementById('catalog-problems');
          return !!banner && !banner.hidden && banner.textContent.includes('"mystery"') && banner.textContent.includes('"unicorn"');
        });
      });
    });
    test('a valid catalog shows no banner and says when file presence was checked', async () => {
      assert.ok(catalogMeta.checked, 'catalog-meta has a date');
      await withPage(getBrowser, html, async page => {
        await check(page, 'no banner', () => document.getElementById('catalog-problems').hidden);
        await check(page, 'sidebar states the date', date => document.getElementById('checked-note').textContent.includes(date), catalogMeta.checked);
        await check(page, 'launcher row states the date', date => document.getElementById('detail-status').textContent.includes(date), catalogMeta.checked);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Behaviour: one fresh page per test (audit findings F06-F49, wave B)
// ---------------------------------------------------------------------------
const nodeSel = id => '.node[data-id="' + id + '"]';
const toastText = page => page.evaluate(() => document.getElementById('toast').textContent);
async function pendingClipboard(page) {
  await page.evaluate(() => {
    window.__pendingCalls = 0;
    navigator.clipboard.writeText = () => new Promise((resolve, reject) => { window.__pendingCalls++; window.__rejectCopy = reject; });
    document.execCommand = () => false;
  });
}
function defineBehaviour(getBrowser) {
  describe('behaviour', describeOptions, () => {
    const live = (fn, options) => withPage(getBrowser, null, fn, options);

    test('clearing the search restores the group that was active before it', async () => {
      await live(async page => {
        await page.click('.view[data-view="ai"]');
        await page.fill('#search', 'orbit');
        await check(page, 'typing switches to All', () => document.querySelector('#filters [aria-pressed="true"]').dataset.group === 'all');
        await page.press('#search', 'Escape');
        await check(page, 'Escape restores the workspace default group', ([group, n]) =>
          document.querySelector('#filters [aria-pressed="true"]').dataset.group === group && document.querySelectorAll('.node').length === n,
          [views.ai.default, count('ai', views.ai.default)]);
        await page.click('#filters .filter[data-group="models"]');
        await page.fill('#search', 'reason');
        await page.fill('#search', '');
        await check(page, 'emptying the box restores the chosen group', () => document.querySelector('#filters [aria-pressed="true"]').dataset.group === 'models');
      });
    });

    test('a chain with warnings says so in its copy confirmation', async () => {
      await live(async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await check(page, 'toast mentions the warnings', () => /review the warnings/i.test(document.getElementById('toast').textContent));
      });
    });

    test('an empty search offers matches in the other workspaces', async () => {
      const expected = core.filterApps(catalog, 'ai', 'all', 'orbit').length;
      assert.ok(expected > 0);
      await live(async page => {
        await page.fill('#search', 'orbit');
        await check(page, 'empty state offers the AI workspace', title => {
          const button = Array.from(document.querySelectorAll('#empty button')).find(b => b.textContent.includes(title));
          return !document.getElementById('empty').hidden && !!button;
        }, views.ai.title);
        await page.locator('#empty button', { hasText: views.ai.title }).click();
        await check(page, 'switches workspace and keeps the query', n =>
          document.querySelector('.view[aria-pressed="true"]').dataset.view === 'ai' && document.getElementById('search').value === 'orbit' && document.querySelectorAll('.node').length === n, expected);
      });
    });

    test('a late clipboard failure never selects an app from another workspace', async () => {
      await live(async page => {
        await pendingClipboard(page);
        await page.click(nodeSel(modeler.id));
        await page.click('.view[data-view="ai"]');
        const before = await page.evaluate(() => document.getElementById('detail-name').textContent);
        await page.evaluate(() => window.__rejectCopy(Error('late denial')));
        await check(page, 'inspector keeps the AI selection', name => document.getElementById('detail-name').textContent === name, before);
        await check(page, 'toast explains the failure', name => document.getElementById('toast').textContent.includes('Clipboard blocked') && document.getElementById('toast').textContent.includes(name), modeler.name);
      });
    });

    test('a footer copy that fails after the selection changed still reports the failure', async () => {
      await live(async page => {
        await page.click(nodeSel(modeler.id));
        await pendingClipboard(page);
        await page.click('#copy-remove');
        await page.evaluate(() => { window.__rejectFooter = window.__rejectCopy; navigator.clipboard.writeText = async () => {}; });
        await page.click(nodeSel(gamehub.id));
        await check(page, 'the new selection copied normally', name => document.getElementById('toast').textContent.startsWith('Copied ' + name), gamehub.name);
        await page.evaluate(() => { document.getElementById('toast').textContent = ''; window.__rejectFooter(Error('late denial')); });
        await check(page, 'toast reports the blocked clipboard', () => document.getElementById('toast').textContent.includes('Clipboard blocked'));
      });
    });

    test('a node whose prerequisite is blocked looks and reads as unavailable', async () => {
      const blockedEngine = { ...engine, status: 'blocked', warning: 'Test: engine missing.' };
      const order = ['id', 'name', 'view', 'group', 'type', 'command', 'port', 'note', 'status', 'warning', 'icon', 'tone'];
      const line = JSON.stringify(Object.fromEntries(order.filter(k => k in blockedEngine).map(k => [k, blockedEngine[k]])));
      const pageHtml = html.replace(/\{"id":"engine",[^\n]*\}/, line);
      assert.notEqual(pageHtml, html);
      await withPage(getBrowser, pageHtml, async page => {
        await page.click('.view[data-view="services"]');
        await check(page, 'dependent node is marked unavailable', id => {
          const node = document.querySelector('.node[data-id="' + id + '"]');
          return node.classList.contains('blocked') && /prerequisite/i.test(node.querySelector('.flag')?.textContent || '');
        }, ledger.id);
      });
    });

    test('a single result reads "1 node"', async () => {
      await live(async page => {
        await page.fill('#search', modeler.command);
        await check(page, 'singular count', () => /^1 node\b/.test(document.getElementById('visible-count').textContent));
      });
    });

    test('footer previews start at the top after a manual-copy fallback', async () => {
      await live(async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await page.uncheck('#preserve-settings');
        await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; document.execCommand = () => false; });
        await page.click('#copy-remove');
        await check(page, 'manual fallback scrolled the long script', () => {
          const t = document.getElementById('remove-command');
          return t.scrollHeight > t.clientHeight && t.scrollTop > 0;
        });
        await page.click(nodeSel(scraper.id));
        await page.evaluate(() => { document.getElementById('remove-preview').open = true; });
        await check(page, 'next app starts at the top', () => document.getElementById('remove-command').scrollTop === 0);
      });
    });

    test('activating a group chip keeps keyboard focus on it', async () => {
      await live(async page => {
        await page.click('.view[data-view="ai"]');
        await page.focus('#filters .filter[data-group="models"]');
        await page.keyboard.press('Enter');
        await check(page, 'focus stays on the chip', () => document.activeElement?.dataset?.group === 'models');
      });
    });

    test('the toast empties after it fades', async () => {
      await live(async page => {
        await page.click(nodeSel(modeler.id));
        await check(page, 'toast shown', () => document.getElementById('toast').classList.contains('show'));
        await check(page, 'toast hidden and empty', () => !document.getElementById('toast').classList.contains('show') && document.getElementById('toast').textContent === '', undefined, TOAST_TIMEOUT);
      });
    });

    test('a manual zoom survives a window resize', async () => {
      await live(async page => {
        await page.click('#zoom-in');
        await page.click('#zoom-in');
        const zoomed = await page.textContent('#zoom-value');
        await page.setViewportSize({ width: 1300, height: 1000 });
        await page.waitForTimeout(250);
        assert.equal(await page.textContent('#zoom-value'), zoomed);
      });
    });

    test('zoom buttons show their limits and "/" ignores modified keys', async () => {
      await live(async page => {
        const pressUntilLimit = async id => {
          for (let i = 0; i < 20 && await page.getAttribute(id, 'aria-disabled') !== 'true'; i++) await page.click(id);
          await page.click(id, { force: true });
        };
        await pressUntilLimit('#zoom-in');
        assert.equal(await page.textContent('#zoom-value'), '150%');
        assert.equal(await page.getAttribute('#zoom-in', 'aria-disabled'), 'true');
        await pressUntilLimit('#zoom-out');
        assert.equal(await page.textContent('#zoom-value'), '60%');
        assert.equal(await page.getAttribute('#zoom-out', 'aria-disabled'), 'true');
        await page.evaluate(() => document.activeElement.blur());
        await page.keyboard.press('Control+/');
        assert.notEqual(await page.evaluate(() => document.activeElement.id), 'search');
      });
    });

    test('the command box and copy button stay put when the selection gains a chain', async () => {
      await live(async page => {
        await page.click(nodeSel(modeler.id));
        const before = await page.evaluate(() => [document.getElementById('command').getBoundingClientRect().top, document.getElementById('copy-command').getBoundingClientRect().top]);
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        const after = await page.evaluate(() => [document.getElementById('command').getBoundingClientRect().top, document.getElementById('copy-command').getBoundingClientRect().top]);
        assert.ok(Math.abs(after[0] - before[0]) <= 1 && Math.abs(after[1] - before[1]) <= 1, JSON.stringify({ before, after }));
      });
    });

    test('dependency arrows start and end on their sockets and never cross a card', async () => {
      await live(async page => {
        for (const [view, group] of [['services', 'all'], ['ai', 'all']]) {
          await page.click('.view[data-view="' + view + '"]');
          await page.click('#filters .filter[data-group="' + group + '"]');
          await page.waitForTimeout(150);
          const report = await page.evaluate(() => {
            const board = document.getElementById('board').getBoundingClientRect();
            const scale = board.width / document.getElementById('board').offsetWidth;
            const local = r => ({ left: (r.left - board.left) / scale, top: (r.top - board.top) / scale, right: (r.right - board.left) / scale, bottom: (r.bottom - board.top) / scale });
            const centre = el => { const r = local(el.getBoundingClientRect()); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; };
            const nodes = Array.from(document.querySelectorAll('.node'));
            const problems = [];
            for (const node of nodes) {
              const head = local(node.querySelector('.node-head').getBoundingClientRect());
              const socket = centre(node.querySelector('.socket.output'));
              if (socket.y < head.top + 4 || socket.y > head.bottom - 4) problems.push(node.dataset.id + ': socket outside its header');
            }
            const paths = Array.from(document.querySelectorAll('.edges path'));
            for (const path of paths) {
              const total = path.getTotalLength(), start = path.getPointAtLength(0), end = path.getPointAtLength(total);
              const from = document.querySelector('.node[data-id="' + path.dataset.from + '"]'), to = document.querySelector('.node[data-id="' + path.dataset.to + '"]');
              if (!from || !to) { problems.push('path without data-from/data-to'); continue; }
              const a = centre(from.querySelector('.socket.output')), b = centre(to.querySelector('.socket.input'));
              if (Math.hypot(start.x - a.x, start.y - a.y) > 1.5) problems.push(path.dataset.from + ': starts off its socket');
              if (Math.hypot(end.x - b.x, end.y - b.y) > 1.5) problems.push(path.dataset.to + ': ends off its socket');
              for (let s = 10; s < total - 10; s += 4) {
                const p = path.getPointAtLength(s);
                for (const node of nodes) {
                  const r = local(node.getBoundingClientRect());
                  if (p.x > r.left + 2 && p.x < r.right - 2 && p.y > r.top + 2 && p.y < r.bottom - 2) { problems.push(path.dataset.from + '→' + path.dataset.to + ' crosses ' + node.dataset.id); s = total; break; }
                }
              }
            }
            return { paths: paths.length, problems };
          });
          assert.ok(report.paths > 0, view + ' draws arrows');
          assert.deepEqual(report.problems, [], view);
        }
      });
    });

    test('the inspector names the cells that share a port', async () => {
      const others = core.sharedPorts(catalog, 'orbit7').map(app => app.name);
      assert.ok(others.length > 0);
      await live(async page => {
        await page.click('.view[data-view="ai"]');
        await page.click('#filters .filter[data-group="models"]');
        await page.click(nodeSel('orbit7'));
        await check(page, 'ports row lists the collisions', names => names.every(name => document.getElementById('detail-port').textContent.includes(name)), others);
      });
    });

    test('a chain is explained as numbered steps', async () => {
      const steps = core.startupPlan(catalog, core.connections, ledger.id).steps;
      await live(async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await check(page, 'steps rendered in order', expected => {
          const items = Array.from(document.querySelectorAll('#chain-steps li'), li => li.textContent);
          return items.length === expected.length && items.every((t, i) => t === expected[i]);
        }, steps);
        await page.click('.view[data-view="desktop"]');
        await page.click(nodeSel(modeler.id));
        await check(page, 'single commands hide the steps', () => document.getElementById('chain-steps').closest('[hidden]') !== null || document.getElementById('chain-steps').hidden);
      });
    });

    test('badges, chain hints and the copy label follow the catalog', async () => {
      await live(async page => {
        for (const view of Object.keys(views)) {
          assert.equal(Number(await page.textContent('.view[data-view="' + view + '"] .view-count')), count(view), view + ' badge');
        }
        await page.click('.view[data-view="services"]');
        const n = prerequisiteCount(ledger.id);
        assert.match(await page.textContent(nodeSel(ledger.id) + ' .chain-hint'), new RegExp('Includes ' + n + ' prerequisite' + (n === 1 ? '' : 's')));
        await page.click('.view[data-view="desktop"]');
        await page.click(nodeSel(modeler.id));
        await check(page, 'label confirms the copy', () => document.getElementById('copy-label').textContent === 'Copied');
        await check(page, 'label resets', () => document.getElementById('copy-label').textContent === 'Copy command', undefined, 3000);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Accessibility and responsive layout (audit findings F10-F53, wave C)
// ---------------------------------------------------------------------------
function defineAccessibleLayout(getBrowser) {
  describe('accessibility and layout', describeOptions, () => {
    const live = (fn, options) => withPage(getBrowser, null, async page => { await page.evaluate(installContrast); await fn(page); }, options);

    test('cards are named by their visible text and say what they do; selection is aria-current', async () => {
      await live(async page => {
        await check(page, 'modeler card name', () => {
          const node = document.querySelector('.node[data-id="modeler"]');
          return !node.hasAttribute('aria-label') && !node.hasAttribute('aria-pressed') && node.getAttribute('aria-current') === 'true';
        });
        assert.equal(await page.getByRole('button', { name: /^Modeler\b[\s\S]*copy startup command$/ }).count(), 1);
        await page.click('.view[data-view="ai"]');
        await page.click('#filters .filter[data-group="attention"]');
        assert.equal(await page.getByRole('button', { name: new RegExp('^' + stalled.name + '\\b[\\s\\S]*setup incomplete, open details$') }).count(), 1);
      });
    });

    test('map text never renders below 11 px and the canvas never needs a sideways scrollbar', async () => {
      await live(async page => {
        for (const width of [701, 720, 768, 1024, 1170, 1171, 1280, 1366, 1440, 1920]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.click('#zoom-fit');
          await page.waitForTimeout(150);
          const report = await page.evaluate(() => {
            const zoom = parseInt(document.getElementById('zoom-value').textContent, 10) / 100;
            const sizes = Array.from(document.querySelectorAll('.board .node *, .board .lane-heading'))
              .filter(el => el.childElementCount === 0 && el.textContent.trim())
              .map(el => parseFloat(getComputedStyle(el).fontSize) * zoom);
            const canvas = document.getElementById('canvas');
            return { smallest: Math.min(...sizes), overflow: canvas.scrollWidth - canvas.clientWidth };
          });
          assert.ok(report.smallest >= 11, width + 'px: smallest map text ' + report.smallest.toFixed(1) + ' px');
          assert.ok(report.overflow <= 1, width + 'px: canvas overflows by ' + report.overflow + ' px');
        }
      });
    });

    test('labelled containers carry roles that allow their labels', async () => {
      await live(async page => {
        assert.equal(await page.getAttribute('#canvas', 'role'), 'region');
        assert.equal(await page.getAttribute('#filters', 'role'), 'group');
        assert.equal(await page.getAttribute('.zoom', 'role'), 'group');
      });
    });

    test('control boundaries reach 3:1 and disabled button text reaches 4.5:1', async () => {
      await live(async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        const borders = await page.evaluate(() => ['.search', '#command', '#copy-relaunch', '#filters .filter[aria-pressed="true"]'].map(sel => {
          const el = document.querySelector(sel);
          return [sel, window.__ratio(window.__rgb(getComputedStyle(el).borderTopColor), window.__bg(el.parentElement))];
        }));
        for (const [sel, ratio] of borders) assert.ok(ratio >= 3, sel + ' border ' + ratio.toFixed(2) + ':1');
        await page.click('.view[data-view="ai"]');
        await page.click('#filters .filter[data-group="attention"]');
        await page.click(nodeSel(stalled.id));
        const disabled = await page.evaluate(() => {
          const el = document.getElementById('copy-command');
          return { disabled: el.disabled, opacity: getComputedStyle(el).opacity, ratio: window.__ratio(window.__rgb(getComputedStyle(el).color), window.__bg(el)) };
        });
        assert.ok(disabled.disabled);
        assert.equal(disabled.opacity, '1');
        assert.ok(disabled.ratio >= 4.5, 'disabled text ' + disabled.ratio.toFixed(2) + ':1');
      });
    });

    test('touch targets: 44 px on phones, 24 px minimum and 44 px primary actions on desktop', async () => {
      await live(async page => {
        const heights = selector => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).filter(el => el.getClientRects().length).map(el => [el.id || el.className || el.tagName, el.getBoundingClientRect().height]), selector);
        for (const [label, h] of await heights('.view, #copy-command, .action-copy, .action-preview summary')) assert.ok(h >= 44, 'desktop ' + label + ' ' + h);
        for (const [label, h] of await heights('button, summary, .search')) assert.ok(h >= 24, 'desktop ' + label + ' ' + h);
        await page.fill('#search', 'not-an-installed-app');
        for (const [label, h] of await heights('#clear-search')) assert.ok(h >= 44, label + ' ' + h);
        await page.fill('#search', '');
        await page.setViewportSize({ width: 390, height: 844 });
        for (const [label, h] of await heights('.view, .filter, #copy-command, .action-copy, .action-preview summary, .node')) assert.ok(h >= 44, 'phone ' + label + ' ' + h);
      });
    });

    test('forced colours keep the selected card and pressed controls visible', async () => {
      await live(async page => {
        await page.emulateMedia({ forcedColors: 'active' });
        const styles = await page.evaluate(() => ['.node[aria-current="true"]', '.view[aria-pressed="true"]', '#filters .filter[aria-pressed="true"]'].map(sel => [sel, getComputedStyle(document.querySelector(sel)).outlineStyle]));
        for (const [sel, style] of styles) assert.notEqual(style, 'none', sel);
      });
    });

    test('phones: the hint sits above the map and a Details button reaches the inspector', async () => {
      await live(async page => {
        assert.match(await page.textContent('.canvas-top'), /details (are )?below the map/i);
        assert.equal(await page.locator('.inspector .mobile-hint').count(), 0);
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await check(page, 'Details button appears', () => { const b = document.getElementById('to-details'); return !!b && b.getClientRects().length > 0 && !b.hidden; });
        await page.click('#to-details');
        await check(page, 'inspector scrolled into view', () => { const r = document.getElementById('inspector').getBoundingClientRect(); return r.top >= -1 && r.top <= 100; });
      }, { viewport: { width: 390, height: 844 } });
    });

    test('at 320 px the topbar and workspace buttons stay on one line', async () => {
      await live(async page => {
        const measure = () => page.evaluate(() => Array.from(document.querySelectorAll('.view'), v => v.getBoundingClientRect().height));
        const wide = await measure();
        await page.setViewportSize({ width: 320, height: 700 });
        assert.deepEqual(await measure(), wide);
        assert.deepEqual(await page.evaluate(topbarProblems), []);
      }, { viewport: { width: 390, height: 844 } });
    });

    test('on phones the toast uses the screen width instead of wrapping at half of it', async () => {
      await live(async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await check(page, 'toast wider than half the screen', () => document.getElementById('toast').getBoundingClientRect().width > innerWidth * 0.6);
        await check(page, 'toast inside the screen', () => { const r = document.getElementById('toast').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
      }, { viewport: { width: 390, height: 844 } });
    });

    test('the toast never covers the count line', async () => {
      await live(async page => {
        await page.click(nodeSel(modeler.id));
        await check(page, 'toast shown', () => document.getElementById('toast').classList.contains('show'));
        await check(page, 'settled toast clears the count line', () => document.querySelector('.canvas-bottom').getBoundingClientRect().top - document.getElementById('toast').getBoundingClientRect().bottom >= 4);
      });
    });

    test('the inspector sits beside the map on wide screens and below it at 1170 px', async () => {
      await live(async page => {
        const where = () => page.evaluate(() => { const m = document.querySelector('main').getBoundingClientRect(), i = document.getElementById('inspector').getBoundingClientRect(); return { beside: i.left >= m.right - 1, below: i.top >= m.bottom - 1 }; });
        assert.deepEqual(await where(), { beside: true, below: false });
        await page.setViewportSize({ width: 1170, height: 1000 });
        assert.deepEqual(await where(), { beside: false, below: true });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Themes, print and Content-Security-Policy (audit findings F19, F20, F34, wave D)
// ---------------------------------------------------------------------------
const backgroundLuminance = page => page.evaluate(() => window.__lum(window.__rgb(getComputedStyle(document.body).backgroundColor)));
function defineThemesPrintAndPolicy(getBrowser) {
  describe('themes, print and policy', describeOptions, () => {
    const live = (fn, options) => withPage(getBrowser, null, async page => { await page.evaluate(installContrast); await fn(page); }, options);

    test('a first visit is dark until a theme is chosen; Auto follows the system; every choice is remembered', async () => {
      await live(async page => {
        assert.ok(await backgroundLuminance(page) < 0.05, 'a first visit on a light system is dark');
        assert.equal(await page.inputValue('#theme'), 'dark');
        await page.selectOption('#theme', 'auto');
        await page.evaluate(installContrast);
        assert.ok(await backgroundLuminance(page) > 0.8, 'Auto follows the light system');
        await page.reload();
        await page.evaluate(installContrast);
        assert.equal(await page.inputValue('#theme'), 'auto');
        assert.ok(await backgroundLuminance(page) > 0.8, 'Auto survives a reload');
      }, { colorScheme: 'light' });
      await live(async page => {
        assert.ok(await backgroundLuminance(page) < 0.05, 'a first visit on a dark system is dark');
        await page.selectOption('#theme', 'light');
        await page.evaluate(installContrast);
        assert.ok(await backgroundLuminance(page) > 0.8, 'Light wins over a dark system');
        await page.reload();
        await page.evaluate(installContrast);
        assert.equal(await page.inputValue('#theme'), 'light');
        assert.ok(await backgroundLuminance(page) > 0.8, 'Light survives a reload');
      }, { colorScheme: 'dark' });
    });

    test('the page works when browser storage throws', async () => {
      const context = await getBrowser().newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
      try {
        await context.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } }); });
        await context.addInitScript(clipboardHarness, { mode: 'stub' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(PAGE_URL);
        await page.evaluate(installContrast);
        await page.selectOption('#theme', 'light');
        assert.ok(await backgroundLuminance(page) > 0.8, 'theme still switches for this visit');
        await page.click('.view[data-view="desktop"]');
        await page.click(nodeSel(modeler.id));
        await check(page, 'copy still works', () => window.__copied === '/usr/bin/modeler');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    for (const scheme of ['dark', 'light']) {
      test('every visible text reaches WCAG AA contrast in the ' + scheme + ' theme', async () => {
        await live(async page => {
          const failures = [];
          for (const [view, group, id] of [['desktop', 'all', 'modeler'], ['ai', 'all', 'orbit7'], ['ai', 'attention', stalled.id], ['services', 'all', ledger.id]]) {
            await page.click('.view[data-view="' + view + '"]');
            await page.click('#filters .filter[data-group="' + group + '"]');
            await page.click(nodeSel(id));
            await page.evaluate(() => { document.getElementById('toast').classList.remove('show'); document.getElementById('remove-preview').open = true; });
            failures.push(...(await page.evaluate(contrastFailures)).map(f => view + '/' + id + ': ' + f));
          }
          assert.deepEqual([...new Set(failures)], []);
        }, { colorScheme: scheme, theme: scheme });
      });
    }

    test('print shows the map and the inspector in light colours with nothing clipped', async () => {
      await live(async page => {
        await page.selectOption('#theme', 'dark');
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await page.emulateMedia({ media: 'print' });
        await page.evaluate(installContrast);
        assert.ok(await backgroundLuminance(page) > 0.8, 'print uses light colours even in the dark theme');
        const layout = await page.evaluate(() => ({
          sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
          canvasOverflow: getComputedStyle(document.getElementById('canvas')).overflowY,
          clipped: Array.from(document.querySelectorAll('.node')).filter(node => { const r = node.getBoundingClientRect(); return r.right > document.documentElement.clientWidth + 1 || r.width < 100; }).map(node => node.dataset.id),
          inspector: getComputedStyle(document.getElementById('inspector')).display,
          command: (() => { const t = document.getElementById('command'); return t.scrollHeight - t.clientHeight; })()
        }));
        assert.equal(layout.sidebar, 'none');
        assert.equal(layout.canvasOverflow, 'visible');
        assert.deepEqual(layout.clipped, []);
        assert.notEqual(layout.inspector, 'none');
        assert.ok(layout.command <= 2, 'the whole startup chain prints (' + layout.command + ' px hidden)');
        const failures = await page.evaluate(contrastFailures);
        assert.deepEqual(failures, []);
        const pdf = await page.pdf({ format: 'A4' });
        assert.ok(pdf.length > 10000, 'a PDF renders');
      }, { colorScheme: 'dark' });
    });

    test('a Content-Security-Policy blocks network access without breaking the page', async () => {
      assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*"/);
      const context = await getBrowser().newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        await context.addInitScript(() => { window.__violations = []; document.addEventListener('securitypolicyviolation', e => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI)); });
        await context.addInitScript(clipboardHarness, { mode: 'stub' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(PAGE_URL);
        await page.click('.view[data-view="desktop"]');
        await page.click(nodeSel(modeler.id));
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await page.click('#remove-preview summary');
        await page.selectOption('#theme', 'light');
        assert.deepEqual(await page.evaluate(() => window.__violations), [], 'the page itself triggers no violation');
        await page.evaluate(() => fetch('https://example.com/').catch(() => {}));
        await check(page, 'the blocked request is reported as a connect-src violation', () => window.__violations.some(v => v.startsWith('connect-src')));
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  });
}

// ---------------------------------------------------------------------------
// Features: remembered state, keyboard flow, recently copied (F02, F03, F21, wave E)
// ---------------------------------------------------------------------------
async function withContext(getBrowser, fn, { initScripts = [], viewport = { width: 1440, height: 1000 }, firstVisit = false } = {}) {
  const context = await getBrowser().newContext({ viewport, colorScheme: 'dark' });
  try {
    for (const [script, arg] of initScripts) await context.addInitScript(script, arg);
    await context.addInitScript(clipboardHarness, { mode: 'stub' });
    if (!firstVisit) await context.addInitScript(startOnDesktop);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(PAGE_URL);
    await fn(page);
    assert.deepEqual(errors, [], 'no uncaught exceptions');
  } finally { await context.close(); }
}
const focusedId = page => page.evaluate(() => document.activeElement?.dataset?.id || null);
const inspectorName = page => page.textContent('#detail-name');
function defineFeatures(getBrowser) {
  describe('features', describeOptions, () => {
    test('a reload restores the workspace, the selection and an explicitly chosen zoom', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await page.click('#zoom-in');
        await page.click('#zoom-in');
        const zoomed = await page.textContent('#zoom-value');
        await page.reload();
        await check(page, 'workspace restored', () => document.querySelector('.view[aria-pressed="true"]').dataset.view === 'services');
        assert.equal(await inspectorName(page), ledger.name);
        await check(page, 'zoom restored', value => document.getElementById('zoom-value').textContent === value, zoomed);
        await page.click('#zoom-fit');
        const fitted = await page.textContent('#zoom-value');
        await page.reload();
        await check(page, 'an automatic fit is not pinned', value => document.getElementById('zoom-value').textContent === value, fitted);
      });
    });

    test('a corrupt or stale store falls back to the defaults silently', async () => {
      for (const stored of ['{broken', JSON.stringify({ workspace: 'nowhere', order: 'ghost', selected: 'ghost', zoom: 9, recent: ['ghost', 7] })]) {
        await withContext(getBrowser, async page => {
          await check(page, 'default workspace', () => document.querySelector('.view[aria-pressed="true"]').dataset.view === 'services');
          assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('.view'), button => button.dataset.view)), Object.keys(views));
          assert.equal(await inspectorName(page), ledger.name);
          assert.notEqual(await page.textContent('#zoom-value'), '900%');
          assert.ok(await page.evaluate(() => document.getElementById('recent').hidden), 'no recent list from junk ids');
        }, { initScripts: [[value => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('launchpad', value); sessionStorage.setItem('seeded', '1'); } }, stored]] });
      }
    });

    test('keyboard: focus selects without copying, arrows move, Enter in search lands on the first result, digits switch workspace', async () => {
      await withContext(getBrowser, async page => {
        await page.focus(nodeSel(modeler.id));
        const copiesBefore = await page.evaluate(() => window.__copies.length);
        await page.keyboard.press('ArrowRight');
        const next = await focusedId(page);
        assert.equal(next, visibleIds('desktop', 'all')[1]);
        assert.equal(await inspectorName(page), byId(next).name, 'focus selects the card');
        assert.equal(await page.evaluate(() => window.__copies.length), copiesBefore, 'moving focus copies nothing');
        await page.focus(nodeSel(modeler.id));
        await page.keyboard.press('ArrowDown');
        const below = await page.evaluate(() => {
          const a = document.querySelector('.node[data-id="modeler"]').getBoundingClientRect(), b = document.activeElement.getBoundingClientRect();
          return { id: document.activeElement.dataset.id, sameColumn: Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2) < 4, lower: b.top >= a.bottom };
        });
        assert.ok(below.id && below.sameColumn && below.lower, JSON.stringify(below));
        await page.keyboard.press('End');
        assert.equal(await focusedId(page), visibleIds('desktop', 'all').at(-1));
        await page.keyboard.press('Home');
        assert.equal(await focusedId(page), visibleIds('desktop', 'all')[0]);
        await page.fill('#search', 'agentdesk');
        await page.press('#search', 'Enter');
        assert.equal(await focusedId(page), core.filterApps(catalog, 'desktop', 'all', 'agentdesk')[0].id);
        await page.press('#search', 'Escape').catch(() => {});
        await page.evaluate(() => document.activeElement.blur());
        await page.keyboard.press('2');
        await check(page, 'digit 2 opens the second workspace', view => document.querySelector('.view[aria-pressed="true"]').dataset.view === view, Object.keys(views)[1]);
        await page.focus('#search');
        await page.keyboard.press('3');
        assert.equal(await page.inputValue('#search'), '3', 'digits type normally in the search box');
        assert.equal(await page.evaluate(() => document.querySelector('.view[aria-pressed="true"]').dataset.view), Object.keys(views)[1]);
        assert.match(await page.textContent('.sidebar'), /arrow keys/i, 'the shortcuts are listed');
      });
    });

    test('recently copied lists the last copies, re-copies on click, and survives a reload', async () => {
      await withContext(getBrowser, async page => {
        assert.ok(await page.evaluate(() => document.getElementById('recent').hidden), 'hidden while empty');
        await page.click(nodeSel(modeler.id));
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await page.click('.view[data-view="ai"]');
        await page.click('#filters .filter[data-group="attention"]');
        await page.click(nodeSel(stalled.id));
        const names = () => page.evaluate(() => Array.from(document.querySelectorAll('#recent-list button'), b => b.dataset.id));
        assert.deepEqual(await names(), [ledger.id, modeler.id], 'newest first; blocked cells never recorded');
        await page.evaluate(() => { window.__copied = undefined; });
        await page.click('#recent-list button[data-id="' + modeler.id + '"]');
        await check(page, 'recent click switches workspace, selects and copies', ([id, name, command]) =>
          document.querySelector('.view[aria-pressed="true"]').dataset.view === 'desktop' && document.getElementById('detail-name').textContent === name && window.__copied === command,
          [modeler.id, modeler.name, modeler.command]);
        await page.mouse.move(700, 500);
        await check(page, 'the list reorders once the pointer leaves', ids => Array.from(document.querySelectorAll('#recent-list button'), b => b.dataset.id).join() === ids.join(), [modeler.id, ledger.id]);
        await page.reload();
        assert.deepEqual(await names(), [modeler.id, ledger.id], 'the list survives a reload');
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('recent')).display), 'none', 'phones keep the map at the top');
      });
    });

    test('recently copied still works for the visit when storage throws', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="desktop"]');
        await page.click(nodeSel(modeler.id));
        await check(page, 'listed in memory', id => !document.getElementById('recent').hidden && !!document.querySelector('#recent-list button[data-id="' + id + '"]'), modeler.id);
      }, { initScripts: [[() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } }); }]] });
    });
  });
}

// ---------------------------------------------------------------------------
// Code review fixes (reproduced defects in the browser state logic)
// ---------------------------------------------------------------------------
// Runs in the page: names top-bar text that wraps or sticks out of the viewport.
function defineWorkspaces(getBrowser) {
  const order = page => page.evaluate(() => Array.from(document.querySelectorAll('.view'), button => button.dataset.view));
  const active = page => page.evaluate(() => document.querySelector('.view[aria-pressed="true"]').dataset.view);
  const centre = async (page, key) => { const box = await page.locator('.view[data-view="' + key + '"]').boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  // Press on one workspace and travel past the centre of another, in small steps like a real pointer.
  async function dragOver(page, from, to, axis = 'y') {
    const start = await centre(page, from), end = await centre(page, to), push = Math.sign(end[axis] - start[axis]) * 8;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(axis === 'x' ? end.x + push : start.x, axis === 'y' ? end.y + push : start.y, { steps: 14 });
  }
  describe('workspaces', describeOptions, () => {
    test('a first visit opens Web services on top with a startup chain selected', async () => {
      await withContext(getBrowser, async page => {
        assert.deepEqual(await order(page), Object.keys(views));
        assert.equal(await active(page), 'services');
        assert.equal(await page.textContent('#view-title'), views.services.title);
        assert.equal(await page.textContent('#workspace-number'), '01 / 03');
        assert.equal(await inspectorName(page), ledger.name, 'the first card with a chain is selected');
        assert.equal(await page.textContent('#copy-label'), 'Copy startup chain');
        await page.reload();
        assert.equal(await active(page), 'services');
      }, { firstVisit: true });
    });

    test('a workspace saved by an older version does not hold the new default back', async () => {
      const stored = JSON.stringify({ view: 'desktop', selected: 'modeler', theme: 'light', recent: ['modeler'] });
      await withContext(getBrowser, async page => {
        assert.equal(await active(page), 'services');
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'other saved choices are kept');
        assert.equal(await page.locator('#recent-list button').count(), 1);
      }, { firstVisit: true, initScripts: [[value => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('launchpad', value); sessionStorage.setItem('seeded', '1'); } }, stored]] });
    });

    test('dragging reorders the list, leaves the open workspace alone and survives a reload', async () => {
      await withContext(getBrowser, async page => {
        const layoutBefore = await page.evaluate(() => JSON.stringify(document.getElementById('canvas').getBoundingClientRect()));
        await dragOver(page, 'ai', 'services');
        assert.deepEqual(await order(page), ['ai', 'services', 'desktop'], 'the list follows the pointer before the drop');
        assert.equal(await page.evaluate(() => JSON.stringify(document.getElementById('canvas').getBoundingClientRect())), layoutBefore, 'the map does not move');
        await page.mouse.up();
        assert.deepEqual(await order(page), ['ai', 'services', 'desktop']);
        assert.equal(await active(page), 'services', 'a drag is not a click');
        assert.equal(await page.textContent('#workspace-number'), '02 / 03', 'the number follows the new position');
        assert.equal(await page.evaluate(() => document.querySelector('.view[data-view="ai"]').style.transform), '', 'nothing is left floating');
        await page.evaluate(() => document.activeElement.blur());
        await page.keyboard.press('1');
        await check(page, 'digit 1 opens the workspace now on top', () => document.querySelector('.view[aria-pressed="true"]').dataset.view === 'ai');
        assert.equal(await page.textContent('#workspace-number'), '01 / 03');
        await page.reload();
        assert.deepEqual(await order(page), ['ai', 'services', 'desktop'], 'the order is remembered');
      }, { firstVisit: true });
    });

    test('a click on a workspace still opens it', async () => {
      await withContext(getBrowser, async page => {
        const point = await centre(page, 'desktop');
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 2, point.y + 1);
        await page.mouse.up();
        assert.equal(await active(page), 'desktop', 'a small wobble is still a click');
        assert.deepEqual(await order(page), Object.keys(views));
      }, { firstVisit: true });
    });

    test('Escape cancels a drag and restores the order', async () => {
      await withContext(getBrowser, async page => {
        await dragOver(page, 'ai', 'services');
        assert.deepEqual(await order(page), ['ai', 'services', 'desktop']);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        assert.deepEqual(await order(page), Object.keys(views));
        assert.equal(await active(page), 'services', 'the released pointer does not click');
        assert.equal(await page.evaluate(() => document.querySelector('.reordering')), null);
        await page.reload();
        assert.deepEqual(await order(page), Object.keys(views), 'a canceled drag saves nothing');
      }, { firstVisit: true });
    });

    test('letting go outside the list before a drag starts leaves nothing armed', async () => {
      await withContext(getBrowser, async page => {
        const point = await centre(page, 'ai');
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 500, point.y + 2, { steps: 4 });
        await page.mouse.up();
        await page.mouse.move(point.x, point.y - 40, { steps: 4 });
        await page.mouse.move(point.x, point.y - 80, { steps: 4 });
        assert.equal(await page.evaluate(() => document.querySelector('.reordering')), null, 'no button follows a pointer with nothing held');
        assert.deepEqual(await order(page), Object.keys(views));
      }, { firstVisit: true });
    });

    test('a drag belongs to its first pointer: a second finger or Alt and an arrow cannot take it over', async () => {
      await withContext(getBrowser, async page => {
        await dragOver(page, 'ai', 'desktop');
        assert.deepEqual(await order(page), ['services', 'ai', 'desktop']);
        await page.keyboard.press('Alt+ArrowDown');
        assert.deepEqual(await order(page), ['services', 'ai', 'desktop'], 'the keyboard waits for the drag to end');
        await page.evaluate(() => document.querySelector('.view[data-view="services"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 77, button: 0 })));
        await page.mouse.up();
        assert.equal(await page.evaluate(() => document.querySelector('.reordering')), null, 'the drag ended with its own pointer');
        assert.equal(await page.evaluate(() => document.querySelector('.view[data-view="ai"]').style.transform), '');
        assert.deepEqual(await order(page), ['services', 'ai', 'desktop']);
      }, { firstVisit: true });
    });

    test('Alt and an arrow key move the focused workspace, keep focus and say where it went', async () => {
      await withContext(getBrowser, async page => {
        await page.focus('.view[data-view="desktop"]');
        await page.keyboard.press('Alt+ArrowUp');
        assert.deepEqual(await order(page), ['desktop', 'services', 'ai']);
        assert.equal(await page.evaluate(() => document.activeElement.dataset.view), 'desktop', 'focus stays on the moved workspace');
        await check(page, 'the move is announced', title => document.getElementById('toast').textContent.includes(title) && /position 1 of 3/.test(document.getElementById('toast').textContent), views.desktop.title);
        await page.keyboard.press('Alt+ArrowUp');
        assert.deepEqual(await order(page), ['desktop', 'services', 'ai'], 'the top is the top');
        await page.keyboard.press('Alt+ArrowDown');
        assert.deepEqual(await order(page), ['services', 'desktop', 'ai']);
        assert.equal(await active(page), 'services', 'moving is not opening');
        await page.reload();
        assert.deepEqual(await order(page), ['services', 'desktop', 'ai']);
      }, { firstVisit: true });
    });

    test('at phone width the row reorders sideways and nothing overflows', async () => {
      await withContext(getBrowser, async page => {
        await dragOver(page, 'ai', 'desktop', 'x');
        await page.mouse.up();
        assert.deepEqual(await order(page), ['services', 'ai', 'desktop']);
        assert.equal(await active(page), 'services');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
      }, { firstVisit: true, viewport: { width: 390, height: 800 } });
    });

    test('the list says it can be reordered', async () => {
      await withContext(getBrowser, async page => {
        assert.match(await page.getAttribute('.view[data-view="ai"]', 'title'), /drag/i);
        assert.match(await page.textContent('.keys'), /Alt/);
      }, { firstVisit: true });
    });
  });
}

function topbarProblems() {
  const problems = [];
  for (const el of document.querySelectorAll('.topbar .brand-name, .topbar .brand-sub, .topbar .offline, .topbar .copy-only .long, .topbar .copy-only .short, .topbar .theme')) {
    if (!el.getClientRects().length) continue;
    const r = el.getBoundingClientRect(), size = parseFloat(getComputedStyle(el).fontSize);
    if (r.height > size * 2.2 && !el.classList.contains('theme')) problems.push(el.className + ' wraps (' + r.height + ' px)');
    if (r.right > innerWidth + 0.5) problems.push(el.className + ' overflows');
  }
  return problems;
}
function defineReviewFixes(getBrowser) {
  describe('review fixes', describeOptions, () => {
    test('Tab leaves the map after one stop and keeps the selection for the inspector and footer', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await page.focus(nodeSel(ledger.id));
        await page.keyboard.press('Tab');
        assert.equal(await focusedId(page), null, 'Tab moves off the map, not to the next card');
        for (let i = 0; i < 12 && await page.evaluate(() => document.activeElement.id) !== 'copy-relaunch'; i++) await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'copy-relaunch', 'the footer is reachable');
        assert.equal(await inspectorName(page), ledger.name, 'the selection never moved');
        assert.equal(await page.evaluate(() => document.querySelectorAll('.node[tabindex="0"]').length), 1, 'one tab stop in the map');
      });
    });

    test('a remembered selection outside the default group survives a reload', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="ai"]');
        await page.click('#filters .filter[data-group="models"]');
        await page.click(nodeSel('reason'));
        await page.reload();
        assert.equal(await inspectorName(page), byId('reason').name);
        await check(page, 'its card is visible', () => !!document.querySelector('.node[data-id="reason"]'));
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('launchpad')).selected), 'reason');
      });
    });

    test('clearing the search keeps a card picked from the results', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="ai"]');
        await page.fill('#search', 'orbit');
        await page.click(nodeSel('orbit7'));
        await page.press('#search', 'Escape');
        assert.equal(await inspectorName(page), byId('orbit7').name);
        await check(page, 'the picked card stays visible', () => !!document.querySelector('.node[data-id="orbit7"]'));
      });
    });

    test('the sidebar never makes a laptop-height page scroll', async () => {
      await withContext(getBrowser, async page => {
        const height = () => page.evaluate(() => document.documentElement.scrollHeight);
        const before = await height();
        for (const [view, id] of [['desktop', 'modeler'], ['desktop', 'gamehub'], ['desktop', 'codestudio'], ['services', 'shelf'], ['services', 'parser']]) {
          await page.click('.view[data-view="' + view + '"]');
          await page.click(nodeSel(id));
        }
        assert.equal(await page.evaluate(() => document.querySelectorAll('#recent-list button').length), 5);
        assert.ok(await height() <= before + 2, 'page height ' + await height() + ' vs ' + before);
      }, { viewport: { width: 1366, height: 657 } });
    });

    test('recently copied names are never cut', async () => {
      for (const width of [1024, 1440]) {
        await withContext(getBrowser, async page => {
          await page.click('.view[data-view="ai"]');
          await page.click('#filters .filter[data-group="models"]');
          await page.click(nodeSel('cedar'));
          await page.click('.view[data-view="services"]');
          await page.click(nodeSel('reader'));
          const cut = await page.evaluate(() => Array.from(document.querySelectorAll('#recent-list .name')).filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent));
          assert.deepEqual(cut, [], width + 'px');
        }, { viewport: { width, height: 1000 } });
      }
    });

    test('a stale recent id cannot blank the map when the catalog has a workspace error', async () => {
      const broken = html.replace(/(\{"id":"browser","name":"Web Browser","view":)"desktop"/, '$1"web"');
      assert.notEqual(broken, html);
      await withPage(getBrowser, broken, async page => {
        await page.evaluate(() => { localStorage.setItem('launchpad', JSON.stringify({ recent: ['browser'] })); });
        await page.reload();
        await check(page, 'the map still renders', () => document.querySelectorAll('.node').length > 0);
        await check(page, 'the banner names the problem', () => !document.getElementById('catalog-problems').hidden);
      });
    });

    test('keyboard focus survives rebuilds of the recent list, the empty state and a digit switch', async () => {
      await withContext(getBrowser, async page => {
        await page.click(nodeSel(modeler.id));
        await page.focus('#recent-list button[data-id="' + modeler.id + '"]');
        await page.keyboard.press('Enter');
        await check(page, 'focus stays on the recent entry', id => document.activeElement?.dataset?.id === id && !!document.activeElement.closest('#recent-list'), modeler.id);
        await page.fill('#search', 'orbit');
        await page.focus('#empty-elsewhere button');
        await page.keyboard.press('Enter');
        await check(page, 'focus lands on the first result', () => !!document.activeElement.closest('.node'));
        await page.keyboard.press('3');
        await check(page, 'focus lands on the active workspace', () => document.activeElement.matches('.view[aria-pressed="true"]'));
      });
    });

    test('at 1920 px no arrow runs along a lane heading or over its label', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="services"]');
        await page.waitForTimeout(150);
        const hits = await page.evaluate(() => {
          const board = document.getElementById('board').getBoundingClientRect(), scale = board.width / document.getElementById('board').offsetWidth;
          const box = el => { const r = el.getBoundingClientRect(); return { top: (r.top - board.top) / scale, bottom: (r.bottom - board.top) / scale, left: (r.left - board.left) / scale, right: (r.right - board.left) / scale }; };
          const inside = (p, h) => p.x > h.left && p.x < h.right && p.y > h.top + 0.5 && p.y < h.bottom - 0.5;
          const headings = Array.from(document.querySelectorAll('.lane-heading'), box), labels = Array.from(document.querySelectorAll('.lane-heading span'), box);
          const hit = [];
          for (const path of document.querySelectorAll('.edges path')) {
            const total = path.getTotalLength();
            for (let s = 0; s + 3 <= total; s += 3) {
              const p = path.getPointAtLength(s), q = path.getPointAtLength(s + 3), level = Math.abs(q.y - p.y) < 0.2;
              if (labels.some(h => inside(p, h)) || (level && headings.some(h => inside(p, h)))) { hit.push(path.dataset.from + '→' + path.dataset.to); break; }
            }
          }
          return hit;
        });
        assert.deepEqual(hits, []);
      }, { viewport: { width: 1920, height: 1080 } });
    });

    test('arrows keep a margin over 3:1 (at least 3.5:1, they are thin lines) in both themes', async () => {
      for (const colorScheme of ['dark', 'light']) {
        await withPage(getBrowser, null, async page => {
          await page.evaluate(installContrast);
          await page.click('.view[data-view="ai"]');
          await page.click('#filters .filter[data-group="all"]');
          await check(page, 'arrows drawn', () => document.querySelectorAll('.edges path').length >= 2);
          const ratios = await page.evaluate(() => Array.from(document.querySelectorAll('.edges path'), path => {
            const style = getComputedStyle(path), stroke = window.__rgb(style.stroke), bg = window.__bg(document.getElementById('canvas')), a = parseFloat(style.opacity);
            return [path.getAttribute('class') || 'required', window.__ratio(stroke.map((c, i) => i < 3 ? c * a + bg[i] * (1 - a) : 1), bg)];
          }));
          assert.ok(ratios.length >= 2);
          for (const [kind, ratio] of ratios) assert.ok(ratio >= 3.5, colorScheme + ' ' + kind + ' arrow ' + ratio.toFixed(2) + ':1');
        }, { colorScheme, theme: colorScheme });
      }
    });

    test('the top bar never wraps between 701 and 1170 px', async () => {
      await withContext(getBrowser, async page => {
        for (const width of [701, 720, 740, 760, 800, 900, 1024, 1170]) {
          await page.setViewportSize({ width, height: 900 });
          assert.deepEqual(await page.evaluate(topbarProblems), [], width + 'px');
        }
      });
    });

    test('junk in storage is dropped, not kept', async () => {
      for (const stored of ['"hello"', JSON.stringify({ recent: ['modeler', 'modeler'] })]) {
        await withContext(getBrowser, async page => {
          assert.ok(await page.evaluate(() => document.querySelectorAll('#recent-list button').length) <= 1, 'duplicates shown once');
          await page.click('.view[data-view="desktop"]');
          await page.click(nodeSel(gamehub.id));
          const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('launchpad')));
          assert.ok(saved && !Array.isArray(saved) && !('0' in saved), JSON.stringify(saved));
          assert.equal(new Set(saved.recent).size, saved.recent.length, 'recent has no duplicates');
        }, { initScripts: [[value => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('launchpad', value); sessionStorage.setItem('seeded', '1'); } }, stored]] });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// QA fixes (first-time-user walkthrough)
// ---------------------------------------------------------------------------
function defineQaFixes(getBrowser) {
  describe('qa fixes', describeOptions, () => {
    test('the inspector starts at the top whenever the app changes', async () => {
      await withContext(getBrowser, async page => {
        await page.click(nodeSel(modeler.id));
        await page.evaluate(() => { const i = document.getElementById('inspector'); i.scrollTop = i.scrollHeight; });
        assert.ok(await page.evaluate(() => document.getElementById('inspector').scrollTop) > 0, 'the inspector scrolls at this size');
        await page.click(nodeSel('codestudio'));
        assert.equal(await page.evaluate(() => document.getElementById('inspector').scrollTop), 0);
      });
    });

    test('the toast pauses on hover, dismisses on click, and never blocks clicks while hidden', async () => {
      await withContext(getBrowser, async page => {
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('toast')).pointerEvents), 'none', 'a hidden toast lets clicks through');
        await page.click(nodeSel(modeler.id));
        await check(page, 'toast shown', () => document.getElementById('toast').classList.contains('show'));
        await page.hover('#toast');
        await page.waitForTimeout(4300);
        assert.ok(await page.evaluate(() => document.getElementById('toast').classList.contains('show')), 'hover keeps it open');
        await page.click('#toast');
        await check(page, 'click dismisses it', () => !document.getElementById('toast').classList.contains('show'));
      });
    });

    test('print fits the map and the selected chain on few pages with every command in full', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await page.emulateMedia({ media: 'print' });
        const layout = await page.evaluate(() => ({
          cut: Array.from(document.querySelectorAll('.node-cmd')).filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.closest('.node').dataset.id),
          icons: getComputedStyle(document.querySelector('.node-copy')).display,
          textarea: getComputedStyle(document.getElementById('command')).display,
          printed: document.getElementById('command-print').textContent === document.getElementById('command').value,
          printedShown: getComputedStyle(document.getElementById('command-print')).display
        }));
        assert.deepEqual(layout.cut, [], 'no command is cut on paper');
        assert.equal(layout.icons, 'none', 'copy icons are not printed');
        assert.equal(layout.textarea, 'none');
        assert.ok(layout.printed && layout.printedShown !== 'none', 'the whole chain prints as text that can break across pages');
        const pdf = (await page.pdf({ format: 'A4' })).toString('latin1');
        const pages = (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
        assert.ok(pages >= 1 && pages <= 2, pages + ' pages');
      }, { viewport: { width: 1440, height: 1000 } });
    });

    test('typing in search never changes the selected app by itself', async () => {
      await withContext(getBrowser, async page => {
        await page.click(nodeSel(modeler.id));
        for (const query of ['8', '80', '8091']) {
          await page.fill('#search', query);
          assert.equal(await inspectorName(page), modeler.name, 'after typing ' + query);
        }
      });
    });

    test('tablet and phone: Show details appears when the inspector is out of view, takes focus there and goes away', async () => {
      for (const viewport of [{ width: 1024, height: 900 }, { width: 390, height: 844 }]) {
        await withContext(getBrowser, async page => {
          await page.click('.view[data-view="services"]');
          await page.click(nodeSel(ledger.id));
          await check(page, viewport.width + 'px: Show details appears', () => !document.getElementById('to-details').hidden);
          await page.click('#to-details');
          await check(page, 'focus moves into the inspector', () => !!document.activeElement.closest('#inspector'));
          await check(page, 'the toast is dismissed with it', () => !document.getElementById('toast').classList.contains('show'));
        }, { viewport });
      }
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        await check(page, 'shown', () => !document.getElementById('to-details').hidden);
        await check(page, 'it goes away on its own', () => document.getElementById('to-details').hidden, undefined, 9000);
      }, { viewport: { width: 390, height: 844 } });
    });

    test('at 1024 px the inspector has no large empty band under the app name', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        const gap = await page.evaluate(() => {
          const head = document.querySelector('.detail-head').getBoundingClientRect(), notes = document.querySelector('.detail-notes').getBoundingClientRect();
          return notes.top - head.bottom;
        });
        assert.ok(gap < 48, 'gap ' + gap + ' px');
      }, { viewport: { width: 1024, height: 900 } });
    });

    test('a disabled footer action looks disabled', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="ai"]');
        await page.click('#filters .filter[data-group="models"]');
        await page.click(nodeSel('vision'));
        const look = await page.evaluate(() => ['copy-relaunch', 'copy-remove'].map(id => { const s = getComputedStyle(document.getElementById(id)); return { id, disabled: document.getElementById(id).disabled, border: s.borderTopStyle, background: s.backgroundColor }; }));
        const [enabled, disabled] = look;
        assert.ok(!enabled.disabled && disabled.disabled, JSON.stringify(look));
        assert.equal(disabled.border, 'dashed');
        assert.notEqual(disabled.background, enabled.background);
      });
    });

    test('re-launch and removal previews start with plain steps', async () => {
      await withContext(getBrowser, async page => {
        await page.click(nodeSel(modeler.id));
        const steps = await page.evaluate(() => ['relaunch', 'remove'].map(kind => Array.from(document.querySelectorAll('#' + kind + '-steps li'), li => li.textContent)));
        assert.ok(steps[0].some(s => s.includes(modeler.command)), 'the re-launch steps name the command');
        assert.ok(steps[1].some(s => s.includes('REMOVE ' + modeler.id)), 'the removal steps name the confirmation');
        assert.ok(steps[1].some(s => s.includes('sudo pacman -R -- modeler')), 'the removal steps name the command');
        assert.ok(steps.flat().every(s => !s.includes(`'"'"'`)), 'no shell quoting noise');
      });
    });

    test('labels in the command box header are at least 11 px', async () => {
      await withContext(getBrowser, async page => {
        const sizes = await page.evaluate(() => Array.from(document.querySelectorAll('.command-label span'), el => parseFloat(getComputedStyle(el).fontSize)));
        assert.ok(sizes.length && sizes.every(size => size >= 11), JSON.stringify(sizes));
      });
    });

    test('Recently copied keeps its order under the pointer and the keyboard, then reorders', async () => {
      await withContext(getBrowser, async page => {
        await page.click(nodeSel(modeler.id));
        await page.click(nodeSel(gamehub.id));
        const order = () => page.evaluate(() => Array.from(document.querySelectorAll('#recent-list button'), b => b.dataset.id));
        assert.deepEqual(await order(), [gamehub.id, modeler.id]);
        await page.click('#recent-list button[data-id="' + modeler.id + '"]');
        await check(page, 'copied', id => window.__copied === id, modeler.command);
        assert.deepEqual(await order(), [gamehub.id, modeler.id], 'no reorder under the pointer');
        await page.mouse.move(700, 500);
        await check(page, 'reorders after the pointer leaves', ids => Array.from(document.querySelectorAll('#recent-list button'), b => b.dataset.id).join() === ids.join(), [modeler.id, gamehub.id]);
        await page.focus('#recent-list button[data-id="' + gamehub.id + '"]');
        await page.keyboard.press('Enter');
        await check(page, 'copied by keyboard', cmd => window.__copied === cmd, gamehub.command);
        assert.deepEqual(await order(), [modeler.id, gamehub.id], 'no reorder while focus is in the list');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.id), gamehub.id, 'focus stays on the entry');
        await page.focus('#search');
        await check(page, 'reorders after focus leaves', ids => Array.from(document.querySelectorAll('#recent-list button'), b => b.dataset.id).join() === ids.join(), [gamehub.id, modeler.id]);
      });
    });

    test('Save as .sh downloads exactly the reviewed script and runs nothing', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="services"]');
        await page.click(nodeSel(ledger.id));
        const [chain] = await Promise.all([page.waitForEvent('download'), page.click('#save-command')]);
        assert.equal(chain.suggestedFilename(), 'startclip-ledger-startup.sh');
        const chainText = fs.readFileSync(await chain.path(), 'utf8');
        assert.ok(chainText.startsWith('#!/usr/bin/env bash\n# Startclip startup chain for ' + ledger.name + ' (ledger)'), chainText.slice(0, 120));
        assert.ok(chainText.includes(core.startupPlan(catalog, core.connections, ledger.id).script), 'the saved file holds the chain shown in the inspector');
        await check(page, 'toast confirms nothing ran', () => document.getElementById('toast').textContent.includes('Nothing executed'));
        await page.click('.view[data-view="desktop"]');
        await page.click(nodeSel(modeler.id));
        const [removal] = await Promise.all([page.waitForEvent('download'), page.click('#save-remove')]);
        assert.equal(removal.suggestedFilename(), 'startclip-modeler-remove.sh');
        const removalText = fs.readFileSync(await removal.path(), 'utf8');
        assert.ok(removalText.includes('sudo pacman -R -- modeler') && removalText.includes('/dev/tty'));
        assert.equal(await page.evaluate(() => window.__copies.length), 2, 'saving copies nothing');
        await page.click('.view[data-view="ai"]');
        await page.click('#filters .filter[data-group="attention"]');
        await page.click(nodeSel(stalled.id));
        assert.ok(await page.evaluate(() => document.getElementById('save-command').disabled && document.getElementById('save-relaunch').disabled));
      });
    });

    test('a Recently copied click brings its card into view', async () => {
      await withContext(getBrowser, async page => {
        await page.click('.view[data-view="services"]');
        await page.locator(nodeSel('shelf')).scrollIntoViewIfNeeded();
        await page.click(nodeSel('shelf'));
        await page.click('.view[data-view="desktop"]');
        await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); document.getElementById('canvas').scrollTo(0, 0); });
        await page.click('#recent-list button[data-id="shelf"]');
        await check(page, 'the card is in view', () => {
          const r = document.querySelector('.node[data-id="shelf"]').getBoundingClientRect(), c = document.getElementById('canvas').getBoundingClientRect();
          return r.top >= c.top - 1 && r.bottom <= c.bottom + 1 && r.top >= 0 && r.bottom <= innerHeight;
        });
      }, { viewport: { width: 1440, height: 760 } });
    });
  });
}

function defineAxeScan(getBrowser) {
  describe('accessibility (axe-core)', describeOptions, () => {
    for (const [width, height, colorScheme] of [[1440, 1000, 'dark'], [1024, 900, 'dark'], [768, 1024, 'dark'], [390, 844, 'dark'], [320, 700, 'dark'], [1440, 1000, 'light'], [768, 1024, 'light'], [390, 844, 'light']]) {
      test('axe-core finds no serious or critical violations at ' + width + 'px (' + colorScheme + ')', { timeout: 30000 }, async t => {
        if (!AXE_PATH) return t.skip('axe-core is not resolvable from ' + TOOLS_DIR);
        const context = await getBrowser().newContext({ viewport: { width, height }, colorScheme });
        await context.addInitScript(theme => { try { localStorage.setItem('launchpad', JSON.stringify({ theme })); } catch {} }, colorScheme);
        try {
          const page = await context.newPage();
          await page.goto(PAGE_URL);
          await page.addScriptTag({ path: AXE_PATH });
          const results = await page.evaluate(() => axe.run(document, { resultTypes: ['violations', 'incomplete'] }));
          const describeViolation = v => v.id + ' [' + v.impact + '] ' + v.help + ' -> ' + v.nodes.slice(0, 5).map(n => n.target.join(' ')).join(' | ') + (v.nodes.length > 5 ? ' (+' + (v.nodes.length - 5) + ' more)' : '');
          const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
          const rest = results.violations.filter(v => !blocking.includes(v));
          t.diagnostic('axe-core ' + results.testEngine.version + ' at ' + width + 'px: ' + results.violations.length + ' violation rule(s), ' + results.passes.length + ' pass(es), ' + results.incomplete.length + ' incomplete');
          for (const v of rest) t.diagnostic('non-blocking: ' + describeViolation(v));
          for (const v of results.incomplete) t.diagnostic('needs review: ' + describeViolation(v));
          assert.deepEqual(blocking.map(describeViolation), [], 'serious/critical axe-core violations at ' + width + 'px');
        } finally {
          await context.close();
        }
      });
    }
  });
}
