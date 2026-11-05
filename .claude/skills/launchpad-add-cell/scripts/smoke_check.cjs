'use strict';
// Headless render check for one Startclip cell, loaded over file:// with the clipboard stubbed.
//   node smoke_check.cjs --page /path/index.html --id ID                  the cell renders and copies exactly its command
//   node smoke_check.cjs --page /path/index.html --id ID --absent --view V   the cell is gone and the counts still match
// Playwright is resolved from LAUNCHPAD_TEST_TOOLS (a node_modules folder), then ~/.cache/launchpad-test-tools/node_modules, then <page dir>/node_modules, then NODE_PATH.
// Exit: 0 pass, 1 fail, 2 usage, 3 render not verified (Playwright or Chromium missing). Nothing is executed:
// the stub records what the page would copy.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const arg = name => { const i = process.argv.indexOf(name); return i > 1 ? process.argv[i + 1] : undefined; };
const pageArg = arg('--page'), id = arg('--id'), absent = process.argv.includes('--absent');
if (!pageArg || !id || (absent && !arg('--view'))) {
  console.error('usage: node smoke_check.cjs --page PATH --id ID [--absent --view VIEW]');
  process.exit(2);
}
const pagePath = path.resolve(pageArg);
const cacheTools = path.join(require('node:os').homedir(), '.cache', 'launchpad-test-tools', 'node_modules');
const toolsDir = path.resolve(process.env.LAUNCHPAD_TEST_TOOLS || (require('node:fs').existsSync(cacheTools) ? cacheTools : path.join(path.dirname(pagePath), 'node_modules')));
function resolveTool(request) {
  for (const candidate of [path.join(toolsDir, request), request]) {
    try { return require.resolve(candidate); } catch {}
  }
  return null;
}
const entry = resolveTool('playwright');
if (!entry) {
  console.log('render not verified: Playwright is not resolvable from ' + toolsDir + ' (or NODE_PATH)');
  process.exit(3);
}

const html = fs.readFileSync(pagePath, 'utf8');
const block = name => JSON.parse(html.match(new RegExp('<script id="' + name + '" type="application/json">([\\s\\S]*?)</script>'))[1]);
const catalog = block('catalog'), views = block('views');
const context = { module: { exports: {} } };
vm.runInNewContext(html.match(/<script id="core">([\s\S]*?)<\/script>/)[1], context);
const core = context.module.exports;
const app = catalog.find(item => item.id === id);
if (absent === !!app) {
  console.log('FAIL catalog: ' + id + (absent ? ' is still in the catalog' : ' is not in the catalog'));
  process.exit(1);
}
const view = absent ? arg('--view') : app.view;
const expected = !absent && app.status !== 'blocked' ? core.startupPlan(catalog, core.connections, id).command : null;

let failed = false;
const report = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail !== undefined && !ok ? ' — ' + detail : ''));
  if (!ok) failed = true;
};
const guard = setTimeout(() => { console.log('FAIL smoke check timed out after 90 s'); process.exit(1); }, 90000);

(async () => {
  const playwright = require(entry);
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (error) {
    console.log('render not verified: Chromium did not start (' + String(error.message).split('\n')[0] + ')');
    process.exit(3);
  }
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__copied = [];
      const record = async text => { window.__copied.push(String(text)); };
      if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
      Object.defineProperty(navigator.clipboard, 'writeText', { value: record, writable: true, configurable: true });
    });
    await page.goto(pathToFileURL(pagePath).href);
    await page.waitForSelector(catalog.length ? '[data-id]' : '#first-run:not([hidden])', { timeout: 15000 });
    const banner = await page.$('#catalog-problems');
    if (banner) report(await banner.isHidden(), 'no catalog problem banner', await banner.textContent());
    if (!catalog.length) {
      report(await page.locator('.node').count() === 0, 'the last cell left and the first-run screen is back');
      report(errors.length === 0, 'no page errors', errors.join(' | '));
      await browser.close();
      process.exit(failed ? 1 : 0);
    }
    const showAll = async key => {
      await page.click('[data-view="' + key + '"]');
      const all = await page.$('[data-group="all"]');
      if (all) await all.click();
    };
    for (const key of Object.keys(views)) {
      await showAll(key);
      const want = catalog.filter(item => item.view === key).length;
      const got = await page.locator('[data-id]').count();
      report(got === want, key + ' renders all ' + want + ' cells', 'rendered ' + got);
    }
    await showAll(view);
    const node = page.locator('[data-id="' + id + '"]');
    if (absent) {
      report(await node.count() === 0, id + ' is no longer drawn in ' + view);
    } else {
      report(await node.count() === 1 && await node.isVisible(), id + ' is drawn once in ' + view);
      const text = await node.innerText();
      report(text.includes(app.name), 'the node shows its name', text.slice(0, 120));
      await node.click();
      if (expected === null) {
        await page.waitForTimeout(500);
        report((await page.evaluate(() => window.__copied.length)) === 0, 'a blocked cell copies nothing');
      } else {
        await page.waitForFunction(() => window.__copied.length > 0, null, { timeout: 5000 }).catch(() => {});
        const copied = await page.evaluate(() => window.__copied[window.__copied.length - 1]);
        report(copied === expected, 'clicking the node copies exactly ' + (expected === app.command ? 'its command' : 'its startup chain'),
          'copied ' + JSON.stringify(copied && copied.slice(0, 160)));
      }
    }
    report(errors.length === 0, 'no page errors', errors.join(' | '));
  } finally {
    await browser.close();
    clearTimeout(guard);
  }
  process.exit(failed ? 1 : 0);
})().catch(error => { console.log('FAIL ' + String(error.message || error).split('\n')[0]); process.exit(1); });
