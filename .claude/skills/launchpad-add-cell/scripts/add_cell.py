#!/usr/bin/env python3
"""The only writer for Startclip's index.html: add, update or remove one cell, or check the page.

  add PROPOSAL.json [--new-group KEY=Label] [--connection FROM[:healthy|started|completed]] [--optional-connection FROM]
                    [--removal-appimage PATH | --removal-pipx PKG]
                    [--check-command CMD | --check-http URL [--check-expect REGEX] | --check-tcp PORT [--check-host HOST]
                     --check-seconds N --ready WORDS --timeout N]
  add-many PROPOSAL.json ...  the cells picked from a folder search as one write: all of them land, or none do
  update ID --set FIELD=VALUE ... [--unset FIELD ...] [--new-group KEY=Label]
            [--connection FROM[:healthy|started|completed]] [--optional-connection FROM]   (links into ID only)
  remove ID [--drop-empty-group]
  check                      read-only: schema, script syntax, file presence, package, compose, AppImage, pipx and
                             readiness proofs

Write subcommands take --dry-run (print the verified:/edits: report and a unified diff, write nothing).
Without --dry-run the edit is gated first (JSON re-parse, node --check on every script block, the page's
own validateCatalog, the add/remove inverse check), the test suite runs before and after an atomic write,
and smoke_check.cjs clicks the cell in headless Chromium. Any failure restores index.html byte for byte.
A page whose tests already fail is not written unless --allow-preexisting-failures (then only new failures count).
Exit: 0 done, 2 refused (nothing written), 3 written and rolled back (page byte-identical again),
4 rollback impossible (the page changed meanwhile; the backup path is printed).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

sys.dont_write_bytecode = True  # keep the skill folder free of __pycache__
sys.path.insert(0, str(Path(__file__).resolve().parent))
from launchpad_common import (BLOCK_TABLES, CONDITIONS, INTERPRETERS, KEY_ORDER, KILL_RE, NEW_ID_RE,  # noqa: E402
                              GROUP_KEY_RE, ONE_LINE_TABLES, REL_DIR_RE, Page, Refusal, block_table, catalog_entries,
                              catalog_line, classify_command, command_target_exists, dependency_line, edge_token,
                              edit_report, eprint, gate, js_single_quote, meta_line_index, node_facts, one_line_table,
                              pacman_info, pacman_owner, page_path, pipx_packages, prove_appimage, prove_pipx,
                              readiness_proof, run, sha256, today, unified, view_line, views_entries, write_atomic)

SMOKE = Path(__file__).resolve().parent / 'smoke_check.cjs'
TEXT_FIELDS = ('name', 'type', 'note', 'warning')
MAX_LEN = {'name': 40, 'type': 48, 'note': 300, 'warning': 300}
REMOVAL_TABLES = ('removalPackages', 'actionComposeDirs', 'removalAppImages', 'removalPipx')
ID_TOKEN_RE = re.compile(r'^[a-z0-9_-]+$')
OLD_PROBE_FLAGS = ('--probe', '--probe-tools', '--probe-timeout')
NEW_CHECK_FLAGS = ('--check-command CMD | --check-http URL [--check-expect REGEX] | --check-tcp PORT [--check-host HOST], '
                   'with --check-seconds N (default 3), --ready WORDS and --timeout N (default 120)')


# ---------------------------------------------------------------- field policy (enums stay in validateCatalog)
def field_problems(cell: dict, catalog: list[dict], own_id: str | None = None) -> list[str]:
    problems = []
    for key in cell:
        if key not in KEY_ORDER:
            problems.append('unknown field %r (the catalog has %s)' % (key, ', '.join(KEY_ORDER)))
    for key, value in cell.items():
        if not isinstance(value, str):
            problems.append('%s must be a string' % key)
        elif '<' in value or '>' in value:
            problems.append('%s contains < or >; a "</script>" would end the data block early, so use words' % key)
        elif re.search(r'[\x00-\x1f\x7f]', value):
            problems.append('%s contains a line break or control character' % key)
        elif value != value.strip() or not value:
            problems.append('%s is empty or has leading/trailing spaces' % key)
    for key, limit in MAX_LEN.items():
        if isinstance(cell.get(key), str) and len(cell[key]) > limit:
            problems.append('%s is longer than %d characters' % (key, limit))
    if problems:
        return problems
    if own_id is None and not NEW_ID_RE.match(cell.get('id', '')):
        problems.append('id must look like [a-z0-9][a-z0-9_-]{1,23} (it is also a confirmation token and a CSS selector)')
    others = [app for app in catalog if app['id'] != own_id]
    if own_id is None and any(app['id'] == cell.get('id') for app in catalog):
        problems.append('id %r already exists in the catalog' % cell.get('id'))
    clash = next((app['id'] for app in others if app['name'].casefold() == cell.get('name', '').casefold()), None)
    if clash:
        problems.append('name %r is already used by cell %r (node labels must stay unique)' % (cell['name'], clash))
    clash = next((app['id'] for app in others if app['command'] == cell.get('command')), None)
    if clash:
        problems.append('cell %r already copies exactly this command' % clash)
    if ('status' in cell) != ('warning' in cell):
        problems.append('status and warning go together: every flagged cell explains itself')
    problems += ['command: ' + e for e in classify_command(cell.get('command', ''))['errors']]
    return problems


def parse_kv(text: str, flag: str) -> tuple[str, str]:
    if '=' not in text:
        raise Refusal('%s expects KEY=VALUE' % flag)
    key, value = text.split('=', 1)
    return key.strip(), value


# ---------------------------------------------------------------- line edits (all by content, never by stored line numbers)
def catalog_insert(lines: list[str], line: str, view: str, group: str, views: dict) -> None:
    first, _, entries = catalog_entries(lines)
    same = [e for e in entries if e['obj'].get('view') == view and e['obj'].get('group') == group]
    order = list(views)

    def key(obj):
        groups = list(views.get(obj.get('view'), {}).get('groups', {}))
        return (order.index(obj['view']) if obj.get('view') in order else len(order),
                groups.index(obj['group']) if obj.get('group') in groups else len(groups))
    before = same or [e for e in entries if key(e['obj']) <= key({'view': view, 'group': group})]
    if not entries:
        lines.insert(first + 1, line)
    elif before and before[-1] is entries[-1]:
        lines[entries[-1]['index']] += ','
        lines.insert(entries[-1]['index'] + 1, line)
    else:
        lines.insert(before[-1]['index'] + 1 if before else entries[0]['index'], line + ',')


def catalog_delete(lines: list[str], ident: str) -> dict:
    _, _, entries = catalog_entries(lines)
    entry = next((e for e in entries if e['obj'].get('id') == ident), None)
    if entry is None:
        raise Refusal('no cell with id %r' % ident)
    del lines[entry['index']]
    if entry is entries[-1] and len(entries) > 1:
        prev = entries[-2]['index']
        lines[prev] = lines[prev][:-1]
    return entry['obj']


def one_line_append(lines: list[str], name: str, token: str) -> None:
    table = one_line_table(lines, name)
    lines[table['index']] = table['head'] + table['sep'].join(table['tokens'] + [token]) + table['tail']


def one_line_drop(lines: list[str], name: str, matches) -> list[str]:
    table = one_line_table(lines, name)
    keep = [t for t, k in zip(table['tokens'], table['keys']) if not matches(k)]
    dropped = [t for t, k in zip(table['tokens'], table['keys']) if matches(k)]
    if dropped:
        lines[table['index']] = table['head'] + table['sep'].join(keep) + table['tail']
    return dropped


def block_append(lines: list[str], name: str, new_line: str) -> None:
    table = block_table(lines, name)
    if table['entries']:
        lines[table['entries'][-1]['last']] += ','
    lines.insert(table['close'], new_line)


def block_drop(lines: list[str], name: str, ident: str) -> bool:
    table = block_table(lines, name)
    entries = table['entries']
    entry = next((e for e in entries if e['id'] == ident), None)
    if entry is None:
        return False
    if len(entry.get('tokens', [])) > 1:  # removalPackages line shared with other ids: drop only the token
        line = lines[entry['first']]
        kept = [t for t in entry['tokens'] if not t.startswith(ident + ":'")]
        lines[entry['first']] = '  ' + ', '.join(kept) + (',' if line.endswith(',') else '')
        return True
    last_line = entries[-1]['last']
    del lines[entry['first']:entry['last'] + 1]
    if entry['last'] == last_line:
        previous = [e['last'] for e in entries if e['last'] < entry['first']]
        if previous and lines[previous[-1]].endswith(','):
            lines[previous[-1]] = lines[previous[-1]][:-1]
    return True


def view_group(lines: list[str], view: str, key: str, label: str | None) -> None:
    """Add (label given) or drop (label None) a group on the workspace's line in the views block."""
    views, where = views_entries(lines)
    i = where[view]
    comma = lines[i].endswith(',')
    if view_line(view, views[view]) != (lines[i][:-1] if comma else lines[i]):
        raise Refusal('the %s line in the views block is not in canonical form; edit it by hand' % view)
    if label is None:
        del views[view]['groups'][key]
    else:
        views[view]['groups'][key] = label
    lines[i] = view_line(view, views[view]) + (',' if comma else '')


