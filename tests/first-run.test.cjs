'use strict';
// The page with an empty map, with its first cells, and as it stands on disk. Each check opens a page variant from
// tests/support/pages.cjs, so these hold for any map index.html carries. LAUNCHPAD_RELEASE=1 adds the release check
// that the page ships empty; it stays off by default because a user's own map is not empty.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TOOLS_DIR, resolveTool, installContrast, contrastFailures, clipboardHarness } = require('./support/browser.cjs');
const { canonical, demo, emptyPage, fillPage, shippedPage, writePage, removePage, jsonBlock, coreOf, INDEX_PATH } = require('./support/pages.cjs');

const SKILL = path.join(__dirname, '..', '.claude', 'skills', 'launchpad-add-cell', 'SKILL.md');
const WIDTHS = [[1440, 1000], [1024, 900], [768, 1024], [390, 844], [320, 700]];
const firstRunShown = () => { const el = document.getElementById('first-run'); return !!el && !el.hidden && el.getClientRects().length > 0; };
const cell = (id, view, group, extra = {}) => ({ id, name: 'App ' + id, view, group, type: 'Test app', command: '/usr/bin/' + id, note: 'A test cell.', icon: 'terminal', ...extra });

test('validateCatalog accepts an empty map with empty tables', () => {
  const html = emptyPage();
  assert.deepEqual(Array.from(coreOf(html).validateCatalog(jsonBlock(html, 'catalog'), jsonBlock(html, 'views'))), []);
});

