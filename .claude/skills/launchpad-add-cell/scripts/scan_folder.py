#!/usr/bin/env python3
"""Read-only folder search: list the apps in one folder that are not on the Startclip map, for the user to pick from.

  scan_folder.py FOLDER --out scan.json [--depth N]         numbered list on stdout, the same list as JSON in --out
  scan_folder.py --from scan.json --pick 1,3 --out-dir DIR  one discover.py proposal per pick, written to DIR

Finds desktop entries, AppImages, Compose projects, launcher scripts and programs. Stays inside FOLDER, follows no
folder links, skips hidden folders, dependency and build folders and Python environments, opens no .env file and
never runs what it finds. Plain Python and the page are all it needs, so any agent, or a terminal, can drive it.

Exit: 0 list or proposals written, 3 nothing new in the folder, 2 refused.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shlex
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # keep the skill folder free of __pycache__
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from discover import (CATEGORY_GROUPS, COMPOSE_NAMES, LAUNCHER_NAME_RE, compose_ports, exec_to_command,  # noqa: E402
                      pretty_name, read_desktop, script_facts, slug, tilde)
from launchpad_common import Page, Refusal, catalog_entries, classify_command, eprint, page_path, run  # noqa: E402

MAX_ENTRIES = 50000
MAX_SCRIPT_BYTES = 1_000_000
SKIP_DIRS = {'bower_components', 'build', 'cache', 'ci', 'coverage', 'dist', 'docs', 'examples', 'fixtures', 'include', 'lib',
             'lib64', 'logs', 'node_modules', 'out', 'share', 'site-packages', 'target', 'temp', 'test', 'tests', 'tmp', 'vendor',
             'venv', '__pycache__'}
PROJECT_FILES = ('Cargo.toml', 'Gemfile', 'go.mod', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py')
NOT_A_LAUNCHER_RE = re.compile(r'^(backup|bootstrap|build|clean|cleanup|configure|deploy|download|format|install|kill|lint|migrate|'
                               r'publish|release|restore|setup|stop|test|tests|uninstall|update|upgrade)([-_.]|$)', re.I)
DEV_WORD_RE = re.compile(r'(^|[-_.])(bench|benchmark|check|ci|e2e|lint|smoke|test|tests|unit|verify)([-_.]|$)', re.I)
VERSION_TAIL_RE = re.compile(r'[-_ .]+v?\d[\w.+-]*$')
UNSAFE_PATH_RE = re.compile(r'[\s;&|<>$`\'"\\(){}*?#!\[\]]')
ORDER = {'desktop entry': 0, 'AppImage': 1, 'Compose project': 2, 'launcher script': 3, 'program': 4}


def files_in(root: Path, depth: int, state: dict):
    """Files under root, level 0 being root itself. Folder links are not followed; a file link is read as its target."""
    stack, seen = [(root, 0)], 0
    while stack:
        folder, level = stack.pop()
        try:
            entries = sorted(os.scandir(folder), key=lambda entry: entry.name)
        except OSError:
            state['unreadable'] += 1
            continue
        if folder != root and any(entry.name == 'pyvenv.cfg' for entry in entries):
            continue
        for entry in entries:
            seen += 1
            if seen > MAX_ENTRIES:
                state['truncated'] = True
                return
            if entry.is_dir(follow_symlinks=False):
                if level < depth and not entry.name.startswith('.') and entry.name.lower() not in SKIP_DIRS:
                    stack.append((Path(entry.path), level + 1))
            elif entry.is_file():
                yield Path(entry.path), level


def clean_name(text: str, fallback: str) -> str:
    """A name read from a file is data: one short line, or the file's own name."""
    text = ' '.join(text.split())
    return text if text and len(text) <= 40 and not re.search(r'[<>\x00-\x1f\x7f]', text) else fallback


def app_name(path: Path) -> str:
    """Cursor-1.2.3-x86_64.AppImage -> Cursor; serve-tiny.sh -> Tiny; start.sh takes the folder's name."""
    return pretty_name(VERSION_TAIL_RE.sub('', path.stem) or path.stem) or pretty_name(path.parent.name) or path.stem


def head_of(path: Path) -> bytes:
    try:
        with open(path, 'rb') as handle:
            return handle.read(4)
    except OSError:
        return b''


def desktop_item(path: Path) -> dict | None:
    entry = read_desktop(path)
    if not entry or not entry.get('Exec') or 'X-Launchpad-Setup' in entry:  # the page's own shortcut is not an app to add
        return None
    command, _ = exec_to_command(entry['Exec'])
    item = {'how': 'desktop entry', 'kind': 'cli' if entry.get('Terminal', 'false') == 'true' else 'gui',
            'name': clean_name(entry.get('Name', ''), app_name(path)), 'command': command}
    categories = set(filter(None, entry.get('Categories', '').split(';')))
    for tokens, group, icon in CATEGORY_GROUPS:
        if categories & tokens:
            item.update(group=group, icon=icon)
            break
    return item


