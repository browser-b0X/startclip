"""Self-tests for the launchpad-add-cell helpers.

    python3 -I -m unittest discover -s ~/.claude/skills/launchpad-add-cell/scripts -v

Each test fills a copy of the page (LAUNCHPAD_PAGE, else the page at the repository root) with the
synthetic demo map, or empties it, in a temp folder with a stub test suite, a fake HOME (with a fake
AppImage and fake pipx venvs) and a fake read-only pacman and pipx on PATH. The real page, the real
tests, the real package database and the real pipx environments are never touched; nothing is
installed or launched.
"""
from __future__ import annotations

import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import discover  # noqa: E402
import launchpad_common as lc  # noqa: E402

SOURCE = Path(os.environ.get('LAUNCHPAD_PAGE') or lc.DEFAULT_PAGE)
PAGES = lc.DEFAULT_PAGE.parent / 'tests/support/pages.cjs'
REAL_TOOLS = Path(os.environ.get('LAUNCHPAD_TEST_TOOLS') or Path.home() / '.cache/launchpad-test-tools/node_modules')
STUB_TEST = r"""const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
test('the page validates with its own validateCatalog', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const block = id => JSON.parse(html.match(new RegExp('<script id="' + id + '" type="application/json">([\\s\\S]*?)</script>'))[1]);
  const context = { module: { exports: {} } };
  vm.runInNewContext(html.match(/<script id="core">([\s\S]*?)<\/script>/)[1], context);
  assert.deepEqual(Array.from(context.module.exports.validateCatalog(block('catalog'), block('views'))), []);
});
"""
GUARD_TEST = r"""const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
test('no cell called selftestfail', () => {
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').includes('"id":"selftestfail"'));
});
"""
FAKE_PACMAN = r"""#!/bin/sh
# Read-only stand-in for pacman -Qo / -Qi used by the self-tests.
op="$1"; shift; [ "$1" = "--" ] && shift
case "$op:$1" in
  -Qo:*/selftest-app) echo "$1 is owned by selftest-pkg 1.0-1"; exit 0;;
  -Qo:*/selftest-shared) echo "$1 is owned by selftest-lib 1.0-1"; exit 0;;
  -Qi:selftest-pkg) printf 'Name            : selftest-pkg\nVersion         : 1.0-1\nDescription     : A self-test app\nRequired By     : None\n'; exit 0;;
  -Qi:selftest-lib) printf 'Name            : selftest-lib\nVersion         : 1.0-1\nDescription     : A shared library\nRequired By     : other-app\n'; exit 0;;
esac
echo "error: no package owns $1" >&2; exit 1
"""
FAKE_PIPX = r"""#!/bin/sh
# Read-only stand-in for pipx list --short used by the self-tests.
if [ "$1 $2" = "list --short" ]; then printf 'other-pkg 2.0.0\nselftest-pipx 0.1.0\n'; exit 0; fi
echo "fake pipx: only list --short" >&2; exit 1
"""
APPIMAGE = 'Applications/Selfimage-1.0-x86_64.AppImage'


