'use strict';
// The Get started card (the playbook's get-started-template.md): three steps that tick from what the page can see,
// in place of the empty screen on a new install, then a strip above the map until done or dismissed. Decided once
// per browser on the first load that reads the map. Every check opens a page variant from tests/support/pages.cjs.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS_DIR, resolveTool, installContrast, contrastFailures, clipboardHarness } = require('./support/browser.cjs');
const { demo, fillPage, emptyPage, shippedPage, demoPage, writePage, removePage, coreOf } = require('./support/pages.cjs');

const PROMPTS = { add: 'add Obsidian to Startclip', search: 'search ~/Applications for apps to add', link: 'make Open WebUI wait for Ollama in Startclip' };
const engineOnly = () => fillPage(shippedPage(), { catalog: demo.catalog.filter(cell => cell.id === 'engine'), views: demo.views, tables: {} });
const fewApps = () => fillPage(shippedPage(), { catalog: demo.catalog.filter(cell => ['engine', 'shelf', 'router'].includes(cell.id)), views: demo.views, tables: {} });

describe('Get started: when it opens (core)', () => {
  const core = coreOf(emptyPage());
  test('a new browser on an empty map opens it; anything already used or already filled closes it', () => {
    assert.equal(core.getStartedState({}, 0, true), 'open');
    assert.equal(core.getStartedState({}, 3, true), 'closed', 'a map that already had apps');
    assert.equal(core.getStartedState({ recent: ['x'] }, 0, true), 'closed', 'a browser that copied from an earlier map');
    assert.equal(core.getStartedState({ selected: 'x' }, 0, true), 'closed', 'a browser that selected a card before');
    assert.equal(core.getStartedState({}, 0, false), null, 'a map that cannot be read decides nothing');
    assert.equal(core.getStartedState({ getStarted: 'open' }, 9, true), 'open', 'a decision is kept');
    assert.equal(core.getStartedState({ getStarted: 'closed' }, 0, true), 'closed');
    assert.equal(core.getStartedState({ getStarted: 'odd' }, 0, true), 'open', 'junk is ignored, the decision is taken again');
  });
  test('the steps tick from the map and the copy record only', () => {
    const cells = [{ id: 'db', name: 'Database' }, { id: 'web', name: 'Web app' }];
    const none = core.getStartedSteps([], [], []);
    assert.deepEqual(Array.from(none, step => [step.key, step.done]), [['add', false], ['copy', false], ['link', false]]);
    const some = core.getStartedSteps(cells, [{ from: 'db', to: 'web', optional: true }], ['ghost']);
    assert.deepEqual(Array.from(some, step => step.done), [true, false, false], 'a dashed link does not make anything wait; a copy of an app no longer on the map does not count');
    const all = core.getStartedSteps(cells, [{ from: 'db', to: 'web' }], ['web']);
    assert.deepEqual(Array.from(all, step => step.done), [true, true, true]);
    assert.equal(all[0].count, 2);
    assert.deepEqual([all[2].from, all[2].to], ['Database', 'Web app']);
  });
});