def refresh_checked(lines: list[str]) -> tuple[bool, list[str]]:
    """Set catalog-meta's checked date to today only if test -e passes for every command's launcher."""
    _, _, entries = catalog_entries(lines)
    missing = []
    for entry in entries:
        ok, where = command_target_exists(entry['obj'].get('command', ''))
        if not ok:
            missing.append('%s (%s)' % (entry['obj'].get('id'), where))
    i = meta_line_index(lines)
    meta = json.loads(lines[i])
    if json.dumps(meta, ensure_ascii=False, separators=(',', ':')) != lines[i]:
        raise Refusal('catalog-meta is not in canonical form; edit it by hand')
    if missing:
        return False, missing
    if entries:
        meta['checked'] = today()
    else:  # nothing left to vouch for; the page goes back to claiming no check
        meta.pop('checked', None)
    lines[i] = json.dumps(meta, ensure_ascii=False, separators=(',', ':'))
    return True, []


def remove_lines(lines: list[str], ident: str, drop_empty_group: bool, notes: list[str]) -> list[str]:
    """The exact inverse of add: drop the catalog line and every table token that names the id."""
    new = list(lines)
    cell = catalog_delete(new, ident)
    for token in one_line_drop(new, 'connections', lambda k: ident in k[:2]):
        notes.append('connections: dropped %s' % token)
    for name in ('actionComposeDirs', 'removalAppImages', 'removalPipx', 'manualRelaunchIds'):
        if one_line_drop(new, name, lambda k: k[0] == ident):
            notes.append('%s: dropped %s' % (name, ident))
    for name in BLOCK_TABLES:
        if block_drop(new, name, ident):
            notes.append('%s: dropped %s' % (name, ident))
    if drop_empty_group:
        views, _ = views_entries(new)
        _, _, rest = catalog_entries(new)
        view, group = cell.get('view'), cell.get('group')
        if any(e['obj'].get('view') == view and e['obj'].get('group') == group for e in rest):
            notes.append('group %s/%s still has cells; kept' % (view, group))
        elif views.get(view, {}).get('default') == group:
            raise Refusal('group %r is the default of %s; it cannot be dropped' % (group, view))
        elif group in views.get(view, {}).get('groups', {}):
            view_group(new, view, group, None)
            notes.append('views: dropped the now empty group %s/%s' % (view, group))
    return new


# ---------------------------------------------------------------- proofs for the core tables
def prove_package(cell: dict, pkg: str, desktop: str | None) -> str:
    shape = classify_command(cell['command'])
    if shape['shape'] not in ('path', 'bare'):
        raise Refusal('removalPackages needs a launcher binary; %r is a %s command' % (cell['command'], shape['shape']))
    launcher, head = shape['launcher'], Path(shape['launcher']).name
    if head in INTERPRETERS or re.search(r'[/~]', shape['args']):
        raise Refusal('removalPackages refused: %s runs something else, so its package is not this app' % head)
    owner = pacman_owner(launcher)
    if not owner or owner[0] != pkg:
        raise Refusal('removalPackages %r is not proven: pacman -Qo %s says %s' % (pkg, launcher, '%s %s' % owner if owner else 'no package'))
    info = pacman_info(pkg)
    if info is None:
        raise Refusal('removalPackages %r: pacman -Qi finds no installed package' % pkg)
    if info['Required By']:
        raise Refusal('removalPackages %r refused: required by %s, so pacman -R would fail' % (pkg, ', '.join(info['Required By'])))
    proof = 'pacman -Qo %s -> %s %s; pacman -Qi: Required By None' % (launcher, owner[0], owner[1])
    if desktop and desktop.endswith('.desktop') and Path(desktop).is_file():
        downer = pacman_owner(desktop)
        if downer and downer[0] != pkg:
            raise Refusal('removalPackages refused: %s belongs to %s, the launcher to %s' % (desktop, downer[0], pkg))
        if downer:
            proof += '; %s -> %s' % (desktop, downer[0])
    return proof