@unittest.skipUnless(SOURCE.is_file() and PAGES.is_file() and shutil.which('node') and shutil.which('bash'), 'needs the page, tests/support/pages.cjs, node and bash')
class Helper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.built = Path(tempfile.mkdtemp(prefix='launchpad-selftest-pages-'))
        for kind in ('demo', 'empty'):
            subprocess.run(['node', str(PAGES), kind, str(cls.built / kind), str(SOURCE)], check=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.built, ignore_errors=True)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='launchpad-selftest-'))
        self.site, self.home, self.bin = self.tmp / 'site', self.tmp / 'home', self.tmp / 'bin'
        for folder in (self.site / 'tests', self.home / 'apps', self.home / 'Projects/selfcompose', self.home / 'Projects/nocompose', self.bin):
            folder.mkdir(parents=True)
        self.page = self.site / 'index.html'
        shutil.copyfile(self.built / 'demo', self.page)
        (self.site / 'tests/catalog.test.cjs').write_text(STUB_TEST)
        self.exe(self.home / 'apps/selftest-app', '#!/bin/sh\nexit 0\n')
        self.exe(self.home / 'apps/selftest-shared', '#!/bin/sh\nexit 0\n')
        self.exe(self.bin / 'pacman', FAKE_PACMAN)
        self.exe(self.bin / 'pipx', FAKE_PIPX)
        (self.home / 'Applications').mkdir()
        self.exe(self.home / APPIMAGE, '#!/bin/sh\nexit 0\n')
        (self.home / 'Applications/Linked.AppImage').symlink_to(self.home / APPIMAGE)
        (self.home / '.local/bin').mkdir(parents=True)
        for pkg, tool in (('selftest-pipx', 'selfpipx'), ('other-pkg', 'otherpipx'), ('unlisted-pkg', 'selfunlisted')):
            venv_bin = self.home / '.local/share/pipx/venvs' / pkg / 'bin'
            venv_bin.mkdir(parents=True)
            self.exe(venv_bin / tool, '#!/bin/sh\nexit 0\n')
            (self.home / '.local/bin' / tool).symlink_to(venv_bin / tool)
        (self.home / 'serve-selftest.sh').write_text('#!/bin/bash\npkill -f llama-server\nllama-server --port 8765\n')
        (self.home / 'start-selfhelper.sh').write_text('#!/bin/bash\nexec selfhelper --port 8766\n')
        (self.home / 'Projects/selfcompose/docker-compose.yml').write_text(
            'services:\n  web:\n    image: x\n    ports:\n      - "127.0.0.1:8000:8000"\n      - "${UI_PORT:-8502}:8502"\n      - 5055:5055\n      - "9000"\n')
        (self.home / 'Projects/nocompose/compose.yaml').write_text('services: {}\n')
        self.env = {**os.environ, 'HOME': str(self.home), 'PATH': '%s:%s' % (self.bin, os.environ.get('PATH', '')),
                    'XDG_STATE_HOME': str(self.tmp / 'state'), 'LAUNCHPAD_TEST_TOOLS': str(self.tmp / 'no-playwright')}
        self.env.pop('LAUNCHPAD_PAGE', None)
        self.env.pop('PIPX_HOME', None)
        page = lc.Page(self.page)
        facts = lc.node_facts(page.render(page.lines).decode('utf-8'))['facts']
        self.views, self.icons, self.facts = facts['views'], facts['iconNames'], facts
        self.group = next(iter(self.views['desktop']['groups']))
        self.original = self.page.read_bytes()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def exe(path: Path, text: str) -> None:
        path.write_text(text)
        path.chmod(0o755)

    def cell(self, **changes) -> dict:
        base = {'id': 'selftest', 'name': 'Self Test', 'view': 'desktop', 'group': self.group, 'type': 'Test app',
                'command': '~/apps/selftest-app', 'note': 'A cell written by the self-tests.', 'icon': self.icons[0]}
        base.update(changes)
        return {key: base[key] for key in lc.KEY_ORDER if key in base} | {k: v for k, v in base.items() if k not in lc.KEY_ORDER}

    def cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, '-I', str(HERE / 'add_cell.py'), *args], env=self.env,
                              capture_output=True, text=True, timeout=600)

    def add(self, cell: dict, core: dict | None = None, *extra: str) -> subprocess.CompletedProcess:
        proposal = self.tmp / 'proposal.json'
        proposal.write_text(json.dumps({'cell': cell, 'core': core or {}}, ensure_ascii=False))
        return self.cli('add', str(proposal), '--page', str(self.page), *extra)

    def assertDone(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('DONE', proc.stdout)

    def assertUnchanged(self):
        self.assertEqual(self.page.read_bytes(), self.original, 'index.html must be byte-identical to the copy')

    # ------------------------------------------------------------ format
    def test_every_catalog_line_is_already_canonical(self):
        page = lc.Page(self.page)
        _, _, entries = lc.catalog_entries(page.lines)
        self.assertTrue(entries)
        for entry in entries:
            self.assertEqual(lc.catalog_line(entry['obj']), entry['raw'], entry['obj']['id'])

    def test_table_locators_read_every_core_table(self):
        lines = lc.Page(self.page).lines
        for name in ('removalAppImages', 'removalPipx', 'actionComposeDirs'):
            table = lc.one_line_table(lines, name)
            self.assertEqual(dict(table['keys']), self.facts[name], name)
        edges = lc.one_line_table(lines, 'connections')['keys']
        self.assertEqual(len(edges), len(self.facts['connections']))
        self.assertEqual([lc.edge_token(e) for e in self.facts['connections']], lc.one_line_table(lines, 'connections')['tokens'])
        self.assertEqual([e['id'] for e in lc.block_table(lines, 'dependencyStartup')['entries']], list(self.facts['dependencyStartup']))
        self.assertEqual(lc.edge_token({'from': 'a', 'to': 'b', 'condition': 'healthy'}), "{from:'a',to:'b'}")
        self.assertEqual(lc.edge_token({'from': 'a', 'to': 'b', 'condition': 'started'}), "{from:'a',to:'b',condition:'started'}")

    def test_existing_commands_fit_the_command_grammar(self):
        page = lc.Page(self.page)
        _, _, entries = lc.catalog_entries(page.lines)
        for entry in entries:
            self.assertIsNotNone(lc.classify_command(entry['obj']['command'])['shape'], entry['obj']['command'])

    # ------------------------------------------------------------ round trips
    def test_dry_run_prints_a_diff_and_writes_nothing(self):
        proc = self.add(self.cell(), {'removalPackages': 'selftest-pkg', 'manualRelaunch': True}, '--dry-run')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        for text in ('verified:', 'edits:', '+++ b/index.html', 'removalPackages selftest-pkg', 'DRY RUN'):
            self.assertIn(text, proc.stdout)
        self.assertUnchanged()

    def test_add_then_remove_restores_the_exact_bytes(self):
        first = self.facts['ids'][0]
        proc = self.add(self.cell(), {'removalPackages': 'selftest-pkg', 'manualRelaunch': True,
                                      'connections': [{'from': first, 'to': 'selftest', 'optional': True}]})
        self.assertDone(proc)
        self.assertIn('render not verified', proc.stdout)
        text = self.page.read_text(encoding='utf-8')
        self.assertIn('"id":"selftest"', text)
        self.assertIn("  selftest:'selftest-pkg'", text)
        self.assertIn("{from:'%s',to:'selftest',optional:true}" % first, text)
        self.assertDone(self.cli('remove', 'selftest', '--page', str(self.page)))
        self.assertUnchanged()

    def written_facts(self) -> dict:
        page = lc.Page(self.page)
        return lc.node_facts(page.render(page.lines).decode('utf-8'))['facts']

    def test_prerequisite_with_data_check_and_dependent_round_trip(self):
        proc = self.add(self.cell(id='selfdep', name='Self Dependency', command='~/apps/selftest-shared'), {},
                        '--check-command', 'test -e /', '--check-seconds', '2', '--ready', "it's there", '--timeout', '5')
        self.assertDone(proc)
        self.assertIn("  selfdep: {check:{kind:'command', run:'test -e /', seconds:2}, ready:'it\\'s there', timeout:5}", self.page.read_text())
        facts = self.written_facts()
        self.assertEqual(facts['dependencyStartup']['selfdep'],
                         {'check': {'kind': 'command', 'run': 'test -e /', 'seconds': 2}, 'ready': "it's there", 'timeout': 5})
        self.assertEqual(facts['readiness']['selfdep']['test'], 'timeout 2 test -e / >/dev/null 2>&1')
        proc = self.add(self.cell(id='selfuser', name='Self User', view='ai', group=next(iter(self.views['ai']['groups'])),
                                  command='bash ~/start-selfhelper.sh'), {'manualRelaunch': True}, '--connection', 'selfdep')
        self.assertDone(proc)
        self.assertIn('startupPlan: selfdep -> selfuser', proc.stdout)
        self.assertIn("{from:'selfdep',to:'selfuser'}];", self.page.read_text())
        self.assertDone(self.cli('remove', 'selfuser', '--page', str(self.page)))
        self.assertDone(self.cli('remove', 'selfdep', '--page', str(self.page)))
        self.assertUnchanged()

    def test_each_check_kind_is_written_in_the_page_layout_and_read_back(self):
        if not (shutil.which('curl') and shutil.which('grep') and shutil.which('timeout')):
            self.skipTest('needs curl, grep and timeout on PATH (readinessCheck names them)')
        cases = [
            (('--check-command', 'test -e /'), "{kind:'command', run:'test -e /', seconds:3}", 120,
             {'kind': 'command', 'run': 'test -e /', 'seconds': 3}, 'timeout 3 test -e / >/dev/null 2>&1'),
            (('--check-http', 'http://127.0.0.1:59999/health', '--check-expect', "it's \\d+ ok", '--check-seconds', '2', '--timeout', '30'),
             "{kind:'http', url:'http://127.0.0.1:59999/health', expect:'it\\'s \\\\d+ ok', seconds:2}", 30,
             {'kind': 'http', 'url': 'http://127.0.0.1:59999/health', 'expect': "it's \\d+ ok", 'seconds': 2},
             "curl --fail --silent --max-time 2 'http://127.0.0.1:59999/health' | grep -E "),
            (('--check-http', 'http://localhost:59999/'), "{kind:'http', url:'http://localhost:59999/', seconds:3}", 120,
             {'kind': 'http', 'url': 'http://localhost:59999/', 'seconds': 3}, "--output /dev/null"),
            (('--check-tcp', '59998', '--check-host', '::1', '--check-seconds', '1', '--timeout', '0'),
             "{kind:'tcp', port:59998, host:'::1', seconds:1}", 0, {'kind': 'tcp', 'port': 59998, 'host': '::1', 'seconds': 1}, '/dev/tcp/::1/59998'),
            (('--check-tcp', '59997'), "{kind:'tcp', port:59997, seconds:3}", 120, {'kind': 'tcp', 'port': 59997, 'seconds': 3},
             '/dev/tcp/127.0.0.1/59997'),
        ]
        for flags, literal, timeout, check, test_part in cases:
            with self.subTest(literal):
                proc = self.add(self.cell(id='selfdep', name='Self Dependency'), {}, *flags, '--ready', 'the self-test answers')
                self.assertDone(proc)
                self.assertIn("  selfdep: {check:%s, ready:'the self-test answers', timeout:%d}" % (literal, timeout), self.page.read_text())
                facts = self.written_facts()
                self.assertEqual(facts['dependencyStartup']['selfdep'], {'check': check, 'ready': 'the self-test answers', 'timeout': timeout})
                self.assertTrue(facts['readiness']['selfdep']['ok'])
                self.assertIn(test_part, facts['readiness']['selfdep']['test'])
                self.assertDone(self.cli('remove', 'selfdep', '--page', str(self.page)))
                self.assertUnchanged()

    def test_edge_conditions_and_optional_links_round_trip(self):
        plain = next(i for i in self.facts['ids'] if i not in self.facts['dependencyStartup'] and self.page_cell(i).get('status') != 'blocked')
        first = self.facts['ids'][0] if self.facts['ids'][0] != plain else self.facts['ids'][1]
        proc = self.add(self.cell(), {}, '--connection', plain + ':completed', '--optional-connection', first)
        self.assertDone(proc)
        self.assertIn('completed: runs %s to the end first, no readiness check needed' % plain, proc.stdout)
        text = self.page.read_text()
        self.assertIn("{from:'%s',to:'selftest',condition:'completed'},{from:'%s',to:'selftest',optional:true}];" % (plain, first), text)
        edges = [e for e in self.written_facts()['connections'] if 'selftest' in (e['from'], e['to'])]
        self.assertEqual(edges, [{'from': plain, 'to': 'selftest', 'condition': 'completed'}, {'from': first, 'to': 'selftest', 'optional': True}])
        self.assertIn('startupPlan: %s -> selftest' % plain, proc.stdout)
        self.assertDone(self.cli('remove', 'selftest', '--page', str(self.page)))
        self.assertUnchanged()
        ready = next((i for i in self.facts['ids'] if self.facts['readiness'].get(i, {}).get('ok')), None)
        if ready is None:
            self.skipTest('the page has no cell with a readiness check')
        for spec, token in ((ready + ':started', ",condition:'started'}"), (ready + ':healthy', "}"), (ready, "}")):
            with self.subTest(spec):
                self.assertDone(self.add(self.cell(), {}, '--connection', spec))
                self.assertIn("{from:'%s',to:'selftest'%s];" % (ready, token), self.page.read_text())
                self.assertDone(self.cli('remove', 'selftest', '--page', str(self.page)))
                self.assertUnchanged()

    def test_appimage_and_pipx_tables_round_trip(self):
        cases = [
            ('selfimage', '~/' + APPIMAGE, (), {'removalAppImages': '~/' + APPIMAGE}, 'removalAppImages', APPIMAGE),
            ('selfimage', '~/' + APPIMAGE, ('--removal-appimage', str(self.home / APPIMAGE)), {}, 'removalAppImages', APPIMAGE),
            ('selfpipx', '~/.local/bin/selfpipx', ('--removal-pipx', 'selftest-pipx'), {}, 'removalPipx', 'selftest-pipx'),
            ('selfpipx', '~/.local/bin/selfpipx', (), {'removalPipx': 'selftest-pipx'}, 'removalPipx', 'selftest-pipx'),
        ]
        for ident, command, flags, core, table, value in cases:
            with self.subTest(table + ' ' + ' '.join(flags)):
                proc = self.add(self.cell(id=ident, command=command), {**core, 'manualRelaunch': True}, *flags)
                self.assertDone(proc)
                self.assertIn('remove script offered', proc.stdout)
                self.assertRegex(self.page.read_text(), r"(?m)^const %s = \{.*%s:'%s'\};$" % (table, ident, value.replace('.', r'\.')))
                self.assertEqual(self.written_facts()[table][ident], value)
                self.assertDone(self.cli('update', ident, '--page', str(self.page), '--set', 'note=Changed by the self-tests.'))
                self.assertEqual(self.written_facts()[table][ident], value)
                self.assertDone(self.cli('remove', ident, '--page', str(self.page)))
                self.assertUnchanged()

    def test_new_group_needs_the_flag_and_round_trips(self):
        proc = self.add(self.cell(group='selftests'))
        self.assertEqual(proc.returncode, 2)
        self.assertIn('--new-group', proc.stderr)
        self.assertUnchanged()
        self.assertDone(self.add(self.cell(group='selftests'), {}, '--new-group', 'selftests=Self tests'))
        self.assertIn('"selftests":"Self tests"', self.page.read_text())
        self.assertDone(self.cli('remove', 'selftest', '--page', str(self.page), '--drop-empty-group'))
        self.assertUnchanged()

    def test_compose_cell_round_trip(self):
        cell = self.cell(id='selfcompose', name='Self Compose', view='services', group=next(iter(self.views['services']['groups'])),
                         command='cd ~/Projects/selfcompose; and docker compose up -d', port='8000 · 8502 · 5055',
                         status='setup', warning='Requires a ready Docker engine.')
        self.assertDone(self.add(cell, {'actionComposeDirs': 'Projects/selfcompose', 'connections': [{'from': 'engine', 'to': 'selfcompose'}]}))
        self.assertIn("selfcompose:'Projects/selfcompose'", self.page.read_text())
        self.assertDone(self.cli('remove', 'selfcompose', '--page', str(self.page)))
        self.assertUnchanged()

    def test_update_changes_one_line_and_changes_back(self):
        self.assertDone(self.add(self.cell()))
        added = self.page.read_bytes()
        proc = self.cli('update', 'selftest', '--page', str(self.page), '--set', 'note=Changed by the self-tests.', '--set', 'port=8123')
        self.assertDone(proc)
        self.assertIn('"port":"8123","note":"Changed by the self-tests."', self.page.read_text())
        self.assertDone(self.cli('update', 'selftest', '--page', str(self.page), '--set', 'note=A cell written by the self-tests.', '--unset', 'port'))
        self.assertEqual(self.page.read_bytes(), added)
        self.assertEqual(self.cli('update', 'selftest', '--page', str(self.page), '--set', 'id=other').returncode, 2)

    def test_crlf_page_keeps_crlf_and_round_trips(self):
        self.page.write_bytes(self.original.replace(b'\n', b'\r\n'))
        self.original = self.page.read_bytes()
        self.assertDone(self.add(self.cell()))
        data = self.page.read_bytes()
        self.assertEqual(data.count(b'\n'), data.count(b'\r\n'))
        self.assertDone(self.cli('remove', 'selftest', '--page', str(self.page)))
        self.assertUnchanged()

    def test_a_new_test_failure_rolls_back_byte_for_byte(self):
        (self.site / 'tests/selftest-guard.test.cjs').write_text(GUARD_TEST)
        proc = self.add(self.cell(id='selftestfail'))
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        self.assertIn('new failure', proc.stdout)
        self.assertIn('ROLLED BACK', proc.stdout)
        self.assertUnchanged()
        self.assertEqual(sorted(p.name for p in self.site.iterdir()), ['index.html', 'tests'], 'no temp files left behind')

    def test_a_red_baseline_refuses_unless_allowed(self):
        (self.site / 'tests/always-red.test.cjs').write_text("require('node:test').test('red before any edit', () => { throw Error('red'); });\n")
        proc = self.add(self.cell())
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('already fails 1 test', proc.stderr)
        self.assertUnchanged()
        self.assertDone(self.add(self.cell(), {}, '--allow-preexisting-failures'))
        self.assertDone(self.cli('remove', 'selftest', '--page', str(self.page), '--allow-preexisting-failures'))
        self.assertUnchanged()

    @unittest.skipUnless((SOURCE.parent / 'tests/catalog.test.cjs').is_file(), 'the real catalog tests are not beside the page')
    def test_round_trip_under_the_real_catalog_tests(self):
        shutil.copyfile(SOURCE.parent / 'tests/catalog.test.cjs', self.site / 'tests/catalog.test.cjs')
        shutil.copytree(PAGES.parent, self.site / 'tests/support')
        proc = self.add(self.cell(), {'removalPackages': 'selftest-pkg', 'manualRelaunch': True})
        self.assertDone(proc)
        summary = re.search(r'after +node --test: (\d+) tests, (\d+) pass, 0 fail, (\d+) skipped', proc.stdout)
        self.assertIsNotNone(summary, 'the page tests ran after the write with 0 failures')
        total, passed, skipped = map(int, summary.groups())
        self.assertEqual(passed + skipped, total, 'every test passed or was skipped for this copy of the page')
        self.assertDone(self.cli('remove', 'selftest', '--page', str(self.page)))
        self.assertUnchanged()

    # ------------------------------------------------------------ an empty map
    def use_empty_page(self) -> None:
        shutil.copyfile(self.built / 'empty', self.page)
        self.original = self.page.read_bytes()
        self.assertEqual(lc.catalog_entries(lc.Page(self.page).lines)[2], [])

    def test_first_cell_lands_on_an_empty_map_and_removing_it_restores_the_bytes(self):
        self.use_empty_page()
        proc = self.add(self.cell(), {'removalPackages': 'selftest-pkg', 'manualRelaunch': True})
        self.assertDone(proc)
        self.assertEqual(self.written_facts()['ids'], ['selftest'])
        self.assertEqual(self.written_facts()['meta'].get('checked'), lc.today(), 'the one launcher was found, so the date is set')
        self.assertDone(self.cli('remove', 'selftest', '--page', str(self.page)))
        self.assertUnchanged()

    def test_every_table_takes_its_first_entry_on_an_empty_map(self):
        self.use_empty_page()
        steps = [
            (self.cell(id='selfdep', name='Self Dependency', command='~/apps/selftest-shared'), {}, ('--check-command', 'test -e /', '--ready', 'it is there')),
            (self.cell(id='selfpkg', name='Self Package'), {'removalPackages': 'selftest-pkg', 'manualRelaunch': True}, ('--connection', 'selfdep')),
            (self.cell(id='selfimage', name='Self Image', command='~/' + APPIMAGE), {'removalAppImages': '~/' + APPIMAGE}, ()),
            (self.cell(id='selfpipx', name='Self Pipx', command='~/.local/bin/selfpipx'), {'removalPipx': 'selftest-pipx'}, ()),
            (self.cell(id='selfcompose', name='Self Compose', view='services', group=next(iter(self.views['services']['groups'])),
                       command='cd ~/Projects/selfcompose; and docker compose up -d'), {'actionComposeDirs': 'Projects/selfcompose'}, ()),
            (self.cell(id='selfwhy', name='Self Reason', command='bash ~/start-selfhelper.sh'), {'removalReason': 'A self-test keeps this.'}, ('--optional-connection', 'selfpkg')),
        ]
        for cell, core, flags in steps:
            with self.subTest(cell['id']):
                self.assertDone(self.add(cell, core, *flags))
        facts = self.written_facts()
        self.assertEqual((sorted(facts['ids']), facts['removalPipx'], facts['actionComposeDirs']),
                         (sorted(c['id'] for c, _, _ in steps), {'selfpipx': 'selftest-pipx'}, {'selfcompose': 'Projects/selfcompose'}))
        for cell, _, _ in reversed(steps):
            self.assertDone(self.cli('remove', cell['id'], '--page', str(self.page)))
        self.assertUnchanged()

    def test_add_many_fills_an_empty_map_and_a_failure_leaves_it_empty(self):
        self.use_empty_page()
        first, second = self.tmp / 'first.json', self.tmp / 'second.json'
        first.write_text(json.dumps({'cell': self.cell(), 'core': {}}))
        second.write_text(json.dumps({'cell': self.cell(id='selftestfail', name='Fails Later', view='ai', group=next(iter(self.views['ai']['groups'])),
                                                        command='~/apps/selftest-shared'), 'core': {}}))
        dry = self.cli('add-many', str(first), str(second), '--page', str(self.page), '--dry-run')
        self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
        self.assertUnchanged()
        (self.site / 'tests/guard.test.cjs').write_text(GUARD_TEST)
        proc = self.cli('add-many', str(first), str(second), '--page', str(self.page))
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        self.assertUnchanged()
        (self.site / 'tests/guard.test.cjs').unlink()
        self.assertDone(self.cli('add-many', str(first), str(second), '--page', str(self.page)))
        self.assertEqual(sorted(self.written_facts()['ids']), ['selftest', 'selftestfail'])
        for ident in ('selftest', 'selftestfail'):
            self.assertDone(self.cli('remove', ident, '--page', str(self.page)))
        self.assertUnchanged()

    def test_discover_scan_and_check_work_on_an_empty_map(self):
        self.use_empty_page()
        proc = self.cli('check', '--page', str(self.page))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('all 0 present', proc.stdout)
        hook = subprocess.run([sys.executable, '-I', str(HERE / 'session_check.py')], env={**self.env, 'LAUNCHPAD_PAGE': str(self.page)},
                              capture_output=True, text=True, timeout=60)
        self.assertEqual((hook.returncode, hook.stdout), (0, ''), 'the session check stays silent on an empty map')
        found = subprocess.run([sys.executable, '-I', str(HERE / 'discover.py'), 'selfcompose', '--page', str(self.page)], env=self.env,
                               capture_output=True, text=True, timeout=120)
        self.assertEqual(found.returncode, 0, found.stderr)
        self.assertEqual(json.loads(found.stdout)['core']['connections'], [], 'with no engine cell a Compose cell has no prerequisite')
        listing = self.tmp / 'scan.json'
        proc = self.scan(str(self.home / 'apps'), '--out', str(listing))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(listing.read_text())['onMap'], [])
        self.assertUnchanged()

    @unittest.skipUnless((REAL_TOOLS / 'playwright').is_dir(), 'needs Playwright for the click check')
    def test_the_click_check_passes_for_the_first_cell_and_when_the_last_one_goes(self):
        self.use_empty_page()
        self.env.update(LAUNCHPAD_TEST_TOOLS=str(REAL_TOOLS), PLAYWRIGHT_BROWSERS_PATH=str(Path.home() / '.cache/ms-playwright'))
        added = self.add(self.cell())
        self.assertDone(added)
        self.assertIn('PASS clicking the node copies exactly its command', added.stdout)
        removed = self.cli('remove', 'selftest', '--page', str(self.page))
        self.assertDone(removed)
        self.assertIn('PASS the last cell left and the first-run screen is back', removed.stdout)
        self.assertUnchanged()

    def test_compose_cells_wait_for_whichever_cell_answers_docker_info(self):
        found = subprocess.run([sys.executable, '-I', str(HERE / 'discover.py'), 'selfcompose', '--page', str(self.page)], env=self.env,
                               capture_output=True, text=True, timeout=120)
        self.assertEqual(found.returncode, 0, found.stderr)
        self.assertEqual(json.loads(found.stdout)['core']['connections'], [{'from': 'engine', 'to': 'selfcompose'}])

    def test_remove_drops_a_relaunch_reason(self):
        self.assertIn('reader', self.facts['relaunchReasons'])
        self.assertDone(self.cli('remove', 'orbit7', '--page', str(self.page)))
        facts = self.written_facts()
        self.assertNotIn('orbit7', facts['relaunchReasons'])
        self.assertIn('reader', facts['relaunchReasons'])

    # ------------------------------------------------------------ refusals leave every byte alone
    def test_refusal_matrix(self):
        first = self.facts['ids'][0]
        cases = [
            ('missing script', self.cell(command='bash ~/no-such-script.sh'), {}, (), 'does not exist'),
            ('missing binary', self.cell(command='/usr/bin/no-such-binary-xyz'), {}, (), 'does not exist'),
            ('bare command not on PATH', self.cell(command='no-such-command-xyz'), {}, (), 'not on PATH'),
            ('duplicate id', self.cell(id=first), {}, (), 'already exists'),
            ('duplicate name', self.cell(name=self.page_cell(first)['name']), {}, (), 'already used'),
            ('duplicate command', self.cell(command=self.page_cell(first)['command'], id='selfdup'), {}, (), 'exactly this command'),
            ('unknown group', self.cell(group='nowhere'), {}, (), '--new-group'),
            ('unknown workspace', self.cell(view='nowhere'), {}, (), 'unknown workspace'),
            ('unknown icon (validateCatalog)', self.cell(icon='unicorn'), {}, (), 'unknown icon'),
            ('unknown tone (validateCatalog)', self.cell(tone='loud'), {}, (), 'unknown tone'),
            ('bad port (validateCatalog)', self.cell(port='80a'), {}, (), 'port must look like'),
            ('unknown field', self.cell(colour='red'), {}, (), 'unknown field'),
            ('command substitution', self.cell(command='~/apps/selftest-app $(id)'), {}, (), 'arguments contain'),
            ('pipe', self.cell(command='~/apps/selftest-app | cat'), {}, (), 'arguments contain'),
            ('line break', self.cell(command='~/apps/selftest-app\nid'), {}, (), 'line break'),
            ('script tag in note', self.cell(note='Fine </script><script>alert(1)'), {}, (), '< or >'),
            ('status without warning', self.cell(status='setup'), {}, (), 'status and warning'),
            ('bad id', self.cell(id='Bad Id'), {}, (), 'id must look like'),
            ('package not proven', self.cell(), {'removalPackages': 'coreutils'}, (), 'not proven'),
            ('package with dependents', self.cell(command='~/apps/selftest-shared'), {'removalPackages': 'selftest-lib'}, (), 'required by'),
            ('package of an interpreter', self.cell(command='bash ~/start-selfhelper.sh'), {'removalPackages': 'bash'}, (), 'launcher binary'),
            ('compose dir without docker-compose.yml', self.cell(command='cd ~/Projects/nocompose; and docker compose up -d'),
             {'actionComposeDirs': 'Projects/nocompose'}, (), 'docker-compose.yml does not exist'),
            ('compose dir unrelated to the command', self.cell(), {'actionComposeDirs': 'Projects/selfcompose'}, (), 'not the folder'),
            ('required edge without readiness check', self.cell(), {'connections': [{'from': self.no_policy_id(), 'to': 'selftest'}]}, (), 'readiness'),
            ('edge to an unknown cell', self.cell(), {'connections': [{'from': 'ghost', 'to': 'selftest', 'optional': True}]}, (), 'unknown cell'),
            ('re-launch for a script that kills', self.cell(command='bash ~/serve-selftest.sh'), {'manualRelaunch': True}, (), 'pkill'),
            ('old probe flag', self.cell(), {}, ('--probe', 'true'), '--check-command'),
            ('old probe tools flag', self.cell(), {}, ('--probe-tools', 'curl'), '--check-http'),
            ('check that does not parse', self.cell(), {}, ('--check-command', 'true )', '--ready', 'x'), 'bash -n'),
            ('check tool missing', self.cell(), {}, ('--check-command', 'no-such-tool-xyz --x', '--ready', 'x'), 'not on PATH'),
            ('check timeout out of range', self.cell(), {}, ('--check-command', 'true', '--ready', 'x', '--timeout', '601'), '0..600'),
            ('check seconds out of range', self.cell(), {}, ('--check-command', 'true', '--ready', 'x', '--check-seconds', '61'), 'seconds must be 1 to 60'),
            ('non-loopback url', self.cell(), {}, ('--check-http', 'https://example.com/', '--ready', 'x'), 'loopback'),
            ('bad port', self.cell(), {}, ('--check-tcp', '70000', '--ready', 'x'), 'port must be 1 to 65535'),
            ('non-loopback tcp host', self.cell(), {}, ('--check-tcp', '80', '--check-host', '10.0.0.5', '--ready', 'x'), 'host must be loopback'),
            ('multi-line check command', self.cell(), {}, ('--check-command', 'true\nid', '--ready', 'x'), 'one line'),
            ('script tag in a check', self.cell(), {}, ('--check-http', 'http://127.0.0.1/</script>', '--ready', 'x'), '"<"'),
            ('check without ready', self.cell(), {}, ('--check-command', 'true'), '--ready WORDS is required'),
            ('ready without a check', self.cell(), {}, ('--ready', 'x'), 'without a readiness check'),
            ('two checks', self.cell(), {}, ('--check-command', 'true', '--check-tcp', '80', '--ready', 'x'), 'one readiness check'),
            ('expect without http', self.cell(), {}, ('--check-tcp', '80', '--check-expect', 'x', '--ready', 'x'), 'only goes with --check-http'),
            ('required edge flag without readiness check', self.cell(), {}, ('--connection', self.no_policy_id()), 'readiness'),
            ('started edge without readiness check', self.cell(), {}, ('--connection', self.no_policy_id() + ':started'), 'readiness'),
            ('unknown condition', self.cell(), {}, ('--connection', first + ':whenever'), 'condition'),
            ('empty condition', self.cell(), {}, ('--connection', first + ':'), 'condition'),
            ('optional edge with a condition', self.cell(), {'connections': [{'from': first, 'to': 'selftest', 'optional': True, 'condition': 'completed'}]},
             (), 'takes no condition'),
            ('edge given twice', self.cell(), {}, ('--optional-connection', first, '--optional-connection', first), 'given twice'),
            ('new cell as prerequisite without a check', self.cell(), {'connections': [{'from': 'selftest', 'to': first}]}, (), 'needs a readiness check'),
            ('AppImage missing', self.cell(command='~/' + APPIMAGE), {}, ('--removal-appimage', '~/Applications/Missing.AppImage'), 'does not exist'),
            ('AppImage is a link', self.cell(command='~/Applications/Linked.AppImage'), {}, ('--removal-appimage', 'Applications/Linked.AppImage'),
             'not a regular file'),
            ('AppImage the command does not run', self.cell(), {}, ('--removal-appimage', APPIMAGE), 'does not run'),
            ('AppImage outside home', self.cell(), {}, ('--removal-appimage', '/usr/bin/x.AppImage'), 'not under your home'),
            ('AppImage path with ..', self.cell(command='~/' + APPIMAGE), {}, ('--removal-appimage', 'Applications/../' + APPIMAGE), 'plain path'),
            ('pipx package not listed', self.cell(command='~/.local/bin/selfunlisted'), {}, ('--removal-pipx', 'unlisted-pkg'), 'pipx list --short lists'),
            ('pipx command outside the venv', self.cell(), {}, ('--removal-pipx', 'selftest-pipx'), 'does not run from that pipx venv'),
            ('pipx venv of another package', self.cell(command='~/.local/bin/selfpipx'), {}, ('--removal-pipx', 'other-pkg'), 'does not run from'),
            ('pipx for a script command', self.cell(command='bash ~/start-selfhelper.sh'), {}, ('--removal-pipx', 'selftest-pipx'), 'launcher binary'),
            ('two removal sources', self.cell(), {'removalPackages': 'selftest-pkg'}, ('--removal-pipx', 'selftest-pipx'), 'one removal source'),
            ('flag conflicts with the proposal', self.cell(command='~/.local/bin/selfpipx'), {'removalPipx': 'other-pkg'},
             ('--removal-pipx', 'selftest-pipx'), 'conflicts'),
        ]
        for label, cell, core, extra, expected in cases:
            with self.subTest(label):
                proc = self.add(cell, core, *extra)
                self.assertEqual(proc.returncode, 2, label + ': ' + proc.stdout + proc.stderr)
                self.assertIn(expected, proc.stderr, label)
                self.assertUnchanged()
        for label, args, expected in [('remove unknown id', ('remove', 'ghost'), 'no cell'),
                                      ('update unknown id', ('update', 'ghost', '--set', 'note=x'), 'no cell'),
                                      ('update to a missing command', ('update', first, '--set', 'command=/usr/bin/no-such-binary-xyz'), 'does not exist')]:
            with self.subTest(label):
                proc = self.cli(*args, '--page', str(self.page))
                self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
                self.assertIn(expected, proc.stderr)
                self.assertUnchanged()

    def test_page_level_refusals(self):
        for label, data, expected in [('BOM', b'\xef\xbb\xbf' + self.original, 'BOM'),
                                      ('mixed line endings', self.original.replace(b'\n', b'\r\n', 3), 'mixes line endings')]:
            with self.subTest(label):
                self.page.write_bytes(data)
                proc = self.add(self.cell())
                self.assertEqual(proc.returncode, 2)
                self.assertIn(expected, proc.stderr)
                self.assertEqual(self.page.read_bytes(), data)
        text = self.original.decode('utf-8')
        pipx_line = next(line for line in text.splitlines() if line.startswith('const removalPipx = {'))
        a, b = self.facts['ids'][:2]
        for label, old, new in [('removalAppImages with a space', 'const removalAppImages = {', 'const removalAppImages = { '),
                                ('removalPipx in double quotes', pipx_line, pipx_line.replace("'", '"') if "'" in pipx_line else pipx_line[:-2] + ' };'),
                                ('connection in double quotes', 'const connections = [',
                                 'const connections = [{from:"%s",to:"%s",condition:"completed"},' % (a, b))]:
            with self.subTest(label):
                self.assertEqual(text.count(old), 1, label)
                data = text.replace(old, new).encode('utf-8')
                self.page.write_bytes(data)
                proc = self.add(self.cell())
                self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
                self.assertIn('layout the helper does not recognise', proc.stderr)
                self.assertEqual(self.page.read_bytes(), data)
        self.page.write_bytes(self.original)
        (self.site / 'tests/catalog.test.cjs').unlink()
        self.assertEqual(self.add(self.cell(), {}, '--dry-run').returncode, 0)
        proc = self.add(self.cell())
        self.assertEqual(proc.returncode, 2)
        self.assertIn('tests/catalog.test.cjs', proc.stderr)
        self.assertUnchanged()

    def page_cell(self, ident: str) -> dict:
        _, _, entries = lc.catalog_entries(lc.Page(self.page).lines)
        return next(e['obj'] for e in entries if e['obj']['id'] == ident)

    def no_policy_id(self) -> str:
        return next(i for i in self.facts['ids'] if i not in self.facts['dependencyStartup'])

    # ------------------------------------------------------------ discovery
    def test_discovery_parsers(self):
        compose = self.home / 'Projects/selfcompose/docker-compose.yml'
        self.assertEqual(discover.compose_ports(compose), (['8000', '8502', '5055'], True))
        facts = discover.script_facts(self.home / 'serve-selftest.sh')
        self.assertEqual(facts['ports'], ['8765'])
        self.assertTrue(facts['kills'])
        command, _ = discover.exec_to_command('env DESKTOPINTEGRATION=false sh --no-sandbox %U')
        self.assertEqual(command, 'env DESKTOPINTEGRATION=false %s --no-sandbox' % shutil.which('sh'))
        self.assertEqual(discover.exec_to_command('/usr/bin/x -- %u')[0], '/usr/bin/x')
        self.assertEqual(lc.classify_command(command)['launcher'], shutil.which('sh'))

    def test_discover_end_to_end_in_a_fake_home(self):
        run = lambda q: subprocess.run([sys.executable, '-I', str(HERE / 'discover.py'), q, '--page', str(self.page)],  # noqa: E731
                                       env=self.env, capture_output=True, text=True, timeout=120)
        proc = run('selfcompose')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        proposal = json.loads(proc.stdout)
        self.assertEqual(proposal['kind'], 'compose')
        self.assertEqual(proposal['cell']['command'], 'cd ~/Projects/selfcompose; and docker compose up -d')
        self.assertEqual(proposal['cell']['port'], '8000 · 8502 · 5055')
        self.assertEqual(proposal['core']['actionComposeDirs'], 'Projects/selfcompose')
        proc = run('selftest')
        proposal = json.loads(proc.stdout)
        self.assertEqual((proposal['kind'], proposal['cell']['status'], proposal['core']['manualRelaunch']), ('model-server', 'caution', False))
        self.assertEqual(run('no-such-app-xyz').returncode, 2)
        self.assertUnchanged()

    def test_discover_proposes_appimage_and_pipx_tables(self):
        run = lambda q: subprocess.run([sys.executable, '-I', str(HERE / 'discover.py'), q, '--page', str(self.page)],  # noqa: E731
                                       env=self.env, capture_output=True, text=True, timeout=120)
        proc = run('selfimage')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        proposal = json.loads(proc.stdout)
        self.assertEqual(proposal['cell']['command'], '~/' + APPIMAGE)
        self.assertEqual((proposal['core']['removalAppImages'], proposal['core']['removalReason']), (APPIMAGE, None))
        self.assertIn('regular file', proposal['evidence']['removalAppImages'][0])
        proc = run('selfpipx')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        proposal = json.loads(proc.stdout)
        self.assertEqual(proposal['cell']['command'], '~/.local/bin/selfpipx')
        self.assertEqual((proposal['core']['removalPipx'], proposal['core']['removalReason']), ('selftest-pipx', None))
        self.assertIn('pipx list --short -> selftest-pipx 0.1.0', proposal['evidence']['removalPipx'])
        self.assertEqual(json.loads(run('selfunlisted').stdout)['core']['removalPipx'], None)
        path = self.tmp / 'selfpipx.json'
        path.write_text(json.dumps(proposal))
        self.assertDone(self.cli('add', str(path), '--page', str(self.page)))
        self.assertEqual(self.written_facts()['removalPipx']['selfpipx'], 'selftest-pipx')
        self.assertDone(self.cli('remove', 'selfpipx', '--page', str(self.page)))
        self.assertUnchanged()

    def test_check_reports_layouts_readiness_and_removal_tables(self):
        proc = self.cli('check', '--page', str(self.page))
        self.assertIn(proc.returncode, (0, 1), proc.stderr)
        self.assertIn('the 9 core tables parse', proc.stdout)
        for ident in self.facts['readiness']:
            self.assertRegex(proc.stdout, r'(ok: dependencyStartup %s \(|FINDING: dependencyStartup %s:)' % (ident, ident))
        for ident in list(self.facts['removalAppImages']) + list(self.facts['removalPipx']):
            self.assertRegex(proc.stdout, r'(ok|FINDING|note): removal(AppImages|Pipx) %s' % ident)
        self.assertUnchanged()

    # ------------------------------------------------------------ folder search
    def scan(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, '-I', str(HERE / 'scan_folder.py'), *args, '--page', str(self.page)],
                              env=self.env, capture_output=True, text=True, timeout=300)

    def apps_folder(self) -> Path:
        """Apps, decoys and a planted .env in the fake home. Anything that runs touches ~/ran."""
        root = self.home / 'Apps'
        first = lc.catalog_entries(lc.Page(self.page).lines)[2][0]['obj']['id']
        for folder in ('proj', 'web', 'web2', 'bin', 'model', 'node_modules/pkg', '.hidden', 'with space', 'envapp/bin', 'Zed',
                       'railsapp/bin', 'ci', 'scripts', first):
            (root / folder).mkdir(parents=True)
        ran = '#!/bin/bash\ntouch "$HOME/ran"\n'
        self.exe(root / 'Cursor-1.2.3-x86_64.AppImage', ran)
        (root / 'notes.desktop').write_text('[Desktop Entry]\nType=Application\nName=Notes App\nExec=%s %%U\nCategories=Office;\n'
                                            % (self.home / 'apps/selftest-shared'))
        (root / 'quiet.desktop').write_text('[Desktop Entry]\nType=Application\nName=Quiet\nNoDisplay=true\nExec=/bin/true\n')
        (root / 'proj/docker-compose.yml').write_text('services:\n  web:\n    image: x\n    ports:\n      - "${SECRET_PORT}:80"\n      - "127.0.0.1:9321:80"\n')
        (root / 'proj/.env').write_text('SECRET_PORT=7777\n')
        self.exe(root / 'web/start-web.sh', ran + 'python3 -m http.server --port 9123\n')
        self.exe(root / 'model/serve-tiny.sh', ran + 'llama-server --port 9124\n')
        self.exe(root / 'web2/run.sh', ran)
        self.exe(root / 'bin/mytool', ran)
        self.exe(root / first / first, ran)
        (root / 'railsapp/Gemfile').write_text('source "https://rubygems.org"\n')
        self.exe(root / 'railsapp/bin/rake', ran)
        self.exe(root / 'ci/run.sh', ran)
        self.exe(root / 'scripts/run-e2e.sh', ran)
        self.exe(root / 'scripts/run-serial-tests.sh', ran)
        (root / 'startclip.desktop').write_text('[Desktop Entry]\nType=Application\nName=Startclip\nExec=xdg-open "/x y/index.html"\nX-Launchpad-Setup=1\n')
        (root / 'Zed/zed').write_bytes(b'\x7fELF\x02\x01\x01' + bytes(32))
        (root / 'Zed/zed').chmod(0o755)
        (root / 'Zed/libzed.so').write_bytes(b'\x7fELF\x02\x01\x01' + bytes(32))
        (root / 'Zed/libzed.so').chmod(0o755)
        self.exe(root / 'install.sh', ran)
        self.exe(root / 'stop-web.sh', ran)
        self.exe(root / 'node_modules/pkg/start.sh', ran)
        self.exe(root / '.hidden/start.sh', ran)
        self.exe(root / 'with space/start.sh', ran)
        (root / 'envapp/pyvenv.cfg').write_text('home = /usr/bin\n')
        self.exe(root / 'envapp/bin/python', ran)
        return root

    def test_scan_lists_apps_leaves_out_decoys_runs_nothing_and_opens_no_env_file(self):
        root, listing = self.apps_folder(), self.tmp / 'scan.json'
        proc = self.scan(str(root), '--out', str(listing))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        data = json.loads(listing.read_text())
        found = {item['name']: item for item in data['candidates']}
        first = lc.catalog_entries(lc.Page(self.page).lines)[2][0]['obj']['id']
        twin = discover.pretty_name(first)
        self.assertEqual(sorted(found), sorted(['Cursor', 'Mytool', 'Notes App', 'Proj', 'Tiny', 'Web', 'Web2', 'Zed', twin]))
        self.assertEqual([item['n'] for item in data['candidates']], list(range(1, 10)))
        self.assertEqual(found[twin]['sameName'], first, 'a name the map already uses is flagged')
        self.assertEqual(found['Web2']['command'], 'bash ~/Apps/web2/run.sh')
        self.assertNotIn('Startclip', str(data['leftOut']), "the page's own shortcut is not an app to add")
        self.assertEqual(found['Cursor']['command'], '~/Apps/Cursor-1.2.3-x86_64.AppImage')
        self.assertEqual(found['Proj']['command'], 'cd ~/Apps/proj; and docker compose up -d')
        self.assertEqual(found['Proj']['ports'], ['9321'], 'a port only .env defines stays unread')
        self.assertEqual((found['Web']['kind'], found['Web']['ports']), ('web', ['9123']))
        self.assertEqual(found['Web']['command'], 'bash ~/Apps/web/start-web.sh')
        self.assertEqual(found['Tiny']['kind'], 'model-server')
        self.assertEqual(found['Notes App']['group'], 'daily')
        self.assertTrue(any('with space' in item['path'] for item in data['leftOut']), data['leftOut'])
        for item in data['candidates']:
            self.assertIn('%d. %s' % (item['n'], item['name']), proc.stdout)
        self.assertFalse((self.home / 'ran').exists(), 'nothing found is ever run')
        self.assertUnchanged()

    def test_scan_names_what_is_on_the_map_and_says_when_nothing_is_new(self):
        self.assertDone(self.add(self.cell()))
        (self.home / 'apps/compose.yaml').write_text('services: {}\n')
        listing = self.tmp / 'scan.json'
        proc = self.scan(str(self.home / 'apps'), '--out', str(listing))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        data = json.loads(listing.read_text())
        self.assertEqual([item['command'] for item in data['candidates']], ['~/apps/selftest-shared'])
        self.assertEqual([item['id'] for item in data['onMap']], ['selftest'])
        (self.home / 'apps/selftest-shared').unlink()
        proc = self.scan(str(self.home / 'apps'), '--out', str(listing))
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        self.assertIn('already on the map', proc.stdout)

    def test_scan_refuses_a_missing_folder_and_a_bad_pick(self):
        listing = self.tmp / 'scan.json'
        self.assertEqual(self.scan(str(self.home / 'nowhere'), '--out', str(listing)).returncode, 2)
        self.assertEqual(self.scan(str(self.apps_folder()), '--out', str(listing)).returncode, 0)
        for pick in ('99', 'one', '1,1'):
            proc = self.scan('--from', str(listing), '--pick', pick, '--out-dir', str(self.tmp / 'picks'))
            self.assertEqual(proc.returncode, 2, pick + proc.stdout + proc.stderr)
        self.assertFalse((self.tmp / 'picks').exists() and any((self.tmp / 'picks').iterdir()))
        self.assertUnchanged()

    def test_picked_apps_go_through_discover_and_land_together(self):
        root, listing, picks = self.apps_folder(), self.tmp / 'scan.json', self.tmp / 'picks'
        self.assertEqual(self.scan(str(root), '--out', str(listing)).returncode, 0)
        number = {item['name']: item['n'] for item in json.loads(listing.read_text())['candidates']}
        proc = self.scan('--from', str(listing), '--pick', '%d,%d' % (number['Cursor'], number['Web']), '--out-dir', str(picks))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        files = sorted(str(path) for path in picks.glob('*.json'))
        proposals = [json.loads(Path(path).read_text()) for path in files]
        self.assertEqual(sorted(p['cell']['view'] for p in proposals), ['desktop', 'services'])
        web = next(p for p in proposals if p['cell']['view'] == 'services')
        self.assertEqual((web['kind'], web['cell']['port'], web['cell']['tone']), ('web', '9123', 'web'))
        image = next(p for p in proposals if p['cell']['view'] == 'desktop')
        self.assertEqual(image['core']['removalAppImages'], 'Apps/Cursor-1.2.3-x86_64.AppImage')
        dry = self.cli('add-many', *files, '--page', str(self.page), '--dry-run')
        self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
        self.assertUnchanged()
        done = self.cli('add-many', *files, '--page', str(self.page))
        self.assertDone(done)
        self.assertEqual(done.stdout.count('baseline: running node --test'), 1, 'one test run for the whole batch')
        written = self.written_facts()['ids']
        for proposal in proposals:
            self.assertIn(proposal['cell']['id'], written)
            self.assertDone(self.cli('remove', proposal['cell']['id'], '--page', str(self.page)))
        self.assertUnchanged()
        self.assertFalse((self.home / 'ran').exists(), 'nothing found is ever run')

    def test_add_many_is_all_or_nothing(self):
        (self.site / 'tests/guard.test.cjs').write_text(GUARD_TEST)
        first, second, twin = self.tmp / 'first.json', self.tmp / 'second.json', self.tmp / 'twin.json'
        first.write_text(json.dumps({'cell': self.cell(), 'core': {}}))
        second.write_text(json.dumps({'cell': self.cell(id='selftestfail', name='Fails Later', command='~/apps/selftest-shared'), 'core': {}}))
        twin.write_text(json.dumps({'cell': self.cell(name='Twin', command='~/apps/selftest-shared'), 'core': {}}))
        proc = self.cli('add-many', str(first), str(second), '--page', str(self.page))
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        self.assertIn('ROLLED BACK', proc.stdout)
        self.assertUnchanged()
        proc = self.cli('add-many', str(first), str(twin), '--page', str(self.page))
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('already exists', proc.stderr)
        self.assertUnchanged()


    def test_update_links_two_cells_already_on_the_map(self):
        """"make B wait for A" when both are on the map: the same proofs as add, and remove undoes it byte for byte."""
        self.assertDone(self.add(self.cell(id='selflinka', name='Self Link A', command='~/apps/selftest-app')))
        only_a = self.page.read_bytes()
        self.assertDone(self.add(self.cell(id='selflinkb', name='Self Link B', command='~/apps/selftest-shared')))
        before = self.page.read_bytes()
        refusals = ((['--connection', 'selflinka'], 'readiness check'), (['--connection', 'nobody'], 'unknown cell'),
                    (['--connection', 'selflinkb:completed'], 'wait for itself'))
        for flags, why in refusals:
            proc = self.cli('update', 'selflinkb', *flags, '--page', str(self.page))
            self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
            self.assertIn(why, proc.stderr)
        self.assertEqual(self.page.read_bytes(), before, 'a refused link writes nothing')
        self.assertDone(self.cli('update', 'selflinkb', '--connection', 'selflinka:completed', '--page', str(self.page)))
        edges = [edge for edge in self.written_facts()['connections'] if 'selflinkb' in (edge['from'], edge['to'])]
        self.assertEqual(edges, [{'from': 'selflinka', 'to': 'selflinkb', 'condition': 'completed'}])
        proc = self.cli('update', 'selflinkb', '--optional-connection', 'selflinka', '--page', str(self.page))
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('already on the map', proc.stderr)
        self.assertDone(self.cli('remove', 'selflinkb', '--page', str(self.page)))
        self.assertEqual(self.page.read_bytes(), only_a, 'removing the waiting cell takes its link with it, byte for byte')
        self.assertDone(self.cli('remove', 'selflinka', '--page', str(self.page)))
        self.assertUnchanged()

if __name__ == '__main__':
    unittest.main()