let chromium = null, browser = null;
try { ({ chromium } = require(resolveTool('playwright'))); } catch {}
if (!chromium) {
  test('Get started browser checks', { skip: 'Playwright is not resolvable from ' + TOOLS_DIR }, () => {});
} else describe('Get started in the browser', { timeout: 240000 }, () => {
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });

  // One browser context per check; `storage` seeds the page's store before it loads, `reloadWith` loads another page
  // variant in the same context (same file URL, so the same store), which is how a reload after an edit behaves.
  async function open(html, check, { viewport = { width: 1440, height: 1000 }, colorScheme = 'dark', storage } = {}) {
    const written = writePage(html), context = await browser.newContext({ viewport, colorScheme });
    try {
      await context.addInitScript(clipboardHarness, { mode: 'stub' });
      if (storage) await context.addInitScript(value => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('launchpad', JSON.stringify(value)); sessionStorage.setItem('seeded', '1'); } }, storage);
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(written.url);
      const reloadWith = async next => { require('node:fs').writeFileSync(written.file, next); await page.reload(); };
      await check(page, reloadWith);
      assert.deepEqual(errors, [], 'no uncaught script errors');
    } finally {
      await context.close();
      removePage(written);
    }
  }
  const card = page => page.evaluate(() => { const el = document.getElementById('get-started'); return el && el.getClientRects().length > 0 ? el.className : null; });
  const count = page => page.textContent('#get-started-count');
  const done = page => page.evaluate(() => Array.from(document.querySelectorAll('#get-started .get-started__step'), li => li.classList.contains('is-done')));
  const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('launchpad') || '{}').getStarted ?? null);
  const shows = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); return !!el && el.getClientRects().length > 0; }, selector);

  test('a new install opens on Get started at 0 of 3, in place of the empty screen', async () => {
    await open(emptyPage(), async page => {
      assert.match(String(await card(page)), /get-started--first/);
      assert.equal(await count(page), '0 of 3');
      assert.deepEqual(await done(page), [false, false, false]);
      assert.equal(await shows(page, '#first-run-title'), false, 'the empty screen waits behind the card');
      assert.ok(await page.evaluate(() => document.getElementById('get-started-title').getBoundingClientRect().top - document.getElementById('get-started').getBoundingClientRect().top) < 30, 'the heading sits at the top of the card, not under the empty screen\'s heading margin');
      assert.equal(await saved(page), 'open', 'decided once, on this first load');
      assert.equal(await page.getByRole('region', { name: 'Get started' }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Dismiss Get started' }).count(), 1);
    });
  });

  test('Dismiss closes it for good, after a reload too, and the empty screen is back', async () => {
    await open(emptyPage(), async page => {
      await page.getByRole('button', { name: 'Dismiss Get started' }).click();
      assert.equal(await card(page), null);
      assert.equal(await shows(page, '#first-run-title'), true);
      assert.equal(await saved(page), 'closed');
      await page.reload();
      assert.equal(await card(page), null);
      assert.equal(await shows(page, '#first-run-title'), true);
    });
  });

  test('each action copies what it says, runs nothing and says so', async () => {
    await open(emptyPage(), async page => {
      for (const [key, text] of Object.entries(PROMPTS)) {
        await page.click('#get-started [data-copy="' + key + '"]');
        assert.equal(await page.evaluate(() => window.__copied), text, key);
        assert.match(await page.textContent('#toast'), /Nothing executed/);
      }
      await page.click('#get-started [data-copy="line"]');
      const line = await page.evaluate(() => window.__copied);
      assert.equal(line, await page.evaluate(() => Array.from(document.querySelectorAll('#first-run code'), code => code.textContent).find(text => text.startsWith('{"id"'))), 'the same line the empty screen offers');
      const cell = JSON.parse(line);
      assert.deepEqual(Array.from(coreOf(emptyPage()).validateCatalog([cell], demo.views)), [], 'the sample line is a cell the page accepts');
      assert.equal(await page.evaluate(() => document.querySelectorAll('#get-started a, #get-started form').length), 0, 'no links or forms in the card');
    });
  });

  test('a denied clipboard leaves the text selected in the card', async () => {
    await open(emptyPage(), async page => {
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; document.execCommand = () => false; });
      await page.click('#get-started [data-copy="add"]');
      assert.equal(await shows(page, '#get-started-manual'), true);
      assert.equal(await page.evaluate(() => { const field = document.getElementById('get-started-text'); return field.value.slice(field.selectionStart, field.selectionEnd); }), PROMPTS.add);
    });
  });

  test('the first app ticks step 1 and the card becomes a strip above the map', async () => {
    await open(emptyPage(), async (page, reloadWith) => {
      assert.equal(await count(page), '0 of 3');
      await reloadWith(engineOnly());
      assert.match(String(await card(page)), /get-started--strip/);
      assert.equal(await count(page), '1 of 3');
      assert.deepEqual(await done(page), [true, false, false]);
      assert.match(await page.textContent('#get-started'), /1 app on your map/);
      assert.equal(await page.evaluate(() => document.querySelector('main').firstElementChild.id), 'get-started', 'above the map, inside main');
    });
  });

  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
    test('copying a card ticks step 2 at once, and nothing moves under the pointer at ' + width + ' px', async () => {
      await open(fewApps(), async page => {
        const rects = () => page.evaluate(() => ['#get-started', '.node[data-id="shelf"]'].map(sel => {
          const r = document.querySelector(sel).getBoundingClientRect();
          return [r.left + scrollX, r.top + scrollY, r.width, r.height].map(Math.round).join(' ');
        }));
        const text = () => page.textContent('#get-started [data-step="copy"] [data-text]');
        const [before, said] = [await rects(), await text()];
        await page.click('.node[data-id="shelf"]');
        assert.deepEqual(await done(page), [true, true, false]);
        assert.equal(await text(), said, 'the text stays put');
        assert.deepEqual(await rects(), before, 'the card and the clicked card stay where they were');
      }, { viewport: { width, height }, storage: { getStarted: 'open' } });
    });
  }

  // The map has a fixed or screen-capped height on wider screens; the strip adds its own height on top of it.
  for (const [width, height] of [[1440, 900], [1366, 768], [1180, 800], [1024, 800], [768, 1024]]) {
    test('at ' + width + 'x' + height + ' the strip keeps the map its room, nothing spills out of main and every button stays inside the card', async () => {
      const measure = page => page.evaluate(() => {
        const main = document.querySelector('main'), box = main.getBoundingClientRect(), card = document.getElementById('get-started');
        const shown = Array.from(main.children).filter(el => el.getClientRects().length);
        const inside = card.getClientRects().length ? Array.from(card.querySelectorAll('button')).filter(b => b.getClientRects().length).every(b => {
          const r = b.getBoundingClientRect(), c = card.getBoundingClientRect();
          return r.left >= c.left && r.right <= c.right;
        }) : true;
        return { map: Math.round(document.querySelector('.canvas').getBoundingClientRect().height), spill: Math.max(0, ...shown.map(el => Math.round(el.getBoundingClientRect().bottom - box.bottom))), inside };
      });
      let closed = null;
      await open(fewApps(), async page => { closed = await measure(page); }, { viewport: { width, height }, storage: { getStarted: 'closed' } });
      await open(fewApps(), async page => {
        const strip = await measure(page);
        assert.equal(await card(page) !== null, true, 'the strip is on screen');
        assert.equal(strip.map, closed.map, 'the map keeps the height it has without the strip');
        assert.equal(strip.spill, 0, 'nothing spills out of main');
        assert.equal(strip.inside, true, 'every button stays inside the card');
        await page.getByRole('button', { name: 'Dismiss Get started' }).click();
        assert.deepEqual(await measure(page), closed, 'Dismiss gives back the page as it is without the strip');
      }, { viewport: { width, height }, storage: { getStarted: 'open' } });
    });
  }

  test('a startup link on the map ticks step 3, and the last tick shows 3 of 3 until the next load', async () => {
    await open(demoPage(), async page => {
      assert.deepEqual(await done(page), [true, false, true]);
      assert.match(await page.textContent('#get-started'), /starts before/);
      await page.click('.node[data-id="ledger"]');
      assert.equal(await count(page), '3 of 3');
      assert.equal(await saved(page), 'closed', 'already closed for the next load');
      assert.notEqual(await card(page), null, 'still on screen now');
      await page.reload();
      assert.equal(await card(page), null);
    }, { storage: { getStarted: 'open' } });
  });

  test('a map that had apps before this browser first opened it never shows the card', async () => {
    await open(demoPage(), async page => {
      assert.equal(await card(page), null);
      assert.equal(await saved(page), 'closed');
    });
  });

  test('an empty map in a browser that used Startclip before does not show it', async () => {
    await open(emptyPage(), async page => {
      assert.equal(await card(page), null);
      assert.equal(await shows(page, '#first-run-title'), true);
    }, { storage: { recent: ['gone'] } });
  });

  test('a map that cannot be read decides nothing', async () => {
    const broken = emptyPage().replace('<script id="catalog" type="application/json">', '<script id="catalog" type="application/json">{');
    await open(broken, async page => {
      assert.equal(await card(page), null);
      assert.equal(await saved(page), null);
    });
  });

  test('storage that throws, or a saved text that is broken, decides nothing and keeps the empty screen', async () => {
    for (const init of [() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } }); },
      () => { localStorage.setItem('launchpad', '{broken'); }]) {
      const written = writePage(emptyPage()), context = await browser.newContext();
      try {
        await context.addInitScript(init);
        const page = await context.newPage();
        await page.goto(written.url);
        assert.equal(await card(page), null);
        assert.equal(await shows(page, '#first-run-title'), true);
      } finally { await context.close(); removePage(written); }
    }
  });

  for (const scheme of ['dark', 'light']) {
    for (const [width, height] of [[390, 844], [320, 700]]) {
      test('fits ' + width + ' px with AA contrast in the ' + scheme + ' theme, empty and as a strip', async () => {
        for (const [html, storage] of [[emptyPage(), undefined], [fewApps(), { getStarted: 'open', theme: scheme }]]) {
          await open(html, async page => {
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no sideways scroll');
            await page.evaluate(installContrast);
            assert.deepEqual(await page.evaluate(contrastFailures), []);
            const small = await page.evaluate(() => Array.from(document.querySelectorAll('#get-started button')).filter(b => b.getClientRects().length > 0 && b.getBoundingClientRect().height < 44).map(b => b.textContent));
            assert.deepEqual(small, [], 'touch-sized buttons');
          }, { viewport: { width, height }, colorScheme: scheme, storage: storage ?? { theme: scheme } });
        }
      });
    }
  }
});
