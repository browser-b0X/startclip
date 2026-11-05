const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { demoPage, jsonBlock, shippedPage } = require('./support/pages.cjs');

// Shells and the pty helper the generated scripts are checked with. Tests that need a
// missing one are skipped with the reason instead of failing on a null exit status.
function findBinary(envName, candidates) {
  for (const candidate of [process.env[envName], ...candidates].filter(Boolean)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
const FISH = findBinary('FISH_BIN', ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish']);
const BASH = findBinary('BASH_BIN', ['/usr/bin/bash', '/bin/bash', '/usr/local/bin/bash']);
const PYTHON = findBinary('PYTHON_BIN', ['/usr/bin/python3', '/usr/local/bin/python3']);
const PTY_OK = !!PYTHON && spawnSync(PYTHON, ['-c', 'import pty'], { encoding: 'utf8' }).status === 0;
const needShells = (FISH && BASH) ? {} : { skip: 'needs fish and bash (FISH_BIN / BASH_BIN)' };
const needBash = BASH ? {} : { skip: 'needs bash (BASH_BIN)' };
const needPty = (BASH && PTY_OK) ? {} : { skip: 'needs bash and a python3 with the pty module' };
function run(binary, args, options) {
  const result = spawnSync(binary, args, { encoding: 'utf8', ...options });
  assert.equal(result.error, undefined, binary + ' could not run: ' + (result.error && result.error.message));
  return result;
}

// Chains write their logs under XDG_STATE_HOME; keep them out of the project tree.
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-test-'));
after(() => fs.rmSync(STATE, { recursive: true, force: true }));

function block(html, id) {
  const match = html.match(new RegExp('<script id="' + id + '" type="application/json">([\\s\\S]*?)</script>'));
  return match ? match[1] : null;
}
// The checks run on the shipped engine filled with the synthetic demo map, so they hold for any map index.html carries.
function load() {
  const html = demoPage();
  const catalogText = block(html, 'catalog');
  const catalog = JSON.parse(catalogText);
  const viewsText = block(html, 'views');
  const views = viewsText === null ? null : JSON.parse(viewsText);
  const metaText = block(html, 'catalog-meta');
  const meta = metaText === null ? null : JSON.parse(metaText);
  const context = { module: { exports: {} } };
  vm.runInNewContext(html.match(/<script id="core">([\s\S]*?)<\/script>/)[1], context);
  return { html, catalogText, catalog, views, meta, core: context.module.exports };
}
function scriptBody(command) {
  const result = run(FISH, ['--no-config', '-c', command.replace(/^bash -c /, 'printf "%s" ')]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const ids = values => Array.from(values, app => app.id);

test('catalog has three workspaces, unique IDs and exact commands', () => {
  const { catalog } = load();
  assert.deepEqual([...new Set(catalog.map(x => x.view))].sort(), ['ai', 'desktop', 'services']);
  assert.equal(new Set(catalog.map(x => x.id)).size, catalog.length);
  for (const app of catalog) {
    assert.ok(app.name && app.command && app.note && app.group);
    assert.ok(!app.command.includes('<model>'));
    assert.ok(!/[\r\n]/.test(app.command));
  }
});
test('every catalog cell passes the schema check and is written in canonical form', () => {
  const { catalog, catalogText, views, core } = load();
  assert.equal(typeof core.validateCatalog, 'function', 'core exports validateCatalog');
  assert.ok(views, 'workspace definitions live in <script id="views">');
  assert.deepEqual(Array.from(core.validateCatalog(catalog, views)), []);
  const order = ['id', 'name', 'view', 'group', 'type', 'command', 'port', 'note', 'status', 'warning', 'icon', 'tone'];
  const lines = catalogText.split('\n').filter(line => line.startsWith('{'));
  assert.equal(lines.length, catalog.length, 'one catalog object per line');
  lines.forEach((line, i) => {
    const object = JSON.parse(line.replace(/,$/, ''));
    const canonical = JSON.stringify(Object.fromEntries(order.filter(key => key in object).map(key => [key, object[key]])));
    assert.equal(line.replace(/,$/, ''), canonical, 'line ' + (i + 1) + ' uses the canonical key order');
    assert.equal(line.endsWith(','), i < lines.length - 1, 'commas separate entries');
  });
});
test('the schema check names every kind of broken cell', () => {
  const { catalog, views, core } = load();
  const base = catalog.find(app => app.id === 'modeler');
  const problems = cell => Array.from(core.validateCatalog([...catalog, { ...base, id: 'probe', ...cell }], views)).join('\n');
  assert.match(problems({ id: 'modeler' }), /duplicate id/);
  assert.match(problems({ id: 'bad id' }), /letters, digits/);
  assert.match(problems({ view: 'nowhere' }), /unknown workspace "nowhere"/);
  assert.match(problems({ group: 'mystery' }), /group "mystery" is not declared/);
  assert.match(problems({ icon: 'unicorn' }), /unknown icon "unicorn"/);
  assert.match(problems({ status: 'broken' }), /unknown status "broken"/);
  assert.match(problems({ tone: 'loud' }), /unknown tone "loud"/);
  assert.match(problems({ port: '80a' }), /port must look like/);
  assert.match(problems({ command: 'one\ntwo' }), /several lines/);
  assert.match(problems({ note: '' }), /missing note/);
  assert.match(problems({ colour: 'red' }), /unknown field "colour"/);
  const tables = { connections: [{ from: 'engine', to: 'modeler' }, { from: 'ghost', to: 'modeler' }], dependencyStartup: {}, removalPackages: { ghost: 'x' }, actionComposeDirs: {}, manualRelaunchIds: new Set(['phantom']), removalReasons: {} };
  const tableProblems = Array.from(core.validateCatalog(catalog, views, Object.keys(core.icons), tables)).join('\n');
  assert.match(tableProblems, /no readiness check for engine/);
  assert.match(tableProblems, /ghost → modeler names an unknown id/);
  assert.match(tableProblems, /removalPackages lists unknown id "ghost"/);
  assert.match(tableProblems, /manualRelaunchIds lists unknown id "phantom"/);
});
test('catalog meta is empty or records when file presence was last verified', () => {
  const meta = jsonBlock(shippedPage(), 'catalog-meta');
  assert.ok(meta, 'the page has a catalog-meta block');
  if ('checked' in meta) assert.match(meta.checked, /^\d{4}-\d{2}-\d{2}$/);
});
test('an optional link is drawn but never copied', () => {
  const { catalog, core } = load();
  assert.ok(core.connections.some(edge => edge.from === 'reason' && edge.to === 'helper' && edge.optional));
  assert.equal(core.startupPlan(catalog, core.connections, 'helper').command, catalog.find(app => app.id === 'helper').command);
});
test('search matches commands, ports, warnings, status and ids, ignores case, and reports no results', () => {
  const { catalog, core } = load();
  assert.ok(core.filterApps(catalog, 'desktop', 'all', 'MODELER').some(x => x.id === 'modeler'));
  assert.ok(core.filterApps(catalog, 'ai', 'all', '8091').some(x => x.id === 'vision'));
  assert.equal(core.filterApps(catalog, 'desktop', 'all', 'missing-app').length, 0);
  assert.ok(core.filterApps(catalog, 'ai', 'agents', '').every(x => x.group === 'agents'));
  const forcibly = ids(core.filterApps(catalog, 'ai', 'all', 'forcibly'));
  for (const id of ['orbit7', 'orbit9', 'orbit35', 'switcher']) assert.ok(forcibly.includes(id), id + ' warning is searchable');
  assert.ok(ids(core.filterApps(catalog, 'ai', 'all', 'blocked')).includes('stalled'), 'status is searchable');
  assert.ok(ids(core.filterApps(catalog, 'services', 'all', 'reader')).includes('reader'), 'id is searchable');
});
test('shared ports list the other cells that use the same port', () => {
  const { catalog, core } = load();
  assert.equal(typeof core.sharedPorts, 'function');
  const sharing = ids(core.sharedPorts(catalog, 'orbit7'));
  for (const id of ['budget', 'reader', 'switcher']) assert.ok(sharing.includes(id), id);
  assert.ok(!sharing.includes('orbit7'));
  assert.deepEqual(ids(core.sharedPorts(catalog, 'shelf')), []);
  assert.deepEqual(ids(core.sharedPorts(catalog, 'modeler')), []);
});
test('copy returns real status; denied clipboard falls back, failures are explicit', async () => {
  const { core } = load();
  let captured;
  assert.equal(await core.copyText('modeler', async text => { captured = text; }, () => false), 'copied');
  assert.equal(captured, 'modeler');
  assert.equal(await core.copyText('pilot', async () => { throw Error('denied'); }, () => true), 'copied');
  assert.equal(await core.copyText('pilot', null, () => false), 'manual');
  assert.equal(await core.copyText('pilot', null, () => { throw Error('denied'); }), 'manual');
});
test('required chains include prerequisites first and leave optional links out', () => {
  const { catalog, core } = load();
  assert.equal(typeof core.startupPlan, 'function', 'dependency planning is available');
  const dependents = core.connections.filter(edge => !edge.optional);
  assert.ok(dependents.length > 0);
  for (const edge of dependents) {
    const plan = core.startupPlan(catalog, core.connections, edge.to);
    assert.deepEqual(ids(plan.apps), [edge.from, edge.to]);
    assert.ok(plan.command.startsWith('bash -c '));
  }
  for (const id of ['ledger', 'budget', 'scraper', 'reader']) {
    const plan = core.startupPlan(catalog, core.connections, id);
    assert.ok(plan.command.includes('docker info'));
    assert.ok(plan.command.includes('/usr/bin/demo-engine'));
  }
  assert.ok(core.startupPlan(catalog, core.connections, 'gatemcp').command.includes('/health'));
  const dependentIds = new Set(dependents.map(edge => edge.to));
  for (const app of catalog.filter(app => !dependentIds.has(app.id) && app.status !== 'blocked')) {
    assert.equal(core.startupPlan(catalog, core.connections, app.id).command, app.command, app.id);
  }
});
test('chains explain themselves as numbered steps', () => {
  const { catalog, core } = load();
  const ledger = core.startupPlan(catalog, core.connections, 'ledger');
  assert.ok(Array.isArray(ledger.steps) && ledger.steps.length === 3, 'tools, prerequisite, target');
  assert.match(ledger.steps[0], /docker/);
  assert.match(ledger.steps[1], /Docker Engine/);
  assert.match(ledger.steps[1], /180 s/);
  assert.match(ledger.steps[1], /engine\.log/);
  assert.match(ledger.steps[2], /Start Ledger/);
  assert.deepEqual(Array.from(core.startupPlan(catalog, core.connections, 'modeler').steps), []);
});
test('transitive dependencies are deduplicated in topological order', () => {
  const { core } = load();
  const apps = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, command: 'true' }));
  const edges = [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }];
  const policies = Object.fromEntries(['a', 'b', 'c'].map(id => [id, { probe: 'true', timeout: 1, tools: [] }]));
  const plan = core.startupPlan(apps, edges, 'd', policies);
  assert.deepEqual(ids(plan.apps), ['a', 'b', 'c', 'd']);
});
test('invalid dependency chains fail closed', () => {
  const { core } = load();
  const apps = [{ id: 'a', name: 'A', command: 'true' }, { id: 'b', name: 'B', command: 'true' }];
  assert.throws(() => core.startupPlan(apps, [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], 'b'), /cycle/i);
  assert.throws(() => core.startupPlan(apps, [{ from: 'missing', to: 'b' }], 'b'), /missing/i);
  assert.throws(() => core.startupPlan([{ ...apps[0], status: 'blocked' }, apps[1]], [{ from: 'a', to: 'b' }], 'b'), /incomplete/i);
  assert.throws(() => core.startupPlan(apps, [{ from: 'a', to: 'b' }], 'b', {}), /readiness/i);
});
test('all generated chains parse in fish and bash without starting apps', needShells, () => {
  const { catalog, core } = load();
  for (const edge of core.connections.filter(edge => !edge.optional)) {
    const plan = core.startupPlan(catalog, core.connections, edge.to);
    const fish = run(FISH, ['--no-config', '--no-execute', '-c', plan.command]);
    assert.equal(fish.status, 0, fish.stderr);
    const bash = run(BASH, ['-n'], { input: plan.command });
    assert.equal(bash.status, 0, bash.stderr);
    const inner = run(BASH, ['-n'], { input: scriptBody(plan.command) });
    assert.equal(inner.status, 0, inner.stderr);
  }
});
test('ready dependencies are reused and target quoting survives both shells', needShells, () => {
  const { core } = load();
  const apps = [{ id: 'dep', name: 'Dependency', command: 'printf MUST_NOT_START' }, { id: 'app', name: 'App', command: 'printf "%s" "quote\' dollar\\$ semicolon;"' }];
  const plan = core.startupPlan(apps, [{ from: 'dep', to: 'app' }], 'app', { dep: { probe: 'true', timeout: 1, tools: [] } });
  const result = run(FISH, ['--no-config', '-c', plan.command], { timeout: 5000, env: { ...process.env, XDG_STATE_HOME: STATE } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "quote' dollar$ semicolon;");
  assert.ok(!result.stdout.includes('MUST_NOT_START'));
});
test('a missing dependency starts in background and readiness gates the target', needShells, () => {
  const { core } = load();
  const token = 'ready-' + process.pid + '-' + Date.now();
  const apps = [{ id: 'dep', name: 'Test dependency', command: 'printf ' + token }, { id: 'app', name: 'Test app', command: 'printf TARGET_READY' }];
  const policy = { dep: { probe: 'grep -q ' + token + ' "$log_dir/dep.log" 2>/dev/null', timeout: 5, tools: ['grep'] } };
  const plan = core.startupPlan(apps, [{ from: 'dep', to: 'app' }], 'app', policy);
  const result = run(FISH, ['--no-config', '-c', plan.command], { timeout: 10000, env: { ...process.env, XDG_STATE_HOME: STATE } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'TARGET_READY');
  const log = path.join(STATE, 'launchpad', 'dep.log');
  assert.ok(fs.readFileSync(log, 'utf8').includes(token));
  assert.equal(fs.statSync(log).mode & 0o777, 0o600, 'the log stays private');
  assert.equal(fs.statSync(path.dirname(log)).mode & 0o777, 0o700, 'the log folder stays private');
  assert.ok(!fs.existsSync(path.join(__dirname, '.chain-runtime')), 'nothing is written into the project tree');
});
test('the chain keeps the caller umask for the apps it starts', needShells, () => {
  const { core } = load();
  const apps = [{ id: 'dep', name: 'Dependency', command: 'umask > "$XDG_STATE_HOME/dep-umask"' }, { id: 'app', name: 'App', command: 'umask' }];
  const policy = { dep: { probe: 'test -s "$XDG_STATE_HOME/dep-umask"', timeout: 5, tools: ['test'] } };
  const plan = core.startupPlan(apps, [{ from: 'dep', to: 'app' }], 'app', policy);
  const state = fs.mkdtempSync(path.join(STATE, 'umask-'));
  const result = run(BASH, ['-c', 'umask 022; exec ' + FISH + ' --no-config -c "$1"', 'bash', plan.command], { timeout: 10000, env: { ...process.env, XDG_STATE_HOME: state } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0022', 'the target keeps the caller umask');
  assert.equal(fs.readFileSync(path.join(state, 'dep-umask'), 'utf8').trim(), '0022', 'the background dependency keeps the caller umask');
});
test('readiness failure prevents downstream execution', needShells, () => {
  const { core } = load();
  const apps = [{ id: 'dep', name: 'Test dependency', command: 'true' }, { id: 'app', name: 'Test app', command: 'printf MUST_NOT_START' }];
  const plan = core.startupPlan(apps, [{ from: 'dep', to: 'app' }], 'app', { dep: { probe: 'false', timeout: 0, tools: [] } });
  const result = run(FISH, ['--no-config', '-c', plan.command], { timeout: 5000, env: { ...process.env, XDG_STATE_HOME: STATE } });
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes('MUST_NOT_START'));
  assert.match(result.stderr, /not ready|timed out/i);
  assert.match(result.stderr, /dep\.log/);
});
test('footer exposes copy-only actions and preserves settings by default', () => {
  const { html, core } = load();
  assert.equal(typeof core.lifecyclePlan, 'function');
  for (const id of ['relaunch-command', 'remove-command', 'copy-relaunch', 'copy-remove', 'preserve-settings', 'action-app-name']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.match(html, /id="preserve-settings"[^>]*checked/);
});
test('package removal is exact, interactive, and keeps settings and dependencies', needShells, () => {
  const { catalog, core } = load();
  const packages = Object.entries(core.removalPackages);
  assert.ok(packages.length > 0);
  for (const [id, pkg] of packages) {
    const plan = core.lifecyclePlan(catalog, core.connections, id, 'remove');
    assert.ok(plan.command, id);
    const body = scriptBody(plan.command);
    assert.ok(body.includes('sudo pacman -R -- ' + pkg));
    assert.ok(body.includes('REMOVE ' + id));
    assert.ok(body.indexOf('read -r') < body.indexOf('sudo pacman'));
    assert.ok(!/-Rns|--noconfirm|rm -rf|autoremove/.test(body));
    assert.equal(plan.cleanupAvailable, false);
    assert.equal(core.lifecyclePlan(catalog, core.connections, id, 'remove', false).command, '');
  }
});
test('compose actions are project-scoped and only explicit opt-out deletes volumes', needShells, () => {
  const { catalog, core } = load();
  const dirs = Object.entries(core.actionComposeDirs);
  assert.ok(dirs.length > 0);
  for (const [id, dir] of dirs) {
    const restart = core.lifecyclePlan(catalog, core.connections, id, 'relaunch');
    assert.match(scriptBody(restart.command), /docker compose -f docker-compose\.yml --profile '\*' restart/);
    for (const preserve of [true, false]) {
      const plan = core.lifecyclePlan(catalog, core.connections, id, 'remove', preserve);
      const body = scriptBody(plan.command);
      assert.ok(body.includes('cd -- "$HOME/' + dir + '"'));
      assert.ok(body.includes('docker compose -f docker-compose.yml --profile \'*\' down'));
      assert.equal(body.includes('--volumes'), !preserve);
      assert.ok(body.includes(preserve ? 'REMOVE ' + id : 'DELETE DATA ' + id));
      assert.ok(!/system prune|volume prune|--rmi|stack\.sh down/.test(body));
      assert.equal(plan.cleanupAvailable, true);
    }
  }
});
test('manual relaunches require closing the app and retain startup warnings', needShells, () => {
  const { catalog, core } = load();
  const manual = Array.from(core.manualRelaunchIds);
  assert.ok(manual.length > 0);
  for (const id of manual) {
    const plan = core.lifecyclePlan(catalog, core.connections, id, 'relaunch');
    assert.match(plan.note, /quit|stop|close/i, id);
    const body = scriptBody(plan.command);
    assert.ok(body.includes('RELAUNCH ' + id));
    assert.ok(body.includes('exec /usr/bin/fish --no-config -c'));
    assert.ok(!/pkill|killall|kill -9|fuser/.test(body));
    const warning = catalog.find(app => app.id === id).warning;
    if (warning) assert.ok(plan.note.includes(warning), id + ' keeps its warning');
  }
  const forced = core.lifecyclePlan(catalog, core.connections, 'orbit7', 'relaunch');
  assert.equal(forced.command, '');
  assert.match(forced.note, /forcibly|shared/i);
});
test('every catalog cell falls into exactly one re-launch class', () => {
  const { catalog, core } = load();
  for (const app of catalog) {
    const classes = [core.manualRelaunchIds.has(app.id), Object.hasOwn(core.actionComposeDirs, app.id)].filter(Boolean).length;
    assert.ok(classes <= 1, app.id + ' is both a manual and a compose re-launch');
    const plan = core.lifecyclePlan(catalog, core.connections, app.id, 'relaunch');
    assert.equal(!!plan.command, classes === 1 && app.status !== 'blocked', app.id);
    if (!plan.command) assert.ok(plan.note, app.id + ' explains why');
  }
});
test('relaunchReasons explain a missing re-launch, and the schema checks their ids', () => {
  const { catalog, views, core } = load();
  const reasons = Object.entries(core.relaunchReasons);
  assert.ok(reasons.length > 0);
  for (const [id, why] of reasons) {
    const plan = core.lifecyclePlan(catalog, core.connections, id, 'relaunch');
    assert.equal(plan.command, '', id);
    assert.equal(plan.note, why, id);
  }
  const tables = { connections: [], dependencyStartup: {}, removalPackages: {}, actionComposeDirs: {}, manualRelaunchIds: new Set(), relaunchReasons: { ghost: 'x' }, removalReasons: {} };
  assert.match(Array.from(core.validateCatalog(catalog, views, Object.keys(core.icons), tables)).join('\n'), /relaunchReasons lists unknown id "ghost"/);
});
test('unknown and unsafe actions fail closed with explanations', () => {
  const { catalog, core } = load();
  for (const app of catalog.filter(app => app.status === 'blocked')) {
    const plan = core.lifecyclePlan(catalog, core.connections, app.id, 'relaunch');
    assert.equal(plan.command, '');
    assert.match(plan.note, /re-launch/i, app.id + ' explains the re-launch, not a chain copy');
  }
  for (const id of ['gatemcp', 'reader']) {
    const plan = core.lifecyclePlan(catalog, core.connections, id, 'relaunch');
    assert.equal(plan.command, '');
    assert.ok(plan.note);
  }
  const removable = new Set([...Object.keys(core.removalPackages), ...Object.keys(core.actionComposeDirs), ...Object.keys(core.removalAppImages), ...Object.keys(core.removalPipx)]);
  for (const id of [...catalog.map(app => app.id).filter(id => !removable.has(id)), 'unknown']) {
    const plan = core.lifecyclePlan(catalog, core.connections, id, 'remove');
    assert.equal(plan.command, '', id);
    assert.ok(plan.note);
  }
  for (const id of Object.keys(core.removalReasons)) {
    assert.equal(core.lifecyclePlan(catalog, core.connections, id, 'remove').note, core.removalReasons[id], id);
  }
  assert.equal(core.lifecyclePlan(catalog, core.connections, 'modeler', 'unknown').command, '');
  const blocked = catalog.map(app => app.id === 'engine' ? { ...app, status: 'blocked' } : app);
  assert.equal(core.lifecyclePlan(blocked, core.connections, 'ledger', 'relaunch').command, '');
  assert.ok(core.lifecyclePlan(blocked, core.connections, 'ledger', 'remove').command);
});
test('re-launch and removal plans explain themselves in plain steps', () => {
  const { catalog, core } = load();
  const remove = core.lifecyclePlan(catalog, core.connections, 'modeler', 'remove');
  assert.ok(Array.isArray(remove.steps) && remove.steps.length >= 2);
  assert.match(remove.steps[0], /type REMOVE modeler/);
  assert.ok(remove.steps.some(step => step.includes('sudo pacman -R -- modeler')));
  const relaunch = core.lifecyclePlan(catalog, core.connections, 'ledger', 'relaunch');
  assert.ok(relaunch.steps.some(step => step.includes('docker compose')));
  const chain = core.lifecyclePlan(catalog, core.connections, 'modeler', 'relaunch');
  assert.ok(chain.steps.some(step => step.includes('/usr/bin/modeler')));
  assert.deepEqual(Array.from(core.lifecyclePlan(catalog, core.connections, 'orbit7', 'relaunch').steps), []);
});
test('readiness checks are data: command, loopback HTTP and loopback TCP', () => {
  const { core } = load();
  assert.equal(typeof core.readinessCheck, 'function');
  const command = core.readinessCheck({ check: { kind: 'command', run: 'docker info', seconds: 5 } });
  assert.equal(command.test, 'timeout 5 docker info >/dev/null 2>&1');
  assert.deepEqual(Array.from(command.tools).sort(), ['docker', 'timeout']);
  const http = core.readinessCheck({ check: { kind: 'http', url: 'http://127.0.0.1:8100/health', expect: '"ok"', seconds: 3 } });
  assert.match(http.test, /^curl --fail --silent --max-time 3 'http:\/\/127\.0\.0\.1:8100\/health' \| grep -E /);
  const plain = core.readinessCheck({ check: { kind: 'http', url: 'http://localhost:8188/', seconds: 2 } });
  assert.match(plain.test, /--output \/dev\/null/);
  const tcp = core.readinessCheck({ check: { kind: 'tcp', port: 8080, seconds: 2 } });
  assert.match(tcp.test, /\/dev\/tcp\/127\.0\.0\.1\/8080/);
  for (const bad of [{ kind: 'http', url: 'https://example.com/', seconds: 3 }, { kind: 'tcp', port: 70000, seconds: 2 }, { kind: 'tcp', port: 80, host: '10.0.0.5', seconds: 2 },
    { kind: 'command', run: 'a\nb', seconds: 2 }, { kind: 'command', run: 'docker info', seconds: 0 }, { kind: 'ping', seconds: 2 }]) {
    assert.throws(() => core.readinessCheck({ check: bad }), /readiness check/i, JSON.stringify(bad));
  }
  assert.equal(core.readinessCheck({ probe: 'true', tools: ['x'] }).test, 'true', 'a raw shell probe is still accepted');
});
test('every readiness check in the page is data and parses in bash', needShells, () => {
  const { core } = load();
  for (const [id, policy] of Object.entries(core.dependencyStartup)) {
    assert.ok(policy.check && !policy.probe, id + ' uses a data check');
    const result = run(BASH, ['-n'], { input: 'if ! { ' + core.readinessCheck(policy).test + '; }; then :; fi' });
    assert.equal(result.status, 0, id + ': ' + result.stderr);
  }
});
test('edge conditions: completed runs first and must succeed; started does not wait', needShells, () => {
  const { core } = load();
  const apps = [{ id: 'dep', name: 'Setup step', command: 'printf DEP_RAN' }, { id: 'app', name: 'App', command: 'printf TARGET' }];
  const done = core.startupPlan(apps, [{ from: 'dep', to: 'app', condition: 'completed' }], 'app', {});
  const ok = run(FISH, ['--no-config', '-c', done.command], { timeout: 5000, env: { ...process.env, XDG_STATE_HOME: STATE } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'TARGET');
  assert.match(fs.readFileSync(path.join(STATE, 'launchpad', 'dep.log'), 'utf8'), /DEP_RAN/);
  assert.match(done.steps[1], /continue only if it finishes without an error/);
  const failing = core.startupPlan([{ ...apps[0], command: 'printf BROKEN; exit 4' }, apps[1]], [{ from: 'dep', to: 'app', condition: 'completed' }], 'app', {});
  const bad = run(FISH, ['--no-config', '-c', failing.command], { timeout: 5000, env: { ...process.env, XDG_STATE_HOME: STATE } });
  assert.equal(bad.status, 1);
  assert.ok(!bad.stdout.includes('TARGET'));
  assert.match(bad.stderr, /Setup step failed/);
  assert.match(bad.stderr, /BROKEN/);
  const started = core.startupPlan(apps, [{ from: 'dep', to: 'app', condition: 'started' }], 'app', { dep: { probe: 'false', timeout: 30, tools: [] } });
  const begun = Date.now();
  const quick = run(FISH, ['--no-config', '-c', started.command], { timeout: 5000, env: { ...process.env, XDG_STATE_HOME: STATE } });
  assert.equal(quick.status, 0, quick.stderr);
  assert.equal(quick.stdout, 'TARGET');
  assert.ok(Date.now() - begun < 3000, 'started does not wait for readiness');
  assert.throws(() => core.startupPlan(apps, [{ from: 'dep', to: 'app', condition: 'whenever' }], 'app', {}), /condition/i);
});
test('a prerequisite that crashes ends the wait at once and shows its log', needShells, () => {
  const { core } = load();
  const apps = [{ id: 'dep', name: 'Crashing dependency', command: 'printf CRASH_DETAIL; exit 3' }, { id: 'app', name: 'App', command: 'printf MUST_NOT_START' }];
  const plan = core.startupPlan(apps, [{ from: 'dep', to: 'app' }], 'app', { dep: { probe: 'false', timeout: 60, tools: [] } });
  const state = fs.mkdtempSync(path.join(STATE, 'crash-'));
  const begun = Date.now();
  const result = run(FISH, ['--no-config', '-c', plan.command], { timeout: 20000, env: { ...process.env, XDG_STATE_HOME: state } });
  assert.equal(result.status, 1);
  assert.ok(Date.now() - begun < 8000, 'fails fast instead of waiting 60 s');
  assert.ok(!result.stdout.includes('MUST_NOT_START'));
  assert.match(result.stderr, /Crashing dependency stopped before it was ready \(exit 3\)/);
  assert.match(result.stderr, /CRASH_DETAIL/, 'the end of the log is shown');
});
test('a prerequisite that hands off to a background process and exits cleanly is still waited for', needShells, () => {
  const { core } = load();
  const state = fs.mkdtempSync(path.join(STATE, 'handoff-'));
  const apps = [{ id: 'dep', name: 'Daemon', command: "sh -c '(sleep 1; touch \"$XDG_STATE_HOME/up\") >/dev/null 2>&1 &'" }, { id: 'app', name: 'App', command: 'printf TARGET' }];
  const plan = core.startupPlan(apps, [{ from: 'dep', to: 'app' }], 'app', { dep: { probe: 'test -e "$XDG_STATE_HOME/up"', timeout: 10, tools: ['test'] } });
  const result = run(FISH, ['--no-config', '-c', plan.command], { timeout: 15000, env: { ...process.env, XDG_STATE_HOME: state } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'TARGET');
});
test('a readiness timeout shows the end of the log', needShells, () => {
  const { core } = load();
  const state = fs.mkdtempSync(path.join(STATE, 'timeout-'));
  const apps = [{ id: 'dep', name: 'Slow dependency', command: 'printf SLOW_DETAIL; sleep 3' }, { id: 'app', name: 'App', command: 'printf MUST_NOT_START' }];
  const plan = core.startupPlan(apps, [{ from: 'dep', to: 'app' }], 'app', { dep: { probe: 'false', timeout: 1, tools: [] } });
  const result = run(FISH, ['--no-config', '-c', plan.command], { timeout: 15000, env: { ...process.env, XDG_STATE_HOME: state } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not ready/);
  assert.match(result.stderr, /SLOW_DETAIL/);
});
test('removal and re-launch scripts name the cells that need the app, above the confirmation', needShells, () => {
  const { catalog, core } = load();
  assert.equal(typeof core.dependentsOf, 'function');
  const needEngine = Array.from(core.dependentsOf(catalog, core.connections, 'engine'), app => app.name);
  for (const name of ['Ledger', 'Budget Board', 'Scraper', 'Reader Backend']) assert.ok(needEngine.includes(name), name);
  for (const kind of ['remove', 'relaunch']) {
    const plan = core.lifecyclePlan(catalog, core.connections, 'engine', kind);
    const body = scriptBody(plan.command);
    const confirm = body.indexOf('Type ' + (kind === 'remove' ? 'REMOVE' : 'RELAUNCH') + ' engine');
    for (const name of needEngine) {
      assert.ok(plan.note.includes(name), kind + ' note names ' + name);
      assert.ok(body.indexOf(name) > -1 && body.indexOf(name) < confirm, kind + ' script names ' + name + ' before the confirmation');
    }
  }
  assert.ok(core.lifecyclePlan(catalog, core.connections, 'gate', 'relaunch').note.includes('Gate MCP'));
  assert.ok(!core.lifecyclePlan(catalog, core.connections, 'modeler', 'remove').note.includes('Cells that need'), 'no dependents line without dependents');
});
test('AppImage and pipx removals come from tables the schema checks', () => {
  const { catalog, views, core } = load();
  assert.equal(core.removalAppImages.ticker, 'Applications/Ticker-0.2.4-x86_64.AppImage');
  assert.equal(core.removalPipx.parser, 'parser-tool');
  const tables = { connections: core.connections, dependencyStartup: core.dependencyStartup, removalPackages: core.removalPackages, actionComposeDirs: core.actionComposeDirs,
    manualRelaunchIds: core.manualRelaunchIds, removalReasons: core.removalReasons, removalAppImages: { ...core.removalAppImages, ghost: 'x.AppImage' }, removalPipx: { parser: 'bad name;rm' } };
  const problems = Array.from(core.validateCatalog(catalog, views, Object.keys(core.icons), tables)).join('\n');
  assert.match(problems, /removalAppImages lists unknown id "ghost"/);
  assert.match(problems, /removalPipx entry for parser/);
  const unsafe = { ...tables, removalAppImages: { ticker: '../escape.AppImage' }, removalPipx: core.removalPipx };
  assert.match(Array.from(core.validateCatalog(catalog, views, Object.keys(core.icons), unsafe)).join('\n'), /removalAppImages entry for ticker/);
});
test('every startup chain and script can be saved as a runnable .sh file', needShells, () => {
  const { catalog, core } = load();
  assert.equal(typeof core.shellFile, 'function');
  for (const app of catalog.filter(app => app.status !== 'blocked')) {
    const startup = core.startupPlan(catalog, core.connections, app.id);
    const file = core.shellFile(startup.script, 'Startclip startup for ' + app.name);
    assert.ok(file.startsWith('#!/usr/bin/env bash\n# Startclip startup for ' + app.name + '\n'), app.id);
    assert.equal(run(BASH, ['-n'], { input: file }).status, 0, app.id);
    for (const kind of ['relaunch', 'remove']) {
      const plan = core.lifecyclePlan(catalog, core.connections, app.id, kind);
      if (!plan.command) continue;
      const saved = core.shellFile(plan.script, kind);
      assert.equal(run(BASH, ['-n'], { input: saved }).status, 0, app.id + ' ' + kind);
      assert.ok(saved.includes('/dev/tty'), app.id + ' ' + kind + ' keeps the confirmation');
    }
  }
  const single = core.startupPlan(catalog, core.connections, 'modeler');
  assert.equal(single.script, "exec /usr/bin/fish --no-config -c '/usr/bin/modeler'");
  assert.throws(() => core.shellFile('true', 'two\nlines'), /one line/);
});
test('AppImage and pipx removal target only the verified installation', needShells, () => {
  const { catalog, core } = load();
  const image = scriptBody(core.lifecyclePlan(catalog, core.connections, 'ticker', 'remove').command);
  assert.ok(image.includes('rm -i -- "$HOME/Applications/Ticker-0.2.4-x86_64.AppImage"'));
  assert.ok(!image.includes('.config'));
  const parser = scriptBody(core.lifecyclePlan(catalog, core.connections, 'parser', 'remove').command);
  assert.ok(parser.includes('pipx uninstall parser-tool'));
  assert.ok(!parser.includes('stack.sh down'));
});
test('every available lifecycle script parses in fish and bash without execution', needShells, () => {
  const { catalog, core } = load();
  for (const app of catalog) for (const kind of ['relaunch', 'remove']) for (const preserve of [true, false]) {
    const plan = core.lifecyclePlan(catalog, core.connections, app.id, kind, preserve);
    if (!plan.command) continue;
    const fish = run(FISH, ['--no-config', '--no-execute', '-c', plan.command]);
    assert.equal(fish.status, 0, app.id + ': ' + fish.stderr);
    const outer = run(BASH, ['-n'], { input: plan.command });
    assert.equal(outer.status, 0, outer.stderr);
    const body = scriptBody(plan.command);
    const inner = run(BASH, ['-n'], { input: body });
    assert.equal(inner.status, 0, app.id + ': ' + inner.stderr);
    assert.ok(body.includes('/dev/tty'));
    assert.ok(body.includes('exit 1'));
  }
});
test('confirmation guard rejects noninteractive runs before reaching any action', needBash, () => {
  const { core } = load();
  const script = core.confirmedScript('printf MUST_NOT_RUN', 'Quit first.', 'CONFIRM TEST');
  for (const env of [process.env, { ...process.env, POSIXLY_CORRECT: '1' }]) {
    const result = run(BASH, ['-c', script], { detached: true, timeout: 2000, input: 'CONFIRM TEST\n', env });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(!result.stdout.includes('MUST_NOT_RUN'));
    assert.match(result.stderr, /An interactive terminal is required\. Nothing changed\./);
    assert.doesNotMatch(result.stderr, /No such device|bash: line/, 'no raw shell error precedes the explanation');
  }
});
test('confirmation requires the exact typed token in a real terminal', needPty, () => {
  const { core } = load();
  const script = core.confirmedScript('printf ACTION_REACHED', "Save the app's work first.", 'CONFIRM TEST');
  const python = `import os, pty, sys, json
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[3], ['bash', '-c', sys.argv[1]])
data = b''
sent = False
while True:
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    data += chunk
    if not sent and b'anything else cancels.' in data:
        os.write(fd, b'\\x04' if sys.argv[2] == 'EOF' else sys.argv[2].encode() + b'\\n')
        sent = True
_, status = os.waitpid(pid, 0)
os.close(fd)
print(json.dumps({'status':os.waitstatus_to_exitcode(status), 'output':data.decode()}))`;
  for (const response of ['wrong', '', 'EOF', 'CONFIRM TEST']) {
    const result = run(PYTHON, ['-c', python, script, response, BASH], { timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const terminal = JSON.parse(result.stdout);
    const accepted = response === 'CONFIRM TEST';
    assert.equal(terminal.status, accepted ? 0 : 1, JSON.stringify(response));
    assert.equal(terminal.output.includes('ACTION_REACHED'), accepted);
    if (!accepted) assert.match(terminal.output, /Canceled\. Nothing changed\./, JSON.stringify(response) + ' says it canceled');
  }
});
test('map entry commands are copy-only, quote safely in fish and bash, and name the right cell', needShells, () => {
  const { catalog, core } = load();
  // The skill sits next to the page in this project and is linked into ~/.claude/skills; copies of the page may have neither.
  const skill = [path.join(__dirname, '..', '.claude'), path.join(os.homedir(), '.claude')]
    .map(dir => path.join(dir, 'skills', 'launchpad-add-cell', 'scripts', 'add_cell.py')).find(file => fs.existsSync(file));
  if (skill) assert.ok(fs.readFileSync(skill, 'utf8').includes("add_parser('check'"), 'the check command names a real subcommand');
  const odd = { id: 'odd', name: "O'Brien \\ \"app\"", command: "echo 'hi' $HOME `x`" };
  for (const app of [...catalog, odd]) {
    const map = core.mapEntryCommands(app);
    assert.equal(map.check, 'python3 ~/.claude/skills/launchpad-add-cell/scripts/add_cell.py check');
    for (const kind of ['update', 'remove']) {
      assert.match(map[kind], /^claude '/, kind + ' starts Claude with one quoted prompt');
      const words = map[kind].slice('claude '.length);
      const viaBash = run(BASH, ['-c', 'printf "%s" ' + words]).stdout;
      const viaFish = run(FISH, ['--no-config', '-c', 'printf "%s" ' + words]).stdout;
      assert.equal(viaFish, viaBash, app.id + ' ' + kind + ' reads the same in fish and bash');
      assert.ok(viaBash.includes(app.name + ' (id ' + app.id + ')') && viaBash.includes('launchpad-add-cell'), app.id + ' ' + kind + ' names the cell and the skill');
      assert.ok(viaBash.includes('only after I approve'), kind + ' asks for approval before writing');
    }
    const update = run(BASH, ['-c', 'printf "%s" ' + map.update.slice(7)]).stdout;
    assert.ok(update.includes('`' + app.command + '`') && update.includes('update ' + app.id), app.id + ' update quotes the current command exactly');
    const remove = run(BASH, ['-c', 'printf "%s" ' + map.remove.slice(7)]).stdout;
    assert.ok(remove.includes('remove ' + app.id) && remove.includes('do not uninstall the app'), app.id + ' remove edits the map only');
  }
});

test('one logo drives the header mark and a fixed-colour inline favicon', () => {
  const { html, core } = load();
  assert.equal(typeof core.icons.logo, 'string', 'the icon set has a logo');
  assert.match(html, /<span class="brand-mark" data-icon="logo"><\/span>/, 'the header mark draws the logo');
  const links = html.match(/<link rel="icon"[^>]*>/g) || [];
  assert.equal(links.length, 1, 'exactly one favicon');
  const href = links[0].match(/href="([^"]+)"/)[1];
  assert.ok(href.startsWith('data:image/svg+xml,'), 'the favicon is inline, so nothing is fetched');
  const svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length));
  const path_ = core.icons.logo.match(/ d="([^"]+)"/)[1];
  assert.ok(svg.includes('d="' + path_ + '"'), 'the favicon draws the same path as the header');
  // A circle with an arrow off it reads as the male symbol (the first logo did); the logo stays free of circles.
  assert.ok(!/<circle|<ellipse/.test(core.icons.logo), 'the logo uses no circles');
  assert.ok(svg.includes('fill="#c9f53f"') && svg.includes('fill="#14170f"'), 'an ink S on a lime tile, in every theme');
  assert.ok(!/clipPath|<mask/.test(svg), 'one flat path, so icon themes and the .ico draw it exactly');
  assert.ok(!/var\(|currentColor|prefers-color-scheme/.test(svg), 'the favicon does not follow the theme');
});

test('the public name is Startclip; launchpad survives only as a command-line word', () => {
  const { html } = load();
  assert.match(html, /<title>Startclip · /);
  assert.match(html, /<span class="brand-name">Startclip<\/span>/);
  assert.ok(!html.includes('Launchpad'), 'the old public name is gone from the page');
});

test('Web services is the first workspace, and a saved order is cleaned before use', () => {
  const { views, core } = load();
  const keys = Object.keys(views);
  assert.equal(keys[0], 'services', 'the first workspace is the one with chains to trace');
  assert.equal(typeof core.workspaceOrder, 'function');
  const order = saved => Array.from(core.workspaceOrder(keys, saved));
  assert.deepEqual(order(undefined), keys);
  assert.deepEqual(order('junk'), keys);
  assert.deepEqual(order(['ai', 'services', 'desktop']), ['ai', 'services', 'desktop']);
  assert.deepEqual(order(['ai', 'ai', 'ghost', 7]), ['ai', 'services', 'desktop'], 'unknown and repeated keys go; missing ones follow in default order');
});

test('moveWorkspace moves one workspace one slot and stops at the ends', () => {
  const { core } = load();
  assert.equal(typeof core.moveWorkspace, 'function');
  const move = (key, delta) => Array.from(core.moveWorkspace(['a', 'b', 'c'], key, delta));
  assert.deepEqual(move('b', -1), ['b', 'a', 'c']);
  assert.deepEqual(move('b', 1), ['a', 'c', 'b']);
  assert.deepEqual(move('a', -1), ['a', 'b', 'c']);
  assert.deepEqual(move('c', 1), ['a', 'b', 'c']);
  assert.deepEqual(move('ghost', 1), ['a', 'b', 'c']);
});

// Copies of the page made by tools (the add-cell self-test) carry no assets folder; setup.test.cjs insists on it.
const ASSETS = path.join(__dirname, '..', 'assets');
test('the Windows shortcut icon was built from the current favicon',
  fs.existsSync(path.join(ASSETS, 'startclip.ico.source')) ? {} : { skip: 'no assets folder beside this copy of the page' }, () => {
  const { html } = load();
  const dir = ASSETS;
  const href = html.match(/<link rel="icon" href="([^"]+)">/)[1];
  const want = require('node:crypto').createHash('sha256').update(href).digest('hex');
  assert.ok(fs.existsSync(path.join(dir, 'startclip.ico')), 'assets/startclip.ico exists (node tools/make-icon.cjs)');
  assert.equal(fs.readFileSync(path.join(dir, 'startclip.ico.source'), 'utf8').split(/\s/)[0], want,
    'the logo changed: rebuild the icon with node tools/make-icon.cjs');
  const ico = fs.readFileSync(path.join(dir, 'startclip.ico'));
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2)], [0, 1], 'an ICO header');
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico.readUInt8(6 + 16 * i) || 256);
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
  for (let i = 0; i < sizes.length; i++) {
    const offset = ico.readUInt32LE(6 + 16 * i + 12);
    assert.equal(ico.subarray(offset, offset + 4).toString('latin1'), '\x89PNG', sizes[i] + ' px is a PNG');
  }
});

test('traceRoute follows the copied startup chain: prerequisites first, required links only', () => {
  const { catalog, core } = load();
  const ledger = core.traceRoute(catalog, core.connections, 'ledger');
  assert.deepEqual(Array.from(ledger.ids), Array.from(core.startupPlan(catalog, core.connections, 'ledger').apps, app => app.id), 'same order as the copied chain');
  assert.deepEqual(JSON.parse(JSON.stringify(ledger.edges)), [{ from: 'engine', to: 'ledger', step: 0 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(core.traceRoute(catalog, core.connections, 'gameeditor').edges)), [], 'optional links are not traced');
  assert.deepEqual(Array.from(core.traceRoute(catalog, core.connections, 'modeler').ids), ['modeler'], 'a lone app traces only itself');
  const toy = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase(), command: '/usr/bin/' + id }));
  const toyEdges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'd', to: 'c', optional: true }];
  const policies = { a: core.dependencyStartup.engine, b: core.dependencyStartup.engine };
  const route = core.traceRoute(toy, toyEdges, 'c', policies);
  assert.deepEqual(Array.from(route.ids), ['a', 'b', 'c']);
  assert.deepEqual(JSON.parse(JSON.stringify(route.edges)), [{ from: 'a', to: 'b', step: 0 }, { from: 'b', to: 'c', step: 1 }], 'each link draws in start order');
  const broken = core.traceRoute([...toy.slice(1), { id: 'a', name: 'A', command: '' }], toyEdges, 'c', policies);
  assert.deepEqual(JSON.parse(JSON.stringify(broken)), { ids: ['c'], edges: [] }, 'a chain that cannot be copied is not traced');
});

test('standalone page contains no remote dependencies or execution bridge', () => {
  const { html } = load();
  assert.ok(!/<script[^>]+src=|<link[^>]+href=["']https?:/i.test(html));
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket\(|child_process|eval\(/.test(html));
  assert.ok(html.includes('prefers-reduced-motion'));
  assert.ok(html.includes('aria-live="polite"'));
});