def script_item(path: Path) -> dict:
    facts = script_facts(path) if path.stat().st_size <= MAX_SCRIPT_BYTES else {'ports': [], 'model': False}
    return {'how': 'launcher script', 'kind': 'model-server' if facts['model'] else 'web' if facts['ports'] else 'cli',
            'name': app_name(path), 'command': 'bash ' + tilde(path), 'ports': facts['ports']}


def classify(path: Path, level: int) -> dict | None:
    """What this file offers, or None for a file that is not a way to start an app."""
    name, lower, parent = path.name, path.name.lower(), path.parent
    if name in COMPOSE_NAMES:
        return {'how': 'Compose project', 'kind': 'compose', 'name': pretty_name(parent.name),
                'command': 'cd %s; and docker compose up -d' % tilde(parent), 'ports': compose_ports(path, read_env=False)[0]}
    if lower.endswith('.desktop'):
        return desktop_item(path)
    if lower.endswith('.appimage'):
        return {'how': 'AppImage', 'kind': 'gui', 'name': app_name(path), 'command': tilde(path)}
    if NOT_A_LAUNCHER_RE.match(lower) or DEV_WORD_RE.search(lower):
        return None
    if lower.endswith('.sh'):
        return script_item(path) if level == 0 or LAUNCHER_NAME_RE.match(name) else None
    if '.so' in lower or not os.access(path, os.X_OK):
        return None
    project_tool = parent.name == 'bin' and any((parent.parent / name).is_file() for name in PROJECT_FILES)
    if level == 0 or (parent.name == 'bin' and not project_tool) or slug(path.stem) == slug(parent.name):
        head = head_of(path)
        if head == b'\x7fELF' or head[:2] == b'#!':
            return {'how': 'program', 'kind': 'cli', 'name': app_name(path), 'command': tilde(path)}
    return None


def map_index(catalog: list[dict]) -> tuple[dict, dict, list]:
    """Where the map's cells point: (launcher, args) -> cell, Compose folders -> cell, and every path a command names."""
    launchers, compose_dirs, used = {}, {}, []
    for app in catalog:
        info = classify_command(app['command'])
        if info.get('launcher'):
            real = os.path.realpath(info['launcher'])
            launchers[(real, info.get('args', ''))] = app
            if info['shape'] == 'compose':
                compose_dirs[real] = app
        used += [(os.path.realpath(os.path.expanduser(word)), app) for word in app['command'].split() if word[0] in '~/']
    return launchers, compose_dirs, used


def search(root: Path, depth: int, catalog: list[dict]) -> dict:
    state = {'truncated': False, 'unreadable': 0}
    found, left_out, on_map, seen = [], [], {}, set()
    for path, level in files_in(root, depth, state):
        try:
            item = classify(path, level)
        except OSError as error:
            left_out.append({'path': tilde(path), 'why': str(error)})
            continue
        if not item:
            continue
        item['path'] = tilde(path)
        if UNSAFE_PATH_RE.search(tilde(path)):
            left_out.append({'path': tilde(path), 'why': "the path has a space or special character, which the page's commands cannot hold"})
            continue
        found.append(item)
    launchers, compose_dirs, used = map_index(catalog)
    names = {slug(text): app for app in catalog for text in (app['id'], app['name'])}
    candidates = []
    for item in sorted(found, key=lambda entry: (ORDER[entry['how']], entry['path'])):
        info = classify_command(item['command'])
        if info['errors']:
            left_out.append({'path': item['path'], 'why': '; '.join(info['errors'])})
            continue
        real = os.path.realpath(info['launcher'])
        key = (real, info.get('args', ''))
        cell = launchers.get(key)
        if not cell and item['how'] == 'Compose project':  # a project this map already starts another way
            cell = next((app for where, app in used if where.startswith(real + os.sep)), None)
        if not cell and item['how'] == 'launcher script':
            cell = compose_dirs.get(os.path.dirname(real))
        if cell:
            on_map[cell['id']] = {'id': cell['id'], 'name': cell['name'], 'path': item['path']}
        elif key not in seen:
            seen.add(key)
            if slug(item['name']) in names:
                item['sameName'] = names[slug(item['name'])]['id']
            candidates.append(item)
    candidates.sort(key=lambda entry: entry['path'].lower())
    for number, item in enumerate(candidates, 1):
        query = slug(item['name'])[:24] or 'app%d' % number
        item['n'] = number
        item['discover'] = [query, '--command', item['command'], '--kind', item['kind'], '--name', item['name']]
        if item.get('group'):
            item['discover'] += ['--group', item['group'], '--icon', item['icon']]
    return {'folder': '~' if root == Path.home() else tilde(root), 'depth': depth, 'candidates': candidates, 'onMap': list(on_map.values()),
            'leftOut': left_out, 'truncated': state['truncated'], 'unreadable': state['unreadable']}