def prove_compose(cell: dict, rel: str, existing: dict) -> str:
    if not isinstance(rel, str) or not REL_DIR_RE.match(rel) or '..' in rel.split('/'):
        raise Refusal('actionComposeDirs %r must be a plain path relative to $HOME' % rel)
    target = Path.home() / rel
    if not (target / 'docker-compose.yml').is_file():
        raise Refusal('actionComposeDirs refused: ~/%s/docker-compose.yml does not exist (the page\'s Compose actions use that file)' % rel)
    owner = next((key for key, value in existing.items() if value == rel), None)
    if owner:
        raise Refusal('actionComposeDirs refused: ~/%s is already managed by cell %r' % (rel, owner))
    shape = classify_command(cell['command'])
    launcher = Path(shape.get('launcher') or '/nonexistent')
    related = (shape['shape'] == 'compose' and launcher == target) or \
              (shape['shape'] == 'script' and (target in launcher.parents or launcher.parent in target.parents))
    if not related:
        raise Refusal('actionComposeDirs ~/%s is not the folder the command %r starts' % (rel, cell['command']))
    return 'test -e ~/%s/docker-compose.yml' % rel


def build_policy(args) -> dict | None:
    """The dependencyStartup entry the --check-* flags describe, or None when no check flag is given."""
    kinds = [(flag, value) for flag, value in (('command', args.check_command), ('http', args.check_http), ('tcp', args.check_tcp))
             if value is not None]
    extras = [flag for flag, value in (('--check-expect', args.check_expect), ('--check-host', args.check_host),
                                       ('--check-seconds', args.check_seconds), ('--ready', args.ready), ('--timeout', args.timeout))
              if value is not None]
    if not kinds:
        if extras:
            raise Refusal('%s given without a readiness check; add one of %s' % (', '.join(extras), NEW_CHECK_FLAGS))
        return None
    if len(kinds) > 1:
        raise Refusal('give one readiness check, not %s' % ' and '.join('--check-' + kind for kind, _ in kinds))
    kind, value = kinds[0]
    if args.check_expect is not None and kind != 'http':
        raise Refusal('--check-expect only goes with --check-http')
    if args.check_host is not None and kind != 'tcp':
        raise Refusal('--check-host only goes with --check-tcp')
    if args.ready is None:
        raise Refusal('--ready WORDS is required with a check: it is the step text every waiting chain shows')
    check: dict = {'kind': kind}
    if kind == 'command':
        check['run'] = value
    elif kind == 'http':
        check['url'] = value
        if args.check_expect is not None:
            check['expect'] = args.check_expect
    else:
        check['port'] = value
        if args.check_host is not None:
            check['host'] = args.check_host
    check['seconds'] = 3 if args.check_seconds is None else args.check_seconds
    return {'check': check, 'ready': args.ready, 'timeout': 120 if args.timeout is None else args.timeout}


def prove_policy(text: str, policy: dict) -> dict:
    """Literal safety here, then the page's readinessCheck (must not throw), bash -n on the test, tools on PATH."""
    for key in ('run', 'url', 'expect', 'host'):
        value = policy['check'].get(key)
        if value is None:
            continue
        flag = {'run': '--check-command', 'url': '--check-http', 'expect': '--check-expect', 'host': '--check-host'}[key]
        if not value.strip() or re.search(r'[\x00-\x1f\x7f]', value):
            raise Refusal('%s must be one line without control characters' % flag)
        if '<' in value or len(value) > 300:
            raise Refusal('%s must be under 300 characters without "<" (a "</script>" would end the core script)' % flag)
    ready = policy['ready']
    if not ready.strip() or ready != ready.strip() or re.search(r'[<>\x00-\x1f\x7f]', ready) or len(ready) > 200:
        raise Refusal('--ready must be one short line of words without < or >')
    if not 0 <= policy['timeout'] <= 600:
        raise Refusal('--timeout must be 0..600 seconds (startupPlan rejects anything else)')
    result = node_facts(text, {'readiness': policy})['readiness']
    result['proof'] = readiness_proof(result, 'the readiness check')
    return result


# ---------------------------------------------------------------- verification after the write
def parse_tap(out: str) -> dict:
    stack, results = [], {}
    for line in out.splitlines():
        sub = re.match(r'^(\s*)# Subtest: (.*)$', line)
        if sub:
            indent = len(sub.group(1))
            while stack and stack[-1][0] >= indent:
                stack.pop()
            stack.append((indent, sub.group(2)))
            continue
        res = re.match(r'^(\s*)(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$', line)
        if res:
            indent = len(res.group(1))
            while stack and stack[-1][0] > indent:
                stack.pop()
            parents = [name for level, name in stack if level < indent]
            results[' > '.join(parents + [res.group(3)])] = res.group(4) or ('pass' if res.group(2) == 'ok' else 'fail')
            if stack and stack[-1][0] == indent:
                stack.pop()
    totals = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|skipped|todo|cancelled) (\d+)$', out, re.M)}
    return {'results': results, 'totals': totals}


def run_suite(page_dir: Path, tools: str | None) -> dict:
    env = dict(os.environ)
    if tools:
        env['LAUNCHPAD_TEST_TOOLS'] = tools
    with tempfile.TemporaryDirectory(prefix='launchpad-add-cell-shots-') as shots:
        env['LAUNCHPAD_SHOTS'] = shots
        code, out, err = run(['node', '--test', '--test-reporter=tap', 'tests/'], timeout=900, env=env, cwd=page_dir)
    suite = parse_tap(out)
    suite.update(code=code, stderr=err.strip()[-600:])
    return suite


def suite_summary(suite: dict) -> str:
    t = suite['totals']
    return 'node --test: %d tests, %d pass, %d fail, %d skipped, %d todo' % (
        t.get('tests', 0), t.get('pass', 0), t.get('fail', 0) + t.get('cancelled', 0), t.get('skipped', 0), t.get('todo', 0))


def regressions(before: dict, after: dict) -> list[str]:
    if not after['results']:
        return ['the test run produced no results (exit %d): %s' % (after['code'], after['stderr'])]
    failing = lambda s: {name for name, state in s['results'].items() if state == 'fail'}  # noqa: E731
    new = failing(after) - failing(before)
    problems = ['new failure: ' + name for name in sorted(new) if not any(other.startswith(name + ' > ') for other in new)]
    problems += ['test no longer runs: ' + name for name in sorted(set(before['results']) - set(after['results']))]
    if after['code'] != 0 and not failing(after):
        problems.append('node --test exited %d without a failing test: %s' % (after['code'], after['stderr']))
    return problems


def run_smoke(page: Path, ident: str, view: str, absent: bool, tools: str | None) -> tuple[str, list[str]]:
    env = dict(os.environ)
    if tools:
        env['LAUNCHPAD_TEST_TOOLS'] = tools
    argv = ['node', str(SMOKE), '--page', str(page), '--id', ident] + (['--absent', '--view', view] if absent else [])
    code, out, err = run(argv, timeout=240, env=env)
    lines = [line for line in (out + err).splitlines() if line.strip()]
    return {0: 'pass', 3: 'not verified'}.get(code, 'fail'), lines


def backup_dir() -> Path:
    return Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state') / 'launchpad-add-cell'


