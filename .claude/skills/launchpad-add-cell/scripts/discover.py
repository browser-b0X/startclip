#!/usr/bin/env python3
"""Read-only discovery: turn "I just installed X" into a proposed Startclip cell with evidence.

Looks at desktop entries (user entries override system ones, env-prefixed Exec lines kept), PATH,
~/.local/bin (symlinks resolved; pipx venvs proven with pipx list --short, uv detected), ~/Applications
AppImages (proposed for removalAppImages when the command runs the file), Compose projects (host ports
incl. 127.0.0.1:H:C and ${VAR:-N}), ~/*.sh and ~/*/*.sh launchers (ports, kill patterns, bind address),
systemd units, pacman -Qo/-Qi, pipx list --short and ss -ltn. Never runs the app or a catalog command.

stdout: the proposal JSON (also written to --out FILE). stderr: a short report.
Exit: 0 proposal printed (read "ready" and "questions"), 3 already in the catalog, 2 nothing found or refused.
"""
from __future__ import annotations

import argparse
import configparser
import json
import os
import platform
import re
import shutil
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # keep the skill folder free of __pycache__
sys.path.insert(0, str(Path(__file__).resolve().parent))
from launchpad_common import (INTERPRETERS, KILL_RE, NEW_ID_RE, Page, Refusal, catalog_entries,  # noqa: E402
                              classify_command, eprint, node_facts, pacman_info, pacman_owner, page_path, pipx_package_of,
                              pipx_packages, prove_appimage, run)

HOME = Path.home()
DESKTOP_DIRS = (HOME / '.local/share/applications', Path('/usr/local/share/applications'), Path('/usr/share/applications'),
                HOME / '.local/share/flatpak/exports/share/applications', Path('/var/lib/flatpak/exports/share/applications'))
COMPOSE_PARENTS = (HOME, HOME / 'Projects', HOME / 'src', HOME / 'code', HOME / 'dev')
COMPOSE_NAMES = ('docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml')
LAUNCHER_NAME_RE = re.compile(r'^(serve|start|run|launch)([-_].*)?\.sh$', re.I)
FIELD_CODE_RE = re.compile(r' ?%[a-zA-Z]')
BIND_ALL_RE = re.compile(r'0\.0\.0\.0|--host[= ]"?::"?(\s|$)')
MODEL_HINT_RE = re.compile(r'llama-server|llama\.cpp|vllm|ollama|sglang|\.gguf|text-generation|koboldcpp', re.I)
PORT_PATTERNS = (re.compile(r'--port[= ]"?(\d{2,5})\b'), re.compile(r'\bPORT="?(\d{2,5})\b'),
                 re.compile(r'\$\{[A-Z_]*PORT:-(\d{2,5})\}'), re.compile(r'(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d{2,5})\b'),
                 re.compile(r'(?:^|\s)-p (\d{2,5})(?:\s|$)'))
CATEGORY_GROUPS = (  # (desktop Categories, desktop group, icon) — first match wins
    ({'3DGraphics'}, 'creative', 'cube'),
    ({'Graphics', '2DGraphics', 'RasterGraphics', 'VectorGraphics', 'Photography'}, 'creative', 'layers'),
    ({'AudioVideo', 'Audio', 'Video'}, 'creative', 'monitor'),
    ({'Development', 'IDE', 'TextEditor', 'Building', 'Debugger'}, 'coding', 'code'),
    ({'Network', 'WebBrowser', 'Chat', 'InstantMessaging', 'Email'}, 'daily', 'globe'),
    ({'Finance'}, 'daily', 'chart'),
    ({'Office', 'TextTools', 'Utility', 'Education'}, 'daily', 'file'),
)
KIND_DEFAULTS = {
    'gui': {'view': 'desktop', 'group': 'daily', 'icon': 'monitor', 'type': 'Desktop app'},
    'cli': {'view': 'ai', 'group': 'agents', 'icon': 'terminal', 'tone': 'agent', 'type': 'Terminal tool'},
    'model-server': {'view': 'ai', 'group': 'models', 'icon': 'chip', 'tone': 'model', 'type': 'Local model server'},
    'web': {'view': 'services', 'group': 'independent', 'icon': 'server', 'tone': 'web', 'type': 'Local web app'},
    'compose': {'view': 'services', 'group': 'docker', 'icon': 'layers', 'tone': 'web', 'type': 'Docker Compose project'},
    'service': {'view': 'services', 'group': 'independent', 'icon': 'server', 'tone': 'web', 'type': 'systemd user service'},
}
BLOCKING = ('command', 'view', 'group', 'icon', 'port', 'name', 'id', 'status')


