'use strict';
// Variants of the page for the tests and the README images: the shipped engine with other data. Everything is built
// in memory or in a temp folder, so these never touch index.html and work whatever map the real page holds.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..', '..');
const INDEX_PATH = path.join(root, 'index.html');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-map.json'), 'utf8'));
const KEY_ORDER = ['id', 'name', 'view', 'group', 'type', 'command', 'port', 'note', 'status', 'warning', 'icon', 'tone'];

const quoted = text => "'" + String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const canonical = cell => JSON.stringify(Object.fromEntries(KEY_ORDER.filter(key => key in cell).map(key => [key, cell[key]])));
const pairs = (table, separator) => Object.entries(table).map(([key, value]) => key + ':' + quoted(value)).join(separator);
const blockLines = lines => lines.length ? '\n' + lines.join(',\n') + '\n' : '\n';
const edge = ({ from, to, optional, condition }) => '{from:' + quoted(from) + ',to:' + quoted(to) + (optional ? ',optional:true' : condition ? ',condition:' + quoted(condition) : '') + '}';
const checkText = check => '{' + ['kind', 'run', 'url', 'expect', 'port', 'host', 'seconds'].filter(key => key in check)
  .map(key => key + ':' + (typeof check[key] === 'number' ? check[key] : quoted(check[key]))).join(', ') + '}';
const policy = ([id, value]) => '  ' + id + ': {' + (value.prepare ? 'prepare:' + quoted(value.prepare) + ', ' : '') + 'check:' + checkText(value.check) + ', ready:' + quoted(value.ready) + ', timeout:' + value.timeout + '}';

// The tables in the exact layout index.html and the add-cell skill use, one regular expression per table.
const TABLES = {
  connections: [/^const connections = \[.*\];$/m, value => 'const connections = [' + value.map(edge).join(',') + '];'],
  dependencyStartup: [/^const dependencyStartup = \{\n[\s\S]*?^\};$/m, value => 'const dependencyStartup = {' + blockLines(Object.entries(value).map(policy)) + '};'],
  removalPackages: [/^const removalPackages = \{\n[\s\S]*?^\};$/m, value => 'const removalPackages = {' + blockLines(Object.entries(value).map(([id, pkg]) => '  ' + id + ':' + quoted(pkg))) + '};'],
  actionComposeDirs: [/^const actionComposeDirs = \{.*\};$/m, value => 'const actionComposeDirs = {' + pairs(value, ', ') + '};'],
  removalAppImages: [/^const removalAppImages = \{.*\};$/m, value => 'const removalAppImages = {' + pairs(value, ', ') + '};'],
  removalPipx: [/^const removalPipx = \{.*\};$/m, value => 'const removalPipx = {' + pairs(value, ', ') + '};'],
  manualRelaunchIds: [/^const manualRelaunchIds = new Set\(\[.*\]\);$/m, value => 'const manualRelaunchIds = new Set([' + value.map(quoted).join(',') + ']);'],
  relaunchReasons: [/^const relaunchReasons = \{\n[\s\S]*?^\};$/m, value => 'const relaunchReasons = {' + blockLines(Object.entries(value).map(([id, why]) => '  ' + id + ':' + quoted(why))) + '};'],
  removalReasons: [/^const removalReasons = \{\n[\s\S]*?^\};$/m, value => 'const removalReasons = {' + blockLines(Object.entries(value).map(([id, why]) => '  ' + id + ':' + quoted(why))) + '};']
};
const EMPTY_TABLES = { connections: [], dependencyStartup: {}, removalPackages: {}, actionComposeDirs: {}, removalAppImages: {}, removalPipx: {}, manualRelaunchIds: [], relaunchReasons: {}, removalReasons: {} };

function replaceBlock(html, id, body) {
  const pattern = new RegExp('(<script id="' + id + '" type="application/json">\\n)[\\s\\S]*?(\\n</script>)');
  if (!pattern.test(html)) throw Error('the page has no ' + id + ' block');
  return html.replace(pattern, (_, open, close) => open + body + close);
}

// Swap the data blocks and core tables of a page. Tables left out of `data` are emptied; views left out stay as they are.
function fillPage(html, { catalog = [], views = null, meta = {}, tables = {} } = {}) {
  let page = replaceBlock(html, 'catalog', '[' + (catalog.length ? '\n' + catalog.map(canonical).join(',\n') : '') + '\n]');
  if (views) page = replaceBlock(page, 'views', '{\n' + Object.entries(views).map(([key, value]) => JSON.stringify({ [key]: value }).slice(1, -1)).join(',\n') + '\n}');
  page = replaceBlock(page, 'catalog-meta', JSON.stringify(meta));
  for (const [name, [pattern, write]] of Object.entries(TABLES)) {
    const value = tables[name] ?? EMPTY_TABLES[name];
    if (pattern.test(page)) page = page.replace(pattern, () => write(value));
    else if (Object.keys(value).length) throw Error('the page has no ' + name + ' table');
  }
  return page;
}

const shippedPage = () => fs.readFileSync(INDEX_PATH, 'utf8');
const emptyPage = (html = shippedPage()) => fillPage(html);
const demoPage = (html = shippedPage()) => fillPage(html, demo);

// A page variant on disk, in its own temp folder. Pass the result to removePage when done.
function writePage(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-page-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  return { dir, file, url: pathToFileURL(file).href };
}
const removePage = written => fs.rmSync(written.dir, { recursive: true, force: true });

// Parts of a page, for checks that do not need a browser.
const jsonBlock = (html, id) => {
  const match = html.match(new RegExp('<script id="' + id + '" type="application/json">([\\s\\S]*?)</script>'));
  return match ? JSON.parse(match[1]) : null;
};
function coreOf(html) {
  const context = { module: { exports: {} } };
  require('node:vm').runInNewContext(html.match(/<script id="core">([\s\S]*?)<\/script>/)[1], context);
  return context.module.exports;
}

// `node tests/support/pages.cjs demo|empty OUT [SOURCE]` writes a variant to a file, for helpers that are not written in
// JavaScript (the add-cell self-tests).
if (require.main === module) {
  const [kind, out, source] = process.argv.slice(2);
  const html = source ? fs.readFileSync(source, 'utf8') : shippedPage();
  if (!['demo', 'empty'].includes(kind) || !out) { console.error('usage: node pages.cjs demo|empty OUT [SOURCE]'); process.exit(2); }
  fs.writeFileSync(out, kind === 'demo' ? demoPage(html) : emptyPage(html));
}

module.exports = { demo, canonical, fillPage, shippedPage, emptyPage, demoPage, writePage, removePage, jsonBlock, coreOf, INDEX_PATH };