def commit(page: Page, new_lines: list[str], op: str, ident: str, view: str, verified: list[str],
           not_offered: list[str], args, batch: list[tuple[str, str]] | None = None) -> int:
    new_data = page.render(new_lines)
    old_lines = page.lines
    print('launchpad-add-cell %s %s%s' % (op, ident, ' (dry run)' if args.dry_run else ''))
    print('page: %s (%d -> %d bytes, %d -> %d lines, %s, %s)' % (
        page.path, len(page.raw), len(new_data), len(old_lines), len(new_lines),
        'CRLF' if page.eol == '\r\n' else 'LF', 'final newline kept' if page.trailing else 'no final newline'))
    print('verified:')
    for line in verified:
        print('  - ' + line)
    if not_offered:
        print('not offered / not verified:')
        for line in not_offered:
            print('  - ' + line)
    print('edits:')
    for line in edit_report(old_lines, new_lines) or ['  (none)']:
        print(line)
    print('diff:')
    print(unified(old_lines, new_lines, page.path.name))
    if new_data == page.raw:
        print('NO CHANGE: the page already says this.')
        return 0
    if args.dry_run:
        print('DRY RUN: nothing written. Run the same command without --dry-run to write, test and smoke-check.')
        return 0
    page_dir = page.path.parent
    if page.path.name != 'index.html' or not (page_dir / 'tests' / 'catalog.test.cjs').is_file():
        raise Refusal('writes need <dir>/index.html with <dir>/tests/catalog.test.cjs beside it (the tests load ../index.html)')
    default_tools = Path.home() / '.cache' / 'launchpad-test-tools' / 'node_modules'
    tools = args.tools or os.environ.get('LAUNCHPAD_TEST_TOOLS') or (str(default_tools) if default_tools.is_dir() else None)
    print('baseline: running node --test on the unchanged page...', flush=True)
    before = run_suite(page_dir, tools)
    if not before['results']:
        raise Refusal('the test suite does not run on the unchanged page (exit %d): %s' % (before['code'], before['stderr']))
    print('baseline ' + suite_summary(before))
    failing = [name for name, state in before['results'].items() if state == 'fail']
    preexisting = sorted(name for name in failing if not any(other.startswith(name + ' > ') for other in failing))
    if preexisting:
        print('baseline has %d failing test(s) before any edit:' % len(preexisting))
        for name in preexisting[:20]:
            print('  ! ' + name)
        if not args.allow_preexisting_failures:
            raise Refusal('the unchanged page already fails %d test(s); nothing written. Fix them first, or (only if the user '
                          'agrees) re-run with --allow-preexisting-failures so that only NEW failures roll back' % len(preexisting))
        print('--allow-preexisting-failures: these stay as they are; any new failure still rolls back.')
    if page.path.read_bytes() != page.raw:
        raise Refusal('index.html changed while the baseline ran; re-run the command')
    folder = backup_dir()
    folder.mkdir(parents=True, exist_ok=True)
    backup = folder / ('%s-%s-%s.index.html' % (time.strftime('%Y%m%dT%H%M%S'), op, ident))
    backup.write_bytes(page.raw)
    write_atomic(page.path, new_data)
    print('written: %s (sha256 %s); backup of the previous bytes: %s' % (page.path, sha256(new_data)[:12], backup))
    failures: list[str] = []
    try:
        after = run_suite(page_dir, tools)
        print('after    ' + suite_summary(after))
        failures = regressions(before, after)
        if not failures:
            for one, where in batch or [(ident, view)]:
                state, lines = run_smoke(page.path, one, where, op == 'remove', tools)
                for line in lines:
                    print('  smoke: ' + line)
                if state == 'fail':
                    failures.append('smoke check failed for %s' % one)
                elif state == 'not verified':
                    print('render not verified: Playwright was not found (set LAUNCHPAD_TEST_TOOLS or --tools); unit tests passed')
    except BaseException as error:  # interrupted or crashed: never leave an unverified page behind
        failures.append('verification aborted: %r' % error)
    if not failures:
        print('DONE: %s %s written and verified.' % (op, ident))
        return 0
    for line in failures:
        print('FAIL: ' + line)
    if page.path.read_bytes() != new_data:
        print('ROLLBACK IMPOSSIBLE: index.html changed during verification. Previous bytes: %s' % backup)
        return 4
    write_atomic(page.path, page.raw)
    restored = page.path.read_bytes() == page.raw
    print(('ROLLED BACK: index.html is byte-identical to before (sha256 %s).' % sha256(page.raw)[:12]) if restored
          else 'ROLLBACK FAILED: restore from %s' % backup)
    return 3 if restored else 4


# ---------------------------------------------------------------- subcommands
def load(args) -> tuple[Page, dict, list[dict]]:
    page = Page(page_path(args.page))
    facts = gate(page, page.lines)
    current = facts['problems'] + facts['canonical']
    if current:
        raise Refusal('the page already has catalog problems; fix them first:\n  - ' + '\n  - '.join(current))
    _, _, entries = catalog_entries(page.lines)
    return page, facts['facts'], [e['obj'] for e in entries]


def check_after(page: Page, lines: list[str], ident: str | None) -> dict:
    facts = gate(page, lines)
    problems = facts['problems'] + facts['canonical']
    if problems:
        raise Refusal('the edited page would fail validateCatalog:\n  - ' + '\n  - '.join(problems))
    if ident:
        facts['id'] = node_facts(page.render(lines).decode('utf-8'), {'id': ident})['id']
    return facts


def lifecycle_expectations(facts: dict, ident: str, cell: dict, verified: list[str], not_offered: list[str],
                           strict: bool = False) -> None:
    f, tables = facts['id'], facts['facts']
    blocked = cell.get('status') == 'blocked'
    if not blocked and not f['startup']['ok']:
        raise Refusal('the node could not copy its command: %s' % f['startup']['error'])
    want_relaunch = (ident in tables['manualRelaunchIds'] or ident in tables['actionComposeDirs']) and not blocked
    want_remove = any(ident in tables[name] for name in REMOVAL_TABLES)
    if strict and (f['relaunch']['offered'] != want_relaunch or f['remove']['offered'] != want_remove):
        raise Refusal('lifecyclePlan disagrees with the tables (relaunch %s, remove %s) for %r'
                      % (f['relaunch']['offered'], f['remove']['offered'], ident))
    chain = ' -> '.join(f['startup'].get('apps', [])) if f['startup']['ok'] else 'copy disabled (blocked)'
    verified.append('startupPlan: %s; validateCatalog: 0 problems; node --check: every script block; JSON blocks re-parsed' % chain)
    for kind in ('relaunch', 'remove'):
        (verified if f[kind]['offered'] else not_offered).append('%s script %s: %s' % (
            kind, 'offered' if f[kind]['offered'] else 'not offered', f[kind]['note']))