test('no app is named in the engine: every per-app fact lives in a table', () => {
  const core = coreOf(emptyPage());
  assert.doesNotMatch(core.lifecyclePlan.toString(), /\bid\s*===\s*'|\]\.includes\(id\)/, 'lifecyclePlan decides by table, not by id');
});

test('the shipped page validates and stays in canonical form', () => {
  const html = shippedPage(), catalog = jsonBlock(html, 'catalog');
  assert.deepEqual(Array.from(coreOf(html).validateCatalog(catalog, jsonBlock(html, 'views'))), []);
  const lines = html.match(/<script id="catalog" type="application\/json">([\s\S]*?)<\/script>/)[1].split('\n').filter(line => line.startsWith('{'));
  assert.deepEqual(lines.map(line => line.replace(/,$/, '')), catalog.map(canonical));
});

test('a public release ships an empty map', { skip: process.env.LAUNCHPAD_RELEASE === '1' ? false : 'set LAUNCHPAD_RELEASE=1 before publishing' }, () => {
  const html = shippedPage();
  assert.deepEqual(jsonBlock(html, 'catalog'), []);
  assert.deepEqual(jsonBlock(html, 'catalog-meta'), {});
  assert.equal(html, emptyPage(html), 'every core table is empty too');
});

const playwrightEntry = resolveTool('playwright');
if (!playwrightEntry) {
  test('first-run browser checks', { skip: 'Playwright is not resolvable from ' + TOOLS_DIR }, () => {});
  return;
}
const playwright = require(playwrightEntry);
const AXE_PATH = resolveTool('axe-core/axe.min.js');

describe('first run', { timeout: 180000 }, () => {
  let browser;
  before(async () => { browser = await playwright.chromium.launch({ headless: process.env.LAUNCHPAD_HEADED !== '1' }); });
  after(async () => { if (browser) await browser.close(); });

  // Opens a page variant in a fresh context with the clipboard stubbed, runs the check, then fails on any script error.
  async function open(html, check, { viewport = { width: 1440, height: 1000 }, colorScheme = 'dark', theme, storage, noStorage = false } = {}) {
    const written = writePage(html), context = await browser.newContext({ viewport, colorScheme });
    try {
      await context.addInitScript(clipboardHarness, { mode: 'stub' });
      if (noStorage) await context.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } }); });
      // The empty screen is what a browser sees once Get started is closed; tests/get-started.test.cjs covers the card.
      if (!noStorage) await context.addInitScript(value => { localStorage.setItem('launchpad', JSON.stringify(value)); }, { getStarted: 'closed', ...storage, ...(theme ? { theme } : {}) });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(written.url);
      await check(page);
      assert.deepEqual(errors, [], 'no uncaught script errors');
    } finally {
      await context.close();
      removePage(written);
    }
  }
  const empty = (check, options) => open(emptyPage(), check, options);
  const shows = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); return !!el && el.getClientRects().length > 0; }, selector);

  describe('an empty map', () => {
    test('opens on the first-run screen with no script errors and no problem banner', async () => {
      await empty(async page => {
        assert.ok(await page.evaluate(firstRunShown), 'the first-run screen shows');
        assert.ok(await page.evaluate(() => document.getElementById('catalog-problems').hidden), 'no problem banner');
        assert.ok(!await shows(page, '.node'), 'no cards');
        for (const part of ['.sidebar', '#inspector', '.workspace-header', '.canvas-bottom']) assert.ok(!await shows(page, part), part + ' waits for a first app');
        assert.equal(await page.evaluate(() => document.querySelectorAll('h1:not([hidden])').length && Array.from(document.querySelectorAll('h1')).filter(h => h.getClientRects().length).length), 1, 'one visible main heading');
      });
    });

    test('says plainly that the map is empty and names the skill', async () => {
      await empty(async page => {
        assert.equal(await page.textContent('#first-run-title'), 'Your map is empty');
        const text = await page.textContent('#first-run');
        assert.match(text, /ships with no apps/);
        assert.match(text, /launchpad-add-cell/);
        assert.match(text, /<script id="catalog">/, 'the by-hand step names the block');
        assert.match(text, /Reload this page/, 'a static page needs a reload to show new cards');
        assert.match(text, /pacman/, 'where the skill works is stated');
      });
    });

    test('offers the phrases the skill actually answers to', async () => {
      const skill = fs.readFileSync(SKILL, 'utf8');
      assert.match(skill, /- "add X to Startclip"/);
      assert.match(skill, /- "search FOLDER for apps to add"/);
      await empty(async page => {
        assert.equal((await page.textContent('[data-starter="one"] code')).trim(), 'add Obsidian to Startclip');
        assert.equal((await page.textContent('[data-starter="folder"] code')).trim(), 'search ~/Applications for apps to add');
      });
    });

    test('the by-hand line is a cell the page itself accepts', async () => {
      const html = emptyPage();
      await empty(async page => {
        const line = (await page.textContent('[data-starter="line"] code')).trim();
        const parsed = JSON.parse(line);
        assert.equal(canonical(parsed), line, 'written in canonical form');
        assert.deepEqual(Array.from(coreOf(html).validateCatalog([parsed], jsonBlock(html, 'views'))), []);
      });
    });

    test('every starter copies exactly what it shows and says nothing ran', async () => {
      await empty(async page => {
        for (const key of ['one', 'folder', 'line']) {
          const card = page.locator('[data-starter="' + key + '"]');
          await card.click();
          await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Nothing executed'));
          assert.equal(await page.evaluate(() => window.__copied), (await card.locator('code').textContent()).trim(), key);
          await page.waitForSelector('[data-starter="' + key + '"].copied');
          await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
        }
      });
    });

    test('a denied clipboard falls back to the legacy path, then to selected text', async () => {
      await empty(async page => {
        await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; });
        await page.click('[data-starter="folder"]');
        await page.waitForFunction(() => window.__copied === 'search ~/Applications for apps to add');
        await page.evaluate(() => { document.execCommand = () => false; });
        await page.click('[data-starter="one"]');
        await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('Clipboard blocked'));
        const manual = await page.evaluate(() => { const box = document.getElementById('first-run-text'); return { shown: box.getClientRects().length > 0, focused: document.activeElement === box, value: box.value, whole: box.selectionEnd === box.value.length && box.selectionStart === 0 }; });
        assert.deepEqual(manual, { shown: true, focused: true, value: 'add Obsidian to Startclip', whole: true });
      });
    });

    test('nothing on the screen can run anything: no links, URL schemes or forms, and the policy stands', async () => {
      await empty(async page => {
        await page.evaluate(() => { window.__violations = []; document.addEventListener('securitypolicyviolation', event => window.__violations.push(event.violatedDirective)); });
        assert.equal(await page.locator('#first-run a, #first-run form, #first-run iframe').count(), 0);
        for (const key of ['one', 'folder', 'line']) await page.click('[data-starter="' + key + '"]');
        assert.deepEqual(await page.evaluate(() => window.__violations), []);
        assert.match(await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content'), /^default-src 'none';/);
      });
    });

    test('the keyboard reaches every starter and Enter copies', async () => {
      await empty(async page => {
        const reached = [];
        for (let i = 0; i < 8 && reached.length < 3; i++) {
          await page.keyboard.press('Tab');
          const key = await page.evaluate(() => document.activeElement?.dataset?.starter || null);
          if (key) reached.push(key);
        }
        assert.deepEqual(reached, ['one', 'folder', 'line']);
        await page.focus('[data-starter="line"]');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__copied?.startsWith('{"id":"obsidian"'));
      });
    });

    test('workspace keys and a window resize do nothing odd while the map is empty', async () => {
      await empty(async page => {
        await page.evaluate(() => document.activeElement.blur());
        for (const key of ['/', '1', '2', '3', 'Escape']) await page.keyboard.press(key);
        await page.setViewportSize({ width: 1100, height: 800 });
        await page.waitForTimeout(200);
        assert.ok(await page.evaluate(firstRunShown));
      });
    });

    test('saved state from an earlier map cannot break it', async () => {
      await empty(async page => {
        assert.ok(await page.evaluate(firstRunShown));
      }, { storage: { workspace: 'ai', order: ['ai', 'desktop', 'services'], selected: 'ghost', recent: ['ghost'], zoom: 1.2 } });
    });

    test('it works when browser storage throws', async () => {
      await empty(async page => {
        assert.ok(await page.evaluate(firstRunShown));
        await page.click('[data-starter="one"]');
        await page.waitForFunction(() => window.__copied === 'add Obsidian to Startclip');
      }, { noStorage: true });
    });

    test('nothing jumps while the page settles, a starter copies or the theme changes', async () => {
      const rects = page => page.evaluate(() => Array.from(document.querySelectorAll('#first-run-title, #first-run-lead, #first-run h2, .starter, .first-run-next, .topbar'), el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(); }));
      await empty(async page => {
        const settled = await rects(page);
        await page.waitForTimeout(300);
        assert.deepEqual(await rects(page), settled, 'still after a moment');
        await page.click('[data-starter="one"]');
        await page.waitForSelector('[data-starter="one"].copied');
        assert.deepEqual(await rects(page), settled, 'copying moves nothing');
        await page.waitForFunction(() => !document.querySelector('.starter.copied'), null, { timeout: 3000 });
        assert.deepEqual(await rects(page), settled, 'the icon going back moves nothing');
        await page.selectOption('#theme', 'light');
        assert.deepEqual(await rects(page), settled, 'the theme moves nothing');
        const shift = await page.evaluate(() => new Promise(done => {
          let total = 0;
          new PerformanceObserver(list => { for (const entry of list.getEntries()) total += entry.value; }).observe({ type: 'layout-shift', buffered: true });
          setTimeout(() => done(total), 250);
        }));
        assert.equal(shift, 0, 'no layout shift since the page opened');
      });
    });

    test('the toast leaves the reload line readable', async () => {
      await empty(async page => {
        await page.click('[data-starter="one"]');
        await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'));
        await page.waitForTimeout(250);
        const gap = await page.evaluate(() => document.getElementById('toast').getBoundingClientRect().top - document.querySelector('.first-run-next').getBoundingClientRect().bottom);
        assert.ok(gap >= 0, 'the toast covers the reload line by ' + (-gap) + ' px');
      }, { viewport: { width: 1440, height: 900 } });
    });

    for (const scheme of ['dark', 'light']) {
      test('fits every width with AA contrast and touch-sized starters in the ' + scheme + ' theme', async () => {
        for (const [width, height] of WIDTHS) {
          await empty(async page => {
            await page.evaluate(installContrast);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + 'px: no sideways scroll');
            assert.deepEqual(await page.evaluate(contrastFailures), [], width + 'px');
            const short = await page.evaluate(() => Array.from(document.querySelectorAll('.starter')).filter(el => el.getBoundingClientRect().height < 44).length);
            assert.equal(short, 0, width + 'px: starters are at least 44 px tall');
            const cut = await page.evaluate(() => Array.from(document.querySelectorAll('.starter code')).filter(el => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > innerWidth).length);
            assert.equal(cut, 0, width + 'px: every starter shows its whole text');
          }, { viewport: { width, height }, colorScheme: scheme, theme: scheme });
        }
      });
      for (const [width, height] of WIDTHS) {
        test('axe-core finds no serious or critical violations at ' + width + 'px (' + scheme + ')', { timeout: 30000 }, async t => {
          if (!AXE_PATH) return t.skip('axe-core is not resolvable from ' + TOOLS_DIR);
          await empty(async page => {
            await page.addScriptTag({ path: AXE_PATH });
            const results = await page.evaluate(() => axe.run(document));
            const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id + ' ' + v.nodes.map(n => n.target.join(' ')).join(' | '));
            assert.deepEqual(blocking, []);
          }, { viewport: { width, height }, colorScheme: scheme, theme: scheme });
        });
      }
    }

    test('a table that names an unknown app still shows its banner beside the first-run screen', async () => {
      const html = emptyPage().replace(/^const removalPipx = \{\};$/m, "const removalPipx = {ghost:'ghost-tool'};");
      await open(html, async page => {
        assert.ok(await page.evaluate(firstRunShown));
        assert.match(await page.textContent('#catalog-problems'), /removalPipx lists unknown id "ghost"/);
      });
    });

    test('a hand-edited catalog that is not valid JSON says so instead of leaving a dead page', async () => {
      const broken = emptyPage().replace('<script id="catalog" type="application/json">\n[\n]', '<script id="catalog" type="application/json">\n[\n{"id":"one"}\n{"id":"two"}\n]');
      await open(broken, async page => {
        assert.ok(await page.evaluate(firstRunShown), 'the page still explains itself');
        assert.match(await page.textContent('#catalog-problems'), /not valid JSON/);
        assert.equal(await page.textContent('#first-run-title'), 'Startclip could not read your map');
        assert.doesNotMatch(await page.textContent('#first-run'), /ships with no apps/, 'the map is not empty, only unreadable');
      });
    });

    test('a views block that is not valid JSON is reported the same way, even with cells in the catalog', async () => {
      const html = fillPage(emptyPage(), { catalog: [cell('solo', 'desktop', 'daily')], views: demo.views }).replace('<script id="views" type="application/json">\n{\n', '<script id="views" type="application/json">\n{oops\n');
      await open(html, async page => {
        assert.ok(await page.evaluate(firstRunShown));
        assert.match(await page.textContent('#catalog-problems'), /views block is not valid JSON/);
      });
    });

    test('a catalog that is not a list is reported the same way', async () => {
      await open(emptyPage().replace('<script id="catalog" type="application/json">\n[\n]', '<script id="catalog" type="application/json">\n{}'), async page => {
        assert.ok(await page.evaluate(firstRunShown));
        assert.match(await page.textContent('#catalog-problems'), /not a list/);
      });
    });
  });

  describe('a first app on the map', () => {
    const only = (...cells) => fillPage(emptyPage(), { catalog: cells, views: demo.views, meta: { checked: '2026-01-15' } });

    for (const [view, group] of [['services', 'independent'], ['desktop', 'daily'], ['ai', 'agents']]) {
      test('one cell in ' + view + ' leaves the first-run screen and opens that workspace', async () => {
        const app = cell('solo', view, group);
        await open(only(app), async page => {
          assert.ok(!await page.evaluate(firstRunShown), 'the first-run screen is gone');
          assert.equal(await page.evaluate(() => document.querySelector('.view[aria-pressed="true"]').dataset.view), view);
          assert.ok(await shows(page, '.node[data-id="solo"]'), 'its card is on the map');
          assert.equal(await page.textContent('#detail-name'), app.name, 'and it is selected');
          await page.click('.node[data-id="solo"]');
          await page.waitForFunction(command => window.__copied === command, app.command);
        });
      });
    }

    test('a default group with no apps falls back to All, so a first model server is not hidden', async () => {
      assert.equal(demo.views.ai.default, 'agents');
      await open(only(cell('solo', 'ai', 'models')), async page => {
        assert.equal(await page.evaluate(() => document.querySelector('#filters [aria-pressed="true"]').dataset.group), 'all');
        assert.ok(await shows(page, '.node[data-id="solo"]'));
      });
    });

    test('a workspace with no apps says so and offers the workspaces that have some', async () => {
      await open(only(cell('solo', 'desktop', 'daily')), async page => {
        await page.click('.view[data-view="services"]');
        assert.ok(await shows(page, '#empty'));
        assert.equal(await page.textContent('#empty h2'), 'Nothing in Web services yet');
        assert.ok(!await shows(page, '#clear-search'), 'there is nothing to clear');
        await page.click('#empty-elsewhere button');
        assert.equal(await page.evaluate(() => document.querySelector('.view[aria-pressed="true"]').dataset.view), 'desktop');
        assert.ok(await shows(page, '.node[data-id="solo"]'));
      });
    });

    test('a search with no match keeps its own message', async () => {
      await open(only(cell('solo', 'desktop', 'daily')), async page => {
        await page.fill('#search', 'nothing-like-this');
        assert.equal(await page.textContent('#empty h2'), 'No matching apps');
        assert.ok(await shows(page, '#clear-search'));
      });
    });

    test('group chips list only the groups that have apps', async () => {
      await open(only(cell('solo', 'desktop', 'daily'), cell('duo', 'desktop', 'coding')), async page => {
        assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#filters .filter'), chip => chip.dataset.group)), ['all', 'coding', 'daily']);
      });
    });

    test('a map nobody checked claims no check', async () => {
      await open(fillPage(emptyPage(), { catalog: [cell('solo', 'desktop', 'daily')], views: demo.views }), async page => {
        assert.doesNotMatch(await page.textContent('#checked-note'), /checked \d/);
        assert.equal(await page.textContent('#detail-status'), 'Not checked');
      });
    });

    test('a full map still opens where a first visit always did', async () => {
      await open(fillPage(emptyPage(), demo), async page => {
        assert.ok(!await page.evaluate(firstRunShown));
        assert.equal(await page.evaluate(() => document.querySelector('.view[aria-pressed="true"]').dataset.view), 'services');
      });
    });
  });

  test('index.html as it stands opens with no script errors and no problem banner', async () => {
    const html = fs.readFileSync(INDEX_PATH, 'utf8'), catalog = jsonBlock(html, 'catalog');
    await open(html, async page => {
      assert.ok(await page.evaluate(() => document.getElementById('catalog-problems').hidden));
      assert.equal(await page.evaluate(firstRunShown), catalog.length === 0);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.node').length) > 0, catalog.length > 0);
    });
  });
});