def slug(text: str) -> str:
    return re.sub(r'[^a-z0-9]', '', text.lower())


def tilde(path: Path) -> str:
    try:
        return '~/' + str(path.relative_to(HOME))
    except ValueError:
        return str(path)


# ---------------------------------------------------------------- desktop entries
def read_desktop(path: Path) -> dict | None:
    parser = configparser.RawConfigParser(strict=False, interpolation=None, delimiters=('=',))
    parser.optionxform = str
    try:
        parser.read_string(path.read_text(encoding='utf-8', errors='replace'))
    except (configparser.Error, OSError):
        return None
    if not parser.has_section('Desktop Entry'):
        return None
    entry = dict(parser.items('Desktop Entry'))
    if entry.get('Type', 'Application') != 'Application' or entry.get('NoDisplay') == 'true' or entry.get('Hidden') == 'true':
        return None
    entry['_path'], entry['_stem'] = str(path), path.stem
    return entry


def desktop_entries() -> list[dict]:
    """XDG precedence: the first directory that has a desktop-file ID wins (user overrides system)."""
    seen, entries = set(), []
    for directory in DESKTOP_DIRS:
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob('*.desktop')):
            ident = str(path.relative_to(directory)).replace('/', '-')
            if ident in seen:
                continue
            seen.add(ident)
            entry = read_desktop(path)
            if entry:
                entries.append(entry)
    return entries


def exec_head(exec_line: str) -> str:
    words = exec_line.split()
    while words and (words[0] == 'env' or re.match(r'^[A-Z_][A-Z0-9_]*=', words[0])):
        words.pop(0)
    return Path(words[0]).name if words else ''


def score_desktop(entry: dict, query: str) -> int:
    q, s = query.lower(), slug(query)
    name, stem = entry.get('Name', ''), entry['_stem']
    if not s:
        return 0
    if stem.lower() == q or slug(stem) == s or slug(stem.split('.')[-1]) == s:
        return 100
    if name.lower() == q:
        return 95
    if slug(name) == s:
        return 90
    if slug(exec_head(entry.get('Exec', ''))) == s:
        return 80
    if s and slug(entry.get('StartupWMClass', '')).endswith(s):
        return 60
    if len(s) >= 4 and (s in slug(name) or s in slug(stem)):
        return 50
    return 0


def find_desktop(query: str) -> tuple[dict | None, list[dict]]:
    scored = sorted(((score_desktop(e, query), e) for e in desktop_entries()), key=lambda item: (-item[0], item[1]['_path']))
    scored = [(score, entry) for score, entry in scored if score]
    if not scored:
        return None, []
    return scored[0][1], [entry for score, entry in scored[1:] if score == scored[0][0]]


def exec_to_command(exec_line: str) -> tuple[str, list[str]]:
    """Strip field codes and a trailing --, keep an env prefix, make a bare launcher absolute like /usr/bin/blender."""
    notes = []
    text = FIELD_CODE_RE.sub('', exec_line).strip()
    text = re.sub(r'\s+', ' ', re.sub(r' --$', '', text))
    if '"' in text or "'" in text or '\\' in text:
        notes.append('the Exec line uses quoting the catalog grammar does not accept: %s' % exec_line)
    words = text.split(' ')
    env, rest = [], words
    if words and words[0] == 'env':
        env = ['env']
        rest = words[1:]
        while rest and re.match(r'^[A-Z_][A-Z0-9_]*=', rest[0]):
            env.append(rest.pop(0))
    if rest and '/' not in rest[0]:
        found = shutil.which(rest[0])
        if found:
            notes.append('launcher %s resolved with command -v to %s' % (rest[0], found))
            rest[0] = found
    return ' '.join(env + rest), notes


# ---------------------------------------------------------------- compose, scripts, units
def expand_vars(text: str, env: dict) -> str:
    def repl(match):
        name, default = match.group(1) or match.group(4), match.group(3)
        return env.get(name, default if default is not None else '')
    return re.sub(r'\$\{([A-Za-z_][A-Za-z0-9_]*)(:?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)', repl, text)