def proposal_edges(core: dict, args, ident: str) -> list[dict]:
    """Edges from the proposal plus --connection FROM[:condition] and --optional-connection FROM, normalised."""
    raw = list(core.get('connections') or [])
    for spec in args.connection or []:
        src, colon, condition = spec.partition(':')
        raw.append({'from': src, 'to': ident, **({'condition': condition} if colon else {})})
    raw += [{'from': src, 'to': ident, 'optional': True} for src in args.optional_connection or []]
    edges, seen = [], set()
    for edge in raw:
        if not isinstance(edge, dict) or set(edge) - {'from', 'to', 'optional', 'condition'}:
            raise Refusal('connections: an edge has only from, to and either optional or condition: %r' % (edge,))
        src, dst = edge.get('from'), edge.get('to')
        if not all(isinstance(x, str) and ID_TOKEN_RE.match(x) for x in (src, dst)):
            raise Refusal('connections: %r is not an edge between two ids' % (edge,))
        optional, condition = edge.get('optional') is True, edge.get('condition', 'healthy')
        if edge.get('optional') not in (None, True, False):
            raise Refusal('connections: optional must be true or absent in %r' % (edge,))
        if condition not in CONDITIONS:
            raise Refusal('connections: condition %r for %s -> %s must be one of %s' % (condition, src, dst, ', '.join(CONDITIONS)))
        if optional and 'condition' in edge:
            raise Refusal('connections: an optional edge only draws a dashed line; it takes no condition (%s -> %s)' % (src, dst))
        if (src, dst) in seen:
            raise Refusal('connections: %s -> %s is given twice' % (src, dst))
        seen.add((src, dst))
        edges.append({'from': src, 'to': dst, **({'optional': True} if optional else {}),
                      **({'condition': condition} if not optional and condition != 'healthy' else {})})
    return edges


def do_add(args) -> int:
    if args.old_probe is not None:
        raise Refusal('%s are gone: readiness checks are data now. Use %s.' % (', '.join(OLD_PROBE_FLAGS), NEW_CHECK_FLAGS))
    proposal = json.loads(Path(args.proposal).read_text(encoding='utf-8') if args.proposal != '-' else sys.stdin.read())
    page, facts, catalog = load(args)
    lines, cell, verified, not_offered = build_add(proposal, page, facts, catalog, args)
    date_note(lines, verified, not_offered)
    return commit(page, lines, 'add', cell['id'], cell['view'], verified, not_offered, args)


def do_add_many(args) -> int:
    """Each cell is proven against the ones before it, then one test run and one click per cell cover them all."""
    page, facts, catalog = load(args)
    working, verified, not_offered, cells = page, [], [], []
    for path in args.proposals:
        proposal = json.loads(Path(path).read_text(encoding='utf-8'))
        lines, cell, proven, skipped = build_add(proposal, working, facts, catalog, args)
        verified += ['%s: %s' % (cell['id'], line) for line in proven]
        not_offered += ['%s: %s' % (cell['id'], line) for line in skipped]
        cells.append(cell)
        working = Page(page.path, raw=working.render(lines))
        facts = gate(working, working.lines)['facts']
        catalog = [entry['obj'] for entry in catalog_entries(working.lines)[2]]
    lines = list(working.lines)
    date_note(lines, verified, not_offered)
    label = cells[0]['id'] + ('-and-%d-more' % (len(cells) - 1) if len(cells) > 1 else '')
    return commit(page, lines, 'add', label, cells[0]['view'], verified, not_offered, args,
                  batch=[(cell['id'], cell['view']) for cell in cells])