def print_list(result: dict, out: Path) -> None:
    candidates = result['candidates']
    print('Startclip folder search: %s' % result['folder'])
    if candidates:
        print('%d app%s not on the map yet:' % (len(candidates), '' if len(candidates) == 1 else 's'))
    width = max((len(item['name']) for item in candidates), default=0)
    for item in candidates:
        ports = ('  port ' + ' · '.join(item['ports'])) if item.get('ports') else ''
        twin = '  (same name as the %s cell)' % item['sameName'] if item.get('sameName') else ''
        print('%3d. %-*s  %-15s  %s%s%s' % (item['n'], width, item['name'], item['how'], item['command'], ports, twin))
    if result['onMap']:
        print('Already on the map: ' + ', '.join(entry['name'] for entry in result['onMap']))
    for entry in result['leftOut'][:12]:
        print('Left out: %s: %s' % (entry['path'], entry['why']))
    if len(result['leftOut']) > 12:
        print('Left out: %d more, listed in %s' % (len(result['leftOut']) - 12, out))
    if result['unreadable']:
        print('Could not read %d folder%s.' % (result['unreadable'], '' if result['unreadable'] == 1 else 's'))
    if result['truncated']:
        print('Stopped after %d files: search a smaller folder or lower --depth.' % MAX_ENTRIES)
    if candidates:
        print('Ask which numbers to add, then run: scan_folder.py --from %s --pick 1,3 --out-dir DIR' % shlex.quote(str(out)))
    else:
        print('Nothing new: everything found is already on the map or left out above.')


def do_scan(args) -> int:
    root = Path(args.folder).expanduser()
    if not root.is_dir():
        raise Refusal('%s is not a folder' % args.folder)
    if not 0 <= args.depth <= 8:
        raise Refusal('--depth must be 0..8')
    page = Page(page_path(args.page))
    catalog = [entry['obj'] for entry in catalog_entries(page.lines)[2]]
    result = search(root.resolve(), args.depth, catalog)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print_list(result, args.out)
    return 0 if result['candidates'] else 3


def parse_pick(text: str, numbers: set[int]) -> list[int]:
    picks = []
    for part in text.split(','):
        if not part.strip().isdigit() or int(part) not in numbers or int(part) in picks:
            raise Refusal('--pick %s: %r is not a number from the list, or is given twice' % (text, part.strip()))
        picks.append(int(part))
    return picks


def do_pick(args) -> int:
    result = json.loads(Path(args.source).read_text(encoding='utf-8'))
    items = {item['n']: item for item in result['candidates']}
    picks = parse_pick(args.pick, set(items))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    made = []
    for number in picks:
        item = items[number]
        out = args.out_dir / ('%d-%s.json' % (number, item['discover'][0]))
        argv = [sys.executable, '-I', '-B', str(HERE / 'discover.py'), *item['discover'], '--out', str(out)]
        code, stdout, stderr = run(argv + (['--page', args.page] if args.page else []), timeout=120)
        if code == 0:
            proposal = json.loads(stdout)
            questions = proposal['questions']
            made.append(str(out))
            print('%d %s: %s  %s' % (number, item['name'], '%d question%s' % (len(questions), '' if len(questions) == 1 else 's')
                                     if questions else 'ready', out))
            for question in questions:
                print('    ? %s: %s%s' % (question['field'], question['why'],
                                          ' (suggestion: %s)' % question['suggestion'] if 'suggestion' in question else ''))
            if questions:
                print('    re-run with the answer: ' + shlex.join(['discover.py', *item['discover'], '--out', str(out)]))
        else:
            print('%d %s: not proposed: %s' % (number, item['name'], (stderr.strip().splitlines() or ['discover exited %d' % code])[-1]))
    if not made:
        raise Refusal('no pick gave a proposal')
    print('Next: add_cell.py add-many %s --dry-run' % shlex.join(made))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('folder', nargs='?', help='the folder to search, for example ~/Applications')
    parser.add_argument('--depth', type=int, default=3, help='how many folder levels to go down (default 3)')
    parser.add_argument('--out', type=Path, help='write the list as JSON here; --pick reads it back')
    parser.add_argument('--from', dest='source', help='the JSON from an earlier search')
    parser.add_argument('--pick', help='the numbers the user chose, for example 1,3')
    parser.add_argument('--out-dir', type=Path, help='folder for the proposals')
    parser.add_argument('--page', help='index.html (default: $LAUNCHPAD_PAGE, then the page at the root of this repository)')
    args = parser.parse_args()
    if platform.system() != 'Linux':
        eprint('REFUSED: the folder search reads Linux launchers and hands them to discover.py; run it on the Linux machine.')
        return 2
    picking = args.source or args.pick or args.out_dir
    if (picking and not (args.source and args.pick and args.out_dir)) or (not picking and not (args.folder and args.out)):
        parser.error('give FOLDER --out FILE, or --from FILE --pick 1,3 --out-dir DIR')
    try:
        return do_pick(args) if picking else do_scan(args)
    except (Refusal, OSError, ValueError, KeyError) as error:
        eprint('REFUSED: %s' % error)
        return 2


if __name__ == '__main__':
    sys.exit(main())