def compose_ports(compose: Path, read_env: bool = True) -> tuple[list[str], bool]:
    """Host ports published by a compose file, and whether any of them binds beyond loopback."""
    env = {}
    dotenv = compose.parent / '.env'
    if read_env and dotenv.is_file():
        for line in dotenv.read_text(encoding='utf-8', errors='replace').splitlines():
            match = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=["\']?([^"\'#\s]*)', line)
            if match:
                env[match.group(1)] = match.group(2)
    ports, public, in_ports, indent = [], False, False, 0
    for line in compose.read_text(encoding='utf-8', errors='replace').splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        current = len(line) - len(line.lstrip())
        if re.match(r'^ports:\s*$', stripped):
            in_ports, indent = True, current
            continue
        if in_ports and current <= indent and not stripped.startswith('-'):
            in_ports = False
        if not in_ports:
            continue
        published = re.match(r'^-?\s*published:\s*["\']?([^"\'\s]+)', stripped)
        item = re.match(r'^-\s*["\']?([^"\'\s#]+)', stripped)
        if published:
            host_ip, host = '', expand_vars(published.group(1), env)
        elif item:
            parts = expand_vars(item.group(1), env).split('/')[0].split(':')
            if len(parts) == 3:
                host_ip, host = parts[0], parts[1]
            elif len(parts) == 2:
                host_ip, host = '', parts[0]
            else:
                continue
        else:
            continue
        host = host.split('-')[0]
        if host.isdigit() and 0 < int(host) < 65536:
            if host not in ports:
                ports.append(host)
            if host_ip not in ('127.0.0.1', 'localhost', '::1'):
                public = True
    return ports, public


def find_compose(query: str) -> Path | None:
    s = slug(query)
    for parent in COMPOSE_PARENTS:
        try:
            children = sorted(child for child in parent.iterdir() if child.is_dir() and not child.name.startswith('.'))
        except OSError:
            continue
        for child in children:
            if slug(child.name) == s and any((child / name).is_file() for name in COMPOSE_NAMES):
                return child
    return None


def find_scripts(query: str) -> list[Path]:
    s, found = slug(query), []
    if len(s) < 3:
        return found
    for path in sorted(list(HOME.glob('*.sh')) + list(HOME.glob('*/*.sh'))):
        in_dir = path.parent != HOME and slug(path.parent.name) == s
        if (LAUNCHER_NAME_RE.match(path.name) or in_dir) and (s in slug(path.stem) or in_dir) and path.is_file():
            found.append(path)
    return found


def script_facts(script: Path) -> dict:
    text = script.read_text(encoding='utf-8', errors='replace')
    code = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))
    ports = []
    for pattern in PORT_PATTERNS:
        for match in pattern.finditer(code):
            if match.group(1) not in ports:
                ports.append(match.group(1))
    kill = KILL_RE.search(code)
    return {'ports': ports, 'kills': kill.group(0) if kill else '', 'binds_all': bool(BIND_ALL_RE.search(code)),
            'model': bool(MODEL_HINT_RE.search(code))}


def systemd_units(query: str) -> list[dict]:
    units, s = [], slug(query)
    if not s or shutil.which('systemctl') is None:
        return units
    for scope in (['--user'], []):
        code, out, _ = run(['systemctl', *scope, 'list-unit-files', '--no-legend', '--type=service', '*%s*.service' % s])
        for line in out.splitlines() if code == 0 else []:
            parts = line.split()
            if parts and '@' not in parts[0]:
                units.append({'unit': parts[0], 'scope': 'user' if scope else 'system', 'state': parts[1] if len(parts) > 1 else ''})
    return units


def listening_ports() -> set[str]:
    if shutil.which('ss') is None:
        return set()
    code, out, _ = run(['ss', '-Hltn'])
    return {m.group(1) for m in re.finditer(r':(\d+)\s', out)} if code == 0 else set()


def short_type(entry: dict | None, name: str, description: str) -> tuple[str | None, str]:
    for key in ('GenericName', 'Comment'):
        value = (entry or {}).get(key, '').strip().rstrip('.')
        if value and value.casefold() != name.casefold() and len(value) <= 40 and '<' not in value and '>' not in value:
            return value[0].upper() + value[1:], 'low'
    if description:
        clause = re.split(r'[,.;:(]| that | which | for | with ', description, maxsplit=1)[0].strip()
        clause = re.sub(r'^(an?|the)\s+', '', clause, flags=re.I)
        if 3 <= len(clause) <= 40 and len(clause.split()) >= 2:
            return clause[0].upper() + clause[1:], 'low'
    return None, 'low'