def build_add(proposal: dict, page: Page, facts: dict, catalog: list[dict], args) -> tuple[list[str], dict, list[str], list[str]]:
    """Everything an add proves and edits, up to the write. Nothing here touches the file."""
    cell, core = dict(proposal.get('cell') or {}), dict(proposal.get('core') or {})
    policy = build_policy(args)
    for flag, key, value in (('--removal-appimage', 'removalAppImages', args.removal_appimage), ('--removal-pipx', 'removalPipx', args.removal_pipx)):
        if value is not None:
            if core.get(key) not in (None, value):
                raise Refusal('%s %s conflicts with the proposal\'s %s %r' % (flag, value, key, core[key]))
            core[key] = value
    problems = field_problems(cell, catalog)
    views = facts['views']
    if cell.get('view') not in views:
        problems.append('unknown workspace %r; the page has %s' % (cell.get('view'), ', '.join(views)))
    elif cell.get('group') not in views[cell['view']]['groups']:
        new_group = parse_kv(args.new_group, '--new-group') if args.new_group else None
        if not new_group or new_group[0] != cell['group']:
            problems.append('group %r is not declared in %s (%s); add one only on explicit request with --new-group %s=Label'
                            % (cell.get('group'), cell['view'], ', '.join(views[cell['view']]['groups']), cell.get('group')))
    if problems:
        raise Refusal('the cell is not valid:\n  - ' + '\n  - '.join(problems))
    ident, shape = cell['id'], classify_command(cell['command'])
    verified = ['command %s: %s exists%s' % (cell['command'], shape['launcher'], ', executable' if shape['shape'] == 'path' else '')]
    not_offered = []
    lines = list(page.lines)

    if args.new_group:
        key, label = parse_kv(args.new_group, '--new-group')
        if key != cell['group'] or not GROUP_KEY_RE.match(key) or not label.strip() or re.search(r'[<>\r\n]', label) or len(label) > 40:
            raise Refusal('--new-group KEY=Label: KEY must equal the cell\'s group and look like [a-z][a-z0-9-]+, Label one short line')
        if key in views[cell['view']]['groups']:
            raise Refusal('group %r already exists in %s; drop --new-group' % (key, cell['view']))
        view_group(lines, cell['view'], key, label)
        verified.append('views.%s.groups += %s (explicit --new-group)' % (cell['view'], key))

    pkg, compose_dir = core.get('removalPackages'), core.get('actionComposeDirs')
    appimage, pipx = core.get('removalAppImages'), core.get('removalPipx')
    manual, reason = bool(core.get('manualRelaunch')), core.get('removalReason')
    sources = [name for name, value in zip(REMOVAL_TABLES, (pkg, compose_dir, appimage, pipx)) if value]
    if len(sources) > 1:
        raise Refusal('one removal source per cell, not %s' % ' and '.join(sources))
    edges = proposal_edges(core, args, ident)
    if pkg:
        verified.append('removalPackages %s: %s' % (pkg, prove_package(cell, pkg, (proposal.get('evidence') or {}).get('desktop'))))
    if compose_dir:
        verified.append('actionComposeDirs %s: %s' % (compose_dir, prove_compose(cell, compose_dir, facts['actionComposeDirs'])))
    if appimage:
        appimage, proof = prove_appimage(cell, appimage)
        if appimage in facts['removalAppImages'].values():
            raise Refusal('removalAppImages refused: ~/%s is already listed for another cell' % appimage)
        verified.append('removalAppImages %s: %s' % (appimage, proof))
    if pipx:
        verified.append('removalPipx %s: %s' % (pipx, prove_pipx(cell, pipx)))
    if manual:
        if compose_dir or shape['shape'] == 'compose':
            raise Refusal('manualRelaunch is not for Compose cells; their re-launch comes from actionComposeDirs')
        if cell.get('status') == 'blocked':
            raise Refusal('manualRelaunch refused: a blocked cell cannot be re-launched')
        if shape['shape'] == 'script':
            kill = KILL_RE.search(Path(shape['launcher']).read_text(encoding='utf-8', errors='replace'))
            if kill:
                raise Refusal('manualRelaunch refused: %s contains %r, so an isolated re-launch is not possible' % (cell['command'], kill.group(0)))
        verified.append('manualRelaunchIds += %s (not Compose, not blocked, no kill pattern in the launcher)' % ident)
    if reason:
        if sources:
            raise Refusal('removalReason only applies when no removal script is offered')
        if not isinstance(reason, str) or re.search(r'[<>\r\n]', reason) or len(reason) > 240 or not reason.strip():
            raise Refusal('removalReason must be one line under 240 characters without < or >')
    readiness = None
    if policy:
        readiness = prove_policy(page.render(page.lines).decode('utf-8'), policy)
        verified.append('dependencyStartup %s (REVIEW IT, it runs in every chain that waits for %s): %s'
                        % (ident, ident, readiness['proof']))
    ids = set(facts['ids'])
    for edge in edges:
        src, dst, optional = edge['from'], edge['to'], bool(edge.get('optional'))
        condition = edge.get('condition', 'healthy')
        if ident not in (src, dst) or src == dst:
            raise Refusal('connections: every new edge must link %r to an existing cell' % ident)
        other = dst if src == ident else src
        if other not in ids:
            raise Refusal('connections: unknown cell %r' % other)
        needs_check = not optional and condition != 'completed'
        if needs_check and src == ident and not policy:
            raise Refusal('connections: %r as a %s prerequisite needs a readiness check (%s)' % (ident, condition, NEW_CHECK_FLAGS))
        if needs_check and src != ident and not facts['readiness'].get(src, {}).get('ok'):
            raise Refusal('connections: %r has no dependencyStartup readiness check, so a %s edge would disable copying; '
                          'mark it optional, use condition completed, or drop it' % (src, condition))
        why = 'optional: a dashed line only' if optional else {
            'healthy': 'healthy: waits until the readiness check of %s passes' % src,
            'started': 'started: starts %s if its check fails, does not wait' % src,
            'completed': 'completed: runs %s to the end first, no readiness check needed' % src}[condition]
        verified.append('connections += %s -> %s (%s)' % (src, dst, why))

    catalog_insert(lines, catalog_line(cell), cell['view'], cell['group'], views)
    for edge in edges:
        one_line_append(lines, 'connections', edge_token(edge))
    if policy:
        block_append(lines, 'dependencyStartup', dependency_line(ident, policy))
    if pkg:
        block_append(lines, 'removalPackages', '  %s:%s' % (ident, js_single_quote(pkg)))
    if compose_dir:
        one_line_append(lines, 'actionComposeDirs', '%s:%s' % (ident, js_single_quote(compose_dir)))
    if appimage:
        one_line_append(lines, 'removalAppImages', '%s:%s' % (ident, js_single_quote(appimage)))
    if pipx:
        one_line_append(lines, 'removalPipx', '%s:%s' % (ident, js_single_quote(pipx)))
    if manual:
        one_line_append(lines, 'manualRelaunchIds', js_single_quote(ident))
    if reason:
        block_append(lines, 'removalReasons', '  %s:%s' % (ident, js_single_quote(reason)))
        not_offered.append('removal script: %s' % reason)

    # inverse check: removing the id again must give back the original bytes
    if remove_lines(lines, ident, bool(args.new_group), []) != page.lines:
        raise Refusal('internal check failed: remove %s would not restore the page exactly. Nothing written.' % ident)
    facts_after = check_after(page, lines, ident)
    tables = facts_after['facts']
    expected = {'removalPackages': pkg, 'actionComposeDirs': compose_dir, 'removalAppImages': appimage, 'removalPipx': pipx,
                'removalReasons': reason}
    for name, value in expected.items():
        if tables[name].get(ident) != (value or None):
            raise Refusal('internal check failed: %s[%s] evaluates to %r' % (name, ident, tables[name].get(ident)))
    if (ident in tables['manualRelaunchIds']) != manual:
        raise Refusal('internal check failed: manualRelaunchIds does not evaluate to what was written')
    if policy and (tables['dependencyStartup'].get(ident) != policy or tables['readiness'][ident].get('test') != readiness['test']):
        raise Refusal('internal check failed: dependencyStartup[%s] does not evaluate to the proven check' % ident)
    written = [edge for edge in tables['connections'] if ident in (edge.get('from'), edge.get('to'))]
    if written != edges:
        raise Refusal('internal check failed: connections evaluate to %r, not %r' % (written, edges))
    for edge in edges:
        if edge['from'] == ident and not node_facts(page.render(lines).decode('utf-8'), {'id': edge['to']})['id']['startup']['ok']:
            raise Refusal('the edge %s -> %s would disable copying for %s' % (edge['from'], edge['to'], edge['to']))
    lifecycle_expectations(facts_after, ident, cell, verified, not_offered, strict=True)
    shared = facts_after['id']['sharedPorts']
    if shared:
        verified.append('shared ports (sharedPorts): ' + '; '.join('%s with %s' % (' · '.join(s['ports']), s['id']) for s in shared))
    return lines, cell, verified, not_offered


def date_note(lines: list[str], verified: list[str], not_offered: list[str]) -> None:
    refreshed, missing = refresh_checked(lines)
    if refreshed:
        verified.append('catalog-meta checked = %s (test -e passed for every command)' % today())
    else:
        not_offered.append('catalog-meta date unchanged; test -e failed for: %s' % ', '.join(missing))


def do_remove(args) -> int:
    page, facts, catalog = load(args)
    cell = next((app for app in catalog if app['id'] == args.id), None)
    if cell is None:
        raise Refusal('no cell with id %r; nothing to remove' % args.id)
    notes: list[str] = []
    lines = remove_lines(page.lines, args.id, args.drop_empty_group, notes)
    check_after(page, lines, None)
    verified = ['catalog: %s (%s) removed; validateCatalog: 0 problems; node --check: every script block' % (args.id, cell['name'])] + notes
    not_offered = []
    if any(args.id in (edge['from'], edge['to']) for edge in facts['connections']):
        not_offered.append('edges were dropped with the cell; dependent chains change (see edits)')
    date_note(lines, verified, not_offered)
    return commit(page, lines, 'remove', args.id, cell['view'], verified, not_offered, args)


def prove_links_into(edges: list[dict], ident: str, facts: dict, verified: list[str]) -> None:
    """Links FROM another cell INTO an existing one ("make ident wait for FROM"): the proofs add uses for its edges."""
    ids, existing = set(facts['ids']), {(edge['from'], edge['to']) for edge in facts['connections']}
    for edge in edges:
        src, optional, condition = edge['from'], bool(edge.get('optional')), edge.get('condition', 'healthy')
        if src == ident:
            raise Refusal('connections: %r cannot wait for itself' % ident)
        if src not in ids:
            raise Refusal('connections: unknown cell %r' % src)
        if (src, ident) in existing:
            raise Refusal('connections: %s -> %s is already on the map' % (src, ident))
        if not optional and condition != 'completed' and not facts['readiness'].get(src, {}).get('ok'):
            raise Refusal('connections: %r has no dependencyStartup readiness check, so a %s edge would disable copying; '
                          'mark it optional, use condition completed, or drop it' % (src, condition))
        why = 'optional: a dashed line only' if optional else {
            'healthy': 'healthy: waits until the readiness check of %s passes' % src,
            'started': 'started: starts %s if its check fails, does not wait' % src,
            'completed': 'completed: runs %s to the end first, no readiness check needed' % src}[condition]
        verified.append('connections += %s -> %s (%s, on the user\'s word)' % (src, ident, why))


def do_update(args) -> int:
    page, facts, catalog = load(args)
    old = next((app for app in catalog if app['id'] == args.id), None)
    if old is None:
        raise Refusal('no cell with id %r' % args.id)
    cell = dict(old)
    for item in args.set or []:
        key, value = parse_kv(item, '--set')
        if key == 'id':
            raise Refusal('the id cannot change; remove the cell and add it again')
        cell[key] = value
    for key in args.unset or []:
        if key in ('id', 'name', 'view', 'group', 'type', 'command', 'note'):
            raise Refusal('%s is required and cannot be unset' % key)
        cell.pop(key, None)
    cell = {key: cell[key] for key in KEY_ORDER if key in cell} | {k: v for k, v in cell.items() if k not in KEY_ORDER}
    problems = field_problems(cell, catalog, own_id=args.id)
    views = facts['views']
    if cell['view'] not in views:
        problems.append('unknown workspace %r' % cell['view'])
    elif cell['group'] not in views[cell['view']]['groups'] and not (args.new_group and parse_kv(args.new_group, '--new-group')[0] == cell['group']):
        problems.append('group %r is not declared in %s; add one only on explicit request with --new-group' % (cell['group'], cell['view']))
    if problems:
        raise Refusal('the updated cell is not valid:\n  - ' + '\n  - '.join(problems))
    changed = sorted(key for key in set(old) | set(cell) if old.get(key) != cell.get(key))
    verified, not_offered, shape = ['fields changed: %s' % (', '.join(changed) or 'none')], [], classify_command(cell['command'])
    if 'command' in changed:
        verified.append('command %s: %s exists' % (cell['command'], shape['launcher']))
        if args.id in facts['removalPackages']:
            verified.append('removalPackages still proven: ' + prove_package(cell, facts['removalPackages'][args.id], None))
        if args.id in facts['actionComposeDirs']:
            rest = {k: v for k, v in facts['actionComposeDirs'].items() if k != args.id}
            verified.append('actionComposeDirs still proven: ' + prove_compose(cell, facts['actionComposeDirs'][args.id], rest))
        if args.id in facts['removalAppImages']:
            verified.append('removalAppImages still proven: ' + prove_appimage(cell, facts['removalAppImages'][args.id])[1])
        if args.id in facts['removalPipx']:
            verified.append('removalPipx still proven: ' + prove_pipx(cell, facts['removalPipx'][args.id]))
    if args.id in facts['manualRelaunchIds']:
        if cell.get('status') == 'blocked':
            raise Refusal('%s is in manualRelaunchIds; a blocked cell cannot be re-launched (remove and re-add it)' % args.id)
        if shape['shape'] == 'script' and KILL_RE.search(Path(shape['launcher']).read_text(encoding='utf-8', errors='replace')):
            raise Refusal('%s is in manualRelaunchIds but the new launcher stops processes; remove and re-add the cell' % args.id)
    links = proposal_edges({}, args, args.id)
    prove_links_into(links, args.id, facts, verified)
    lines = list(page.lines)
    if args.new_group:
        key, label = parse_kv(args.new_group, '--new-group')
        if key != cell['group'] or key in views[cell['view']]['groups'] or not GROUP_KEY_RE.match(key) or re.search(r'[<>\r\n]', label):
            raise Refusal('--new-group KEY=Label must name the cell\'s new, undeclared group')
        view_group(lines, cell['view'], key, label)
    if (old['view'], old['group']) == (cell['view'], cell['group']):
        _, _, entries = catalog_entries(lines)
        entry = next(e for e in entries if e['obj']['id'] == args.id)
        lines[entry['index']] = catalog_line(cell) + (',' if entry['comma'] else '')
    else:
        catalog_delete(lines, args.id)
        catalog_insert(lines, catalog_line(cell), cell['view'], cell['group'], views)
        verified.append('moved from %s/%s to %s/%s' % (old['view'], old['group'], cell['view'], cell['group']))
    for edge in links:
        one_line_append(lines, 'connections', edge_token(edge))
    _, _, before_entries = catalog_entries(page.lines)
    _, _, after_entries = catalog_entries(lines)
    if [e['raw'] for e in before_entries if e['obj']['id'] != args.id] != [e['raw'] for e in after_entries if e['obj']['id'] != args.id]:
        raise Refusal('internal check failed: another cell would change. Nothing written.')
    facts_after = check_after(page, lines, args.id)
    for name in ('connections', 'dependencyStartup', 'manualRelaunchIds', 'removalReasons') + REMOVAL_TABLES:
        if facts_after['facts'][name] != (facts[name] + links if name == 'connections' else facts[name]):
            raise Refusal('internal check failed: %s would change. Nothing written.' % name)
    lifecycle_expectations(facts_after, args.id, cell, verified, not_offered)
    date_note(lines, verified, not_offered)
    return commit(page, lines, 'update', args.id, cell['view'], verified, not_offered, args)