def pretty_name(stem: str) -> str:
    stem = re.sub(r'^(serve|start|run|launch)[-_]?', '', stem, flags=re.I)
    return ' '.join(word[:1].upper() + word[1:] for word in re.split(r'[-_ ]+', stem) if word) or stem


# ---------------------------------------------------------------- main
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('query', help='app name, binary, package, launcher script or compose folder, e.g. obsidian')
    parser.add_argument('--page', help='index.html (default: $LAUNCHPAD_PAGE, then the page at the root of this repository)')
    parser.add_argument('--out', type=Path, help='also write the proposal JSON to this file')
    parser.add_argument('--kind', choices=sorted(KIND_DEFAULTS), help='force the app kind instead of inferring it')
    for field in ('id', 'name', 'view', 'group', 'type', 'command', 'port', 'note', 'icon', 'tone', 'status', 'warning'):
        parser.add_argument('--' + field, help='use this %s instead of the discovered one (re-validated)' % field)
    args = parser.parse_args()
    if platform.system() != 'Linux':
        eprint('REFUSED: discovery reads Linux desktop entries and pacman, so it runs only on an Arch-based Linux system.')
        return 2
    try:
        page = Page(page_path(args.page))
        _, _, entries = catalog_entries(page.lines)
        facts = node_facts(page.render(page.lines).decode('utf-8'))['facts']
    except Refusal as error:
        eprint('REFUSED:', error)
        return 2
    catalog = [entry['obj'] for entry in entries]
    views, icons = facts['views'], facts['iconNames']
    query = args.query.strip()
    report, evidence, questions, confidence, cell = [], {}, [], {}, {}

    def ask(field, why, suggestion=None):
        questions.append({'field': field, 'why': why, **({'suggestion': suggestion} if suggestion is not None else {})})

    # ---- look everywhere (read-only) ----
    desktop, ties = find_desktop(query)
    binary = shutil.which(query) or (shutil.which(slug(query)) if slug(query) else None)
    local_bin = next((p for p in (HOME / '.local/bin' / query, HOME / '.local/bin' / slug(query)) if slug(query) and p.exists()), None)
    appimages = sorted(p for p in (HOME / 'Applications').glob('*.AppImage') if slug(query) and slug(query) in slug(p.name)) \
        if (HOME / 'Applications').is_dir() else []
    compose_dir = find_compose(query)
    scripts = find_scripts(query)
    units = systemd_units(query)
    given = classify_command(args.command) if args.command else None
    if given and given['shape'] == 'script' and given.get('launcher') and Path(given['launcher']).is_file():
        scripts = [Path(given['launcher'])]
    if given and given['shape'] == 'compose' and given.get('launcher') and \
            any((Path(given['launcher']) / name).is_file() for name in COMPOSE_NAMES):
        compose_dir = Path(given['launcher'])
    if desktop:
        report.append('desktop entry: %s (Name=%s, Exec=%s, Terminal=%s, Categories=%s)' % (
            desktop['_path'], desktop.get('Name'), desktop.get('Exec'), desktop.get('Terminal', 'false'), desktop.get('Categories', '')))
        evidence['desktop'] = desktop['_path']
    if ties:
        ask('command', 'several desktop entries match equally: ' + ', '.join(t['_path'] for t in ties))
    if binary:
        report.append('on PATH: %s' % binary)
    if local_bin:
        report.append('in ~/.local/bin: %s -> %s' % (local_bin, os.path.realpath(local_bin)))
    for image in appimages:
        report.append('AppImage: %s' % image)
    if compose_dir:
        report.append('Compose project: %s' % compose_dir)
    for script in scripts:
        report.append('launcher script: %s' % script)
    for unit in units:
        report.append('systemd %s unit: %s (%s)' % (unit['scope'], unit['unit'], unit['state']))
    if len(scripts) > 1 and not args.command:
        ask('command', 'several launcher scripts match: ' + ', '.join(tilde(p) for p in scripts), tilde(scripts[0]))
    if len(appimages) > 1 and not args.command:
        ask('command', 'several AppImages match (versions?): ' + ', '.join(p.name for p in appimages))
    if not any([desktop, binary, local_bin, appimages, compose_dir, scripts, units, args.command]):
        eprint('NOTHING FOUND: no desktop entry, PATH command, ~/.local/bin entry, AppImage, Compose project, launcher script '
               'or systemd unit matches %r. Ask for the launcher and re-run with --command.' % query)
        return 2

    # ---- kind ----
    script = scripts[0] if scripts else None
    sfacts = script_facts(script) if script else None
    kind = args.kind
    if not kind:
        if compose_dir:
            kind = 'compose'
        elif script:
            kind = 'model-server' if (sfacts['ports'] or sfacts['model']) else 'cli'
        elif desktop:
            kind = 'cli' if desktop.get('Terminal', 'false') == 'true' else 'gui'
        elif binary or local_bin:
            kind = 'cli'
        elif appimages:
            kind = 'gui'
        elif given:
            kind = 'compose' if given['shape'] == 'compose' else 'cli'
        else:
            kind = 'service'
    confidence['kind'] = 'high' if (args.kind or compose_dir or desktop) else 'medium'
    defaults = KIND_DEFAULTS[kind]

    # ---- command ----
    command, confidence['command'] = '', 'none'
    if args.command:
        command, confidence['command'] = args.command, 'high'
        evidence['command'] = ['given with --command']
    elif kind == 'compose' and compose_dir:
        command, confidence['command'] = 'cd %s; and docker compose up -d' % tilde(compose_dir), 'high'
        evidence['command'] = ['compose file in %s; fish syntax, the page runs commands with fish' % compose_dir]
    elif script and kind in ('model-server', 'cli', 'web'):
        command, confidence['command'] = 'bash %s' % tilde(script), 'high'
        evidence['command'] = ['%s exists' % script]
    elif desktop and desktop.get('Exec'):
        command, notes = exec_to_command(desktop['Exec'])
        confidence['command'] = 'high'
        evidence['command'] = ['Exec=%s in %s (field codes stripped)' % (desktop['Exec'], desktop['_path'])] + notes
    elif local_bin:
        command, confidence['command'] = '~/.local/bin/' + local_bin.name, 'high'
        evidence['command'] = ['%s exists' % local_bin]
    elif binary:
        command, confidence['command'] = binary, 'high'
        evidence['command'] = ['command -v %s -> %s' % (query, binary)]
    elif appimages:
        command, confidence['command'] = tilde(appimages[-1]), 'medium'
        evidence['command'] = ['%s exists' % appimages[-1]]
    elif units:
        user_units = [u for u in units if u['scope'] == 'user']
        if user_units:
            command, confidence['command'] = 'systemctl --user start %s' % user_units[0]['unit'], 'medium'
            evidence['command'] = ['systemd user unit %s' % user_units[0]['unit']]
        else:
            ask('command', 'only a system-wide unit exists (%s); starting it needs root. Which command should the cell copy?'
                % ', '.join(u['unit'] for u in units))
    if units and kind != 'service' and command:
        ask('command', 'a systemd unit also exists (%s); the cell copies %r. Confirm that is the launcher you use.'
            % (', '.join(u['unit'] for u in units), command), command)
    shape = classify_command(command) if command else {'errors': ['no launcher found'], 'shape': None}
    if shape['errors']:
        confidence['command'] = 'none'
        ask('command', '; '.join(shape['errors']), command or None)
    if re.search(r'\b(sudo|pkexec|doas)\b', command):
        ask('command', 'the launcher asks for root; confirm the cell should copy it', command)
    cell['command'] = command

    # ---- already present? exact command, or the same launcher with the same arguments ----
    launcher = shape.get('launcher')
    for app in catalog:
        other = classify_command(app['command'])
        same_target = launcher and other.get('launcher') and os.path.realpath(other['launcher']) == os.path.realpath(launcher)
        if app['command'] == command or (same_target and other.get('args', '') == shape.get('args', '')):
            eprint('ALREADY PRESENT: cell %r (%s) copies %r. Nothing to add.' % (app['id'], app['name'], app['command']))
            return 3
        if same_target:
            report.append('cell %r uses the same launcher with other arguments: %s' % (app['id'], app['command']))

    # ---- identity ----
    ids, names = {app['id'] for app in catalog}, {app['name'].casefold(): app['id'] for app in catalog}
    if args.name:
        name, confidence['name'] = args.name, 'high'
    elif desktop and desktop.get('Name'):
        name, confidence['name'] = desktop['Name'].strip(), 'high'
    elif compose_dir:
        name, confidence['name'] = pretty_name(compose_dir.name), 'medium'
    elif script:
        name, confidence['name'] = pretty_name(script.stem), 'low'
    else:
        name, confidence['name'] = query if any(ch.isupper() for ch in query) else query[:1].upper() + query[1:], 'medium'
    if len(name) > 24 or len(name.split()) > 3:
        initials = ''.join(word[0] for word in name.split() if word[:1].isalpha()).upper()
        suggestion = query.upper() if slug(query).upper() == initials else (query if len(query) <= 24 else name[:24])
        confidence['name'] = 'low'
        ask('name', 'the desktop entry name %r is long for a node title' % name, suggestion)
    elif confidence['name'] == 'low':
        ask('name', 'name derived from a file name: %r' % name, name)
    if name.casefold() in names:
        confidence['name'] = 'none'
        ask('name', 'cell %r already uses the name %r' % (names[name.casefold()], name))
    cell['name'] = name
    ident = args.id or (slug(query) if 2 <= len(slug(query)) <= 24 else slug(name)[:24])
    confidence['id'] = 'high' if args.id else 'medium'
    if ident in ids or not NEW_ID_RE.match(ident):
        suggestion = next((ident[:22] + str(n) for n in range(2, 10) if ident[:22] + str(n) not in ids), None)
        confidence['id'] = 'none'
        ask('id', 'id %r is taken or not of the form [a-z0-9][a-z0-9_-]{1,23}' % ident, suggestion)
    cell['id'] = ident

    # ---- workspace, group, icon, tone ----
    group, icon, group_conf = defaults['group'], defaults['icon'], 'medium' if kind != 'gui' else 'low'
    categories = set(filter(None, (desktop or {}).get('Categories', '').split(';')))
    if kind == 'gui' and categories:
        for tokens, mapped_group, mapped_icon in CATEGORY_GROUPS:
            if categories & tokens:
                group, icon, group_conf = mapped_group, mapped_icon, 'medium'
                evidence['group'] = ['Categories=%s -> %s / %s' % (';'.join(sorted(categories)), mapped_group, mapped_icon)]
                break
    cell['view'] = args.view or defaults['view']
    cell['group'] = args.group or group
    cell['icon'] = args.icon or icon
    if args.tone or 'tone' in defaults:
        cell['tone'] = args.tone or defaults['tone']
    confidence['view'] = 'high' if args.view else ('low' if kind in ('cli', 'service') else 'medium')
    confidence['group'] = 'high' if args.group else group_conf
    confidence['icon'] = 'high' if args.icon else 'low'
    if kind in ('cli', 'service') and not (args.view or args.group):
        ask('view', 'a %s: confirm the workspace and group' % ('terminal tool' if kind == 'cli' else 'background service'),
            '%s/%s' % (cell['view'], cell['group']))
    if cell['view'] not in views:
        ask('view', 'unknown workspace %r' % cell['view'], sorted(views))
    elif cell['group'] not in views[cell['view']]['groups']:
        ask('group', 'group %r is not declared in %s (add it only on request, with --new-group)' % (cell['group'], cell['view']),
            sorted(views[cell['view']]['groups']))
    if cell['icon'] not in icons:
        ask('icon', 'unknown icon %r' % cell['icon'], icons)

    # ---- package, removal, re-launch ----
    core = {'removalPackages': None, 'actionComposeDirs': None, 'removalAppImages': None, 'removalPipx': None,
            'manualRelaunch': kind in ('gui', 'cli', 'model-server', 'web'), 'connections': [], 'removalReason': None}
    pkg_desc = ''
    if shape.get('shape') in ('path', 'bare') and launcher and not shape['errors']:
        head = Path(launcher).name
        owner = pacman_owner(launcher)
        if owner:
            info = pacman_info(owner[0]) or {}
            pkg_desc = info.get('Description', '')
            evidence['package'] = ['pacman -Qo %s -> %s %s' % (launcher, owner[0], owner[1])]
            report.append('owning package: %s %s (pacman -Qo)' % owner)
            desktop_owner = pacman_owner(desktop['_path']) if desktop else None
            if head in INTERPRETERS or re.search(r'[/~]', shape.get('args', '')):
                core['removalReason'] = 'The launcher %s runs something else; removing its package would not remove this app. No removal script is offered.' % head
            elif desktop and desktop_owner and desktop_owner[0] != owner[0]:
                core['removalReason'] = 'The desktop entry (%s) and the launcher (%s) belong to different packages. No removal script is offered.' % (desktop_owner[0], owner[0])
            elif info.get('Required By'):
                core['removalReason'] = 'The %s package is required by %s. No isolated removal script is offered.' % (owner[0], ', '.join(info['Required By'][:4]))
                report.append('removal not offered: %s is required by %s' % (owner[0], ', '.join(info['Required By'])))
            else:
                core['removalPackages'] = owner[0]
                if desktop_owner:
                    evidence['package'].append('pacman -Qo %s -> %s' % (desktop['_path'], desktop_owner[0]))
        else:
            real = os.path.realpath(launcher)
            venv = pipx_package_of(launcher)
            listed = pipx_packages() if venv else None
            if venv and listed and venv[0] in listed:
                core['removalPipx'] = venv[0]
                evidence['removalPipx'] = ['pipx list --short -> %s %s' % (venv[0], listed[venv[0]]), venv[1]]
                report.append('pipx package: %s %s (pipx list --short); the page can offer pipx uninstall %s' % (venv[0], listed[venv[0]], venv[0]))
            elif venv:
                core['removalReason'] = 'Installed in a pipx environment (%s) that pipx list --short does not show. No removal script is offered.' % venv[0]
                report.append('pipx venv %s found, but pipx list --short does not list it%s' % (venv[0], '' if listed is not None else ' (pipx is not on PATH)'))
            elif '/.local/share/uv/' in real or '/.local/share/pipx/' in real or '/.local/pipx/' in real:
                core['removalReason'] = 'Installed with pipx or uv (%s). Removal is not scripted here; uninstall it with the tool that installed it.' % tilde(Path(real))
            elif real.startswith('/usr/local/'):
                core['removalReason'] = 'Installed under /usr/local without a package. No removal script is offered.'
            elif real.startswith('/opt/'):
                core['removalReason'] = 'Installed under /opt without a package. No removal script is offered.'
            elif real.endswith('.AppImage'):
                try:
                    rel, proof = prove_appimage(cell, launcher)
                    core['removalAppImages'] = rel
                    evidence['removalAppImages'] = [proof]
                    report.append('AppImage launcher ~/%s; the page can offer rm -i on that file' % rel)
                except Refusal as why:
                    core['removalReason'] = 'Standalone AppImage. Removal is not scripted for this cell; delete the file after quitting the app.'
                    report.append('AppImage removal not offered: %s' % why)
            if not (core['removalPipx'] or core['removalAppImages']):
                report.append('no pacman package owns %s; no removal script will be offered' % launcher)
    elif kind == 'service':
        core['removalReason'] = 'Managed by systemd. Disable and remove the unit yourself; no removal script is offered.'
        core['manualRelaunch'] = False
    if sfacts and sfacts['kills']:
        core['manualRelaunch'] = False
        report.append('re-launch not offered: %s contains %r' % (tilde(script), sfacts['kills']))
    if kind == 'compose':
        core['manualRelaunch'] = False
        if compose_dir and (compose_dir / 'docker-compose.yml').is_file():
            core['actionComposeDirs'] = str(compose_dir.relative_to(HOME)) if compose_dir.is_relative_to(HOME) else None
            evidence['actionComposeDirs'] = ['%s/docker-compose.yml exists' % compose_dir]
        if not compose_dir:
            ask('command', 'no Compose project was found; give the folder with --command "cd ~/DIR; and docker compose up -d"')
        elif not core['actionComposeDirs']:
            core['removalReason'] = 'The project has no docker-compose.yml in a folder under home, which the page\'s Compose actions need. No removal script is offered.'
        engine = next((key for key, check in facts['readiness'].items() if key in facts['ids'] and check.get('ok') and ' docker info ' in check['test']), None)
        if compose_dir and engine:
            core['connections'] = [{'from': engine, 'to': ident}]
            evidence['connections'] = ['Compose cells wait for %s; the page\'s readinessCheck gives: %s' % (engine, facts['readiness'][engine]['test'])]
    if script and kind != 'compose' and not core['removalReason']:
        core['removalReason'] = 'Model files, runtimes and launcher scripts may be shared. No removal script is offered.'

    # ---- ports, conflicts, warnings ----
    ports, public = ([p for p in args.port.split(' · ')], False) if args.port else ([], False)
    if not args.port and kind == 'compose' and compose_dir:
        compose_file = next(compose_dir / n for n in COMPOSE_NAMES if (compose_dir / n).is_file())
        ports, public = compose_ports(compose_file)
        evidence['port'] = ['ports: in %s -> %s' % (compose_file, ports or 'none')]
    elif not args.port and sfacts:
        ports = sfacts['ports']
        evidence['port'] = ['read from %s -> %s' % (tilde(script), ports or 'none')]
    if ports:
        cell['port'] = ' · '.join(ports)
        confidence['port'] = 'high' if args.port else 'medium'
    elif kind in ('compose', 'model-server'):
        ask('port', 'no published port found in the compose file or script')
    warning_bits = []
    conflicts = {}
    if ports:
        candidate = {key: cell[key] for key in cell}
        shared = node_facts(page.render(page.lines).decode('utf-8'), {'candidate': {**candidate, 'type': 'x', 'note': 'x'}})
        for item in shared['candidate']['sharedPorts']:
            for port in item['ports']:
                conflicts.setdefault(port, []).append(item['id'])
        if conflicts:
            by_name = {app['id']: app['name'] for app in catalog}
            warning_bits.append(' '.join('Port %s is also used by %s; do not start them together.' % (
                port, ', '.join(by_name[i] for i in sorted(ids_))) for port, ids_ in conflicts.items()))
        busy = sorted(set(ports) & listening_ports())
        if busy:
            report.append('listening right now (ss -ltn, informational): %s' % ', '.join(busy))
    if sfacts and sfacts['kills']:
        warning_bits.append('This script forcibly stops matching processes (%s). Save other work first.' % sfacts['kills'])
    if sfacts and sfacts['binds_all']:
        warning_bits.append('Its configured bind address is all interfaces.')
    if kind == 'compose':
        warning_bits.append('Requires a ready Docker engine.' + (' Docker ports may be reachable beyond loopback.' if public else ''))
    if args.status or args.warning:
        cell.update({k: v for k, v in (('status', args.status), ('warning', args.warning)) if v})
        confidence['status'] = 'high'
        if not (args.status and args.warning):
            ask('status', 'status and warning go together; give both --status and --warning')
    elif warning_bits:
        cell['status'] = 'caution' if (sfacts and sfacts['kills']) else 'setup'
        cell['warning'] = ' '.join(warning_bits)
        confidence['status'] = 'medium'

    # ---- wording (cosmetic: rewrite in the page's voice when low) ----
    type_text, confidence['type'] = (args.type, 'high') if args.type else short_type(desktop, name, pkg_desc)
    cell['type'] = type_text or defaults['type']
    pkg_note = ' Installed with pacman (%s).' % core['removalPackages'] if core['removalPackages'] else ''
    note = args.note or {
        'gui': 'Opens %s from its desktop launcher.%s' % (name, pkg_note),
        'cli': 'Run from the directory you want to work in.%s' % pkg_note,
        'model-server': 'Launcher script is present. Model files and hardware fit were not tested.',
        'web': 'Launcher script is present. It was not run to test it.',
        'compose': 'Fish-shell command. Requires a ready Docker engine; Compose starts the project services.',
        'service': 'Starts the systemd user unit. Logs: journalctl --user -u %s.' % (command.split()[-1] if command else name),
    }[kind]
    cell['note'], confidence['note'] = note, 'high' if args.note else 'low'

    # ---- pre-check with the page's own validateCatalog ----
    ordered = {key: cell[key] for key in ('id', 'name', 'view', 'group', 'type', 'command', 'port', 'note', 'status', 'warning', 'icon', 'tone') if key in cell}
    try:
        check = node_facts(page.render(page.lines).decode('utf-8'), {'candidate': ordered})['candidate']['problems']
    except Refusal as error:
        check = [str(error)]
    asked = {q['field'] for q in questions}
    for problem in check:
        covered = (('workspace' in problem and 'view' in asked) or ('group' in problem and 'group' in asked)
                   or ('icon' in problem and 'icon' in asked) or ('duplicate id' in problem and 'id' in asked))
        if not covered:
            ask('schema', problem)

    ready = not any(q['field'] in BLOCKING or q['field'] == 'schema' for q in questions)
    proposal = {'query': query, 'kind': kind, 'ready': ready, 'cell': ordered, 'confidence': confidence, 'evidence': evidence,
                'core': core, 'portConflicts': conflicts, 'questions': questions, 'report': report}
    text = json.dumps(proposal, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(text + '\n', encoding='utf-8')
    print(text)
    for line in report:
        eprint('·', line)
    for q in questions:
        eprint('? %s: %s%s' % (q['field'], q['why'], ' (suggestion: %s)' % q['suggestion'] if 'suggestion' in q else ''))
    eprint('proposal ready' if ready else 'proposal needs answers before add_cell.py add')
    return 0


if __name__ == '__main__':
    sys.exit(main())