def do_check(args) -> int:
    page = Page(page_path(args.page))
    facts = gate(page, page.lines)
    tables, findings, fine, notes = facts['facts'], facts['problems'] + facts['canonical'], [], []
    _, _, entries = catalog_entries(page.lines)
    for name in ONE_LINE_TABLES:
        one_line_table(page.lines, name)
    for name in BLOCK_TABLES:
        block_table(page.lines, name)
    fine.append('layout: catalog, views, catalog-meta and the %d core tables parse; node --check passes every script block'
                % (len(ONE_LINE_TABLES) + len(BLOCK_TABLES)))
    by_id = {e['obj']['id']: e['obj'] for e in entries}
    missing = [app['id'] for app in by_id.values() if not command_target_exists(app['command'])[0]]
    (findings if missing else fine).append('test -e on every command: %s' % ('missing for ' + ', '.join(missing) if missing else 'all %d present' % len(by_id)))
    for ident, policy in tables['dependencyStartup'].items():
        kind = (policy.get('check') or {}).get('kind') if isinstance(policy, dict) else None
        try:
            fine.append('dependencyStartup %s (%s): %s' % (ident, kind + ' check' if kind else 'raw probe',
                                                          readiness_proof(tables['readiness'][ident], 'dependencyStartup ' + ident)))
        except Refusal as error:
            findings.append(str(error))
        if isinstance(policy, dict) and 'probe' in policy:
            notes.append('dependencyStartup %s uses a raw shell probe; the page itself uses only data checks' % ident)
    for ident, pkg in tables['removalPackages'].items():
        try:
            fine.append('removalPackages %s: %s' % (ident, prove_package(by_id[ident], pkg, None)))
        except (Refusal, KeyError) as error:
            findings.append('removalPackages %s: %s' % (ident, error))
    for ident, rel in tables['actionComposeDirs'].items():
        ok = (Path.home() / rel / 'docker-compose.yml').is_file()
        (fine if ok else findings).append('actionComposeDirs %s: ~/%s/docker-compose.yml %s' % (ident, rel, 'exists' if ok else 'is missing'))
    for ident, rel in tables['removalAppImages'].items():
        try:
            fine.append('removalAppImages %s: %s' % (ident, prove_appimage(by_id[ident], rel)[1]))
        except (Refusal, KeyError) as error:
            findings.append('removalAppImages %s: %s' % (ident, error))
    listed = pipx_packages() if tables['removalPipx'] else {}
    for ident, pkg in tables['removalPipx'].items():
        if listed is None or pkg not in listed:
            findings.append('removalPipx %s: %s' % (ident, 'pipx is not on PATH, so %s cannot be confirmed' % pkg if listed is None
                                                    else 'pipx list --short does not list %s' % pkg))
            continue
        try:
            fine.append('removalPipx %s: %s' % (ident, prove_pipx(by_id[ident], pkg)))
        except (Refusal, KeyError) as error:
            fine.append('removalPipx %s: pipx list --short -> %s %s' % (ident, pkg, listed[pkg]))
            notes.append('removalPipx %s was written by hand; add_cell.py would not write it (%s)' % (ident, error))
    print('launchpad-add-cell check: %s (%d cells, checked %s)' % (page.path, len(by_id), tables['meta'].get('checked')))
    for line in fine:
        print('  ok: ' + line)
    for line in notes:
        print('  note: ' + line)
    for line in findings:
        print('  FINDING: ' + line)
    return 1 if findings else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--page', help='index.html (default: $LAUNCHPAD_PAGE, then the page at the root of this repository)')
    common.add_argument('--dry-run', action='store_true', help='print the report and diff; write nothing')
    common.add_argument('--tools', help='node_modules folder with playwright (default: $LAUNCHPAD_TEST_TOOLS)')
    common.add_argument('--allow-preexisting-failures', action='store_true',
                        help='write even if the unchanged page already fails tests; only new failures roll back')
    sub = parser.add_subparsers(dest='command', required=True)
    add = sub.add_parser('add', parents=[common], help='add one cell from a discover.py proposal')
    add.add_argument('proposal', help='proposal JSON file, or - for stdin')
    add.add_argument('--new-group', metavar='KEY=Label', help='declare the cell\'s group in its workspace (explicit request only)')
    add.add_argument('--connection', action='append', metavar='FROM[:CONDITION]',
                     help='required edge FROM -> new cell; CONDITION healthy (default), started or completed')
    add.add_argument('--optional-connection', action='append', metavar='FROM', help='dashed edge FROM -> new cell (no chain)')
    add.add_argument('--removal-appimage', metavar='PATH', help='~/path/App.AppImage the command runs; the page offers rm -i')
    add.add_argument('--removal-pipx', metavar='PKG', help='pipx package the command runs from; the page offers pipx uninstall')
    ready = add.add_argument_group('readiness check, only when other cells must wait for this one (explicit request only)')
    ready.add_argument('--check-command', metavar='CMD', help='one-line command that exits 0 when ready, e.g. "docker info"')
    ready.add_argument('--check-http', metavar='URL', help='loopback http(s) URL that answers when ready')
    ready.add_argument('--check-expect', metavar='REGEX', help='with --check-http: grep -E pattern the answer must contain')
    ready.add_argument('--check-tcp', metavar='PORT', type=int, help='loopback TCP port that accepts connections when ready')
    ready.add_argument('--check-host', metavar='HOST', help='with --check-tcp: 127.0.0.1 (default), localhost or ::1')
    ready.add_argument('--check-seconds', metavar='N', type=int, help='time limit of one check, 1..60 (default 3)')
    ready.add_argument('--ready', metavar='WORDS', help='plain words for "ready", shown in chain steps (required with a check)')
    ready.add_argument('--timeout', metavar='N', type=int, help='seconds a chain waits for readiness, 0..600 (default 120)')
    for flag in OLD_PROBE_FLAGS:  # retired: refused with a message that names the new flags
        add.add_argument(flag, dest='old_probe', nargs='?', const='', default=None, help=argparse.SUPPRESS)
    many = sub.add_parser('add-many', parents=[common], help='add the cells picked from a folder search, all of them or none')
    many.add_argument('proposals', nargs='+', help='proposal JSON files from scan_folder.py --pick')
    many.set_defaults(new_group=None, connection=None, optional_connection=None, removal_appimage=None, removal_pipx=None,
                      check_command=None, check_http=None, check_expect=None, check_tcp=None, check_host=None,
                      check_seconds=None, ready=None, timeout=None)
    upd = sub.add_parser('update', parents=[common], help='change fields of one cell')
    upd.add_argument('id')
    upd.add_argument('--set', action='append', metavar='FIELD=VALUE')
    upd.add_argument('--unset', action='append', metavar='FIELD')
    upd.add_argument('--new-group', metavar='KEY=Label')
    upd.add_argument('--connection', action='append', metavar='FROM[:CONDITION]',
                     help='make this cell wait for FROM (FROM -> ID); CONDITION healthy (default), started or completed')
    upd.add_argument('--optional-connection', action='append', metavar='FROM', help='dashed line FROM -> ID only (no waiting)')
    rem = sub.add_parser('remove', parents=[common], help='remove one cell and every table entry that names it')
    rem.add_argument('id')
    rem.add_argument('--drop-empty-group', action='store_true', help='also drop its group if no cell is left in it')
    chk = sub.add_parser('check', help='read-only health check of the page')
    chk.add_argument('--page')
    args = parser.parse_args()
    try:
        return {'add': do_add, 'add-many': do_add_many, 'update': do_update, 'remove': do_remove,
                'check': do_check}[args.command](args)
    except Refusal as error:
        eprint('REFUSED: %s' % error)
        return 2
    except (OSError, json.JSONDecodeError) as error:
        eprint('REFUSED: %s' % error)
        return 2


if __name__ == '__main__':
    sys.exit(main())
