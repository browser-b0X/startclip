"""Shared helpers for the launchpad-add-cell skill. Python 3 standard library only.

The Startclip page (index.html) keeps its data in fixed blocks:
  <script id="catalog" type="application/json">       one cell per line, JSON.stringify form
  <script id="views" type="application/json">         one workspace per line
  <script id="catalog-meta" type="application/json">  {"checked":"YYYY-MM-DD"}
  <script id="core">                                  plain JS; validateCatalog() is the schema authority
Nothing in this module writes except write_atomic(). Nothing here runs a catalog command.
"""
from __future__ import annotations

import datetime
import difflib
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

# The page sits at the root of the repository that holds this skill (.claude/skills/<skill>/scripts/here).
# resolve() follows the ~/.claude/skills symlink back to that repository.
DEFAULT_PAGE = Path(__file__).resolve().parents[4] / 'index.html'
KEY_ORDER = ('id', 'name', 'view', 'group', 'type', 'command', 'port', 'note', 'status', 'warning', 'icon', 'tone')
CATALOG_OPEN = '<script id="catalog" type="application/json">'
VIEWS_OPEN = '<script id="views" type="application/json">'
META_OPEN = '<script id="catalog-meta" type="application/json">'
CORE_OPEN = '<script id="core">'
SCRIPT_CLOSE = '</script>'
NEW_ID_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{1,23}$')
GROUP_KEY_RE = re.compile(r'^[a-z][a-z0-9-]{1,23}$')
PKG_RE = re.compile(r'^[a-z0-9@._+-]+$')
REL_DIR_RE = re.compile(r'^[A-Za-z0-9._][A-Za-z0-9._-]*(/[A-Za-z0-9._][A-Za-z0-9._-]*)*$')
TOOL_RE = re.compile(r'^[A-Za-z0-9._+/-]+$')
KILL_RE = re.compile(r'\b(pkill|killall|kill\s+-9|kill\s+-KILL|fuser\s+-k)\b')
# The page's own rules (validateCatalog) for the AppImage and pipx removal tables, and its edge conditions.
APPIMAGE_REL_RE = re.compile(r'^[A-Za-z0-9._ /-]+\.AppImage$')
PIPX_PKG_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')
CONDITIONS = ('healthy', 'started', 'completed')
CHECK_KEYS = ('kind', 'run', 'url', 'expect', 'port', 'host', 'seconds')
# Command grammar: anything outside these shapes is refused, never guessed.
_PATH = r'(?:~|/)[^\s;&|<>$`\'"\\(){}*?#!\[\]]+'
ENV_PREFIX_RE = re.compile(r'^env(?: [A-Z_][A-Z0-9_]*=[A-Za-z0-9._/:,+-]*)+ ')
ARGS_RE = re.compile(r'^[A-Za-z0-9 ._=/,:+@~-]*$')
SHAPES = (
    ('script', re.compile(r'^(?P<interp>bash|sh) (?P<path>' + _PATH + r')(?: (?P<args>.*))?$')),
    ('compose', re.compile(r'^cd (?P<path>' + _PATH + r'); and docker compose up -d$')),
    ('path', re.compile(r'^(?P<path>' + _PATH + r')(?: (?P<args>.*))?$')),
    ('bare', re.compile(r'^(?P<bare>[a-z0-9][a-z0-9._+-]*)(?: (?P<args>.*))?$')),
)
COMPOSE_FILES = ('docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml')
# Launchers that run something else; pacman ownership of these never proves the app's package.
INTERPRETERS = {'env', 'bash', 'sh', 'zsh', 'fish', 'dash', 'node', 'java', 'perl', 'ruby', 'php', 'wine', 'flatpak',
                'snap', 'sudo', 'pkexec', 'doas', 'systemctl', 'docker', 'podman', 'xdg-open', 'gtk-launch', 'kioclient5',
                'appimage-run', 'steam', 'uv', 'uvx', 'pipx', 'npx', 'bunx', 'deno', 'bun'}


class Refusal(Exception):
    """Something the helper will not guess or cannot prove. The message is shown to the user."""


def eprint(*args) -> None:
    sys.stdout.flush()  # keep report order when both streams go to one log
    print(*args, file=sys.stderr)


def page_path(arg: str | None) -> Path:
    """--page, then LAUNCHPAD_PAGE, then the owner's page."""
    if arg:
        return Path(arg).expanduser().resolve()
    env = os.environ.get('LAUNCHPAD_PAGE')
    return Path(env).expanduser().resolve() if env else DEFAULT_PAGE


def run(argv: list[str], timeout: int = 30, stdin: str | None = None, env: dict | None = None,
        cwd: Path | None = None) -> tuple[int, str, str]:
    """Run a read-only helper (pacman -Q*, node, bash -n, ...) without a shell."""
    try:
        proc = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout, check=False,
                              env=env, cwd=cwd)
    except FileNotFoundError:
        return 127, '', argv[0] + ': not found'
    except subprocess.TimeoutExpired:
        return 124, '', argv[0] + ': timed out after %d s' % timeout
    return proc.returncode, proc.stdout, proc.stderr


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def today() -> str:
    return datetime.date.today().isoformat()


def js_single_quote(text: str) -> str:
    return "'" + text.replace('\\', '\\\\').replace("'", "\\'") + "'"


def catalog_line(cell: dict) -> str:
    """The canonical catalog line: JSON.stringify of the cell with keys in KEY_ORDER."""
    unknown = [key for key in cell if key not in KEY_ORDER]
    if unknown:
        raise Refusal('unknown field(s) %s; the catalog only has %s' % (unknown, ', '.join(KEY_ORDER)))
    return json.dumps({key: cell[key] for key in KEY_ORDER if key in cell}, ensure_ascii=False, separators=(',', ':'))


# ---------------------------------------------------------------- pacman (read-only queries)
def pacman_owner(path: str) -> tuple[str, str] | None:
    """pacman -Qo PATH -> (package, version), or None when no package owns it."""
    if shutil.which('pacman') is None:
        return None
    code, out, _ = run(['pacman', '-Qo', '--', path])
    match = re.search(r' is owned by (\S+) (\S+)\s*$', out.strip())
    return (match.group(1), match.group(2)) if code == 0 and match else None


def pacman_info(pkg: str) -> dict | None:
    """pacman -Qi PKG -> {'Description': ..., 'Required By': [...]}, or None when not installed."""
    if shutil.which('pacman') is None or not PKG_RE.match(pkg):
        return None
    code, out, _ = run(['pacman', '-Qi', '--', pkg])
    if code != 0:
        return None
    fields = dict(re.findall(r'^([A-Za-z][A-Za-z ]*?)\s*: (.*)$', out, re.M))
    required = fields.get('Required By', 'None').split()
    return {'Description': fields.get('Description', ''), 'Version': fields.get('Version', ''),
            'Required By': [] if required == ['None'] else required}


# ---------------------------------------------------------------- command grammar
def classify_command(command: str, home: Path | None = None) -> dict:
    """Return {'shape', 'path'|'bare', 'args', 'env', 'launcher', 'errors'} without executing anything.

    launcher is the file pacman -Qo and test -e look at: the executable, the script, or the compose folder.
    """
    result: dict = {'shape': None, 'errors': [], 'args': '', 'env': ''}
    if not isinstance(command, str) or not command or command != command.strip():
        result['errors'].append('command is empty or has leading/trailing spaces')
        return result
    if re.search(r'[\x00-\x1f\x7f]', command):
        result['errors'].append('command contains a line break or control character')
        return result
    text = command
    env_match = ENV_PREFIX_RE.match(text)
    if env_match:
        result['env'] = env_match.group(0).strip()
        text = text[env_match.end():]
    for shape, regex in SHAPES:
        match = regex.match(text)
        if match:
            result['shape'] = shape
            result.update({k: v for k, v in match.groupdict().items() if v is not None})
            break
    if result['shape'] is None:
        result['errors'].append('command shape not recognised. Accepted: /path or ~/path [args]; bash|sh ~/script.sh [args]; '
                                'cd ~/dir; and docker compose up -d; a bare command on PATH [args]; optional env VAR=value prefix')
        return result
    if result['env'] and result['shape'] in ('script', 'compose'):
        result['errors'].append('an env prefix is only accepted in front of a launcher path or command')
    if not ARGS_RE.match(result['args']):
        result['errors'].append('arguments contain characters the helper will not pass through (quotes, $, ;, |, &, <, >, globs): %r' % result['args'])
    home = home or Path.home()
    expand = lambda raw: home / raw[2:] if raw.startswith('~/') else Path(raw)  # noqa: E731
    if result['shape'] == 'bare':
        found = shutil.which(result['bare'])
        if not found:
            result['errors'].append('%r is not on PATH (command -v found nothing)' % result['bare'])
        result['launcher'] = found
    else:
        target = expand(result['path'])
        result['launcher'] = str(target)
        if result['shape'] == 'path':
            if not target.is_file():
                result['errors'].append('%s does not exist as a regular file' % result['path'])
            elif not os.access(target, os.X_OK):
                result['errors'].append('%s exists but is not executable' % result['path'])
        elif result['shape'] == 'script':
            if not target.is_file():
                result['errors'].append('%s does not exist as a regular file' % result['path'])
        elif result['shape'] == 'compose':
            if not any((target / name).is_file() for name in COMPOSE_FILES):
                result['errors'].append('%s has no compose file (%s)' % (result['path'], ', '.join(COMPOSE_FILES)))
    return result


def command_target_exists(command: str, home: Path | None = None) -> tuple[bool, str]:
    """test -e on the launcher a command names (used for the catalog-meta checked date)."""
    info = classify_command(command, home)
    if info['shape'] is None or not info.get('launcher'):
        return False, 'cannot tell which file %r runs' % command
    return Path(info['launcher']).exists(), info['launcher']


# ---------------------------------------------------------------- the page as lines
class Page:
    """index.html as lines, plus what is needed to write it back byte for byte (EOL, final newline).

    Read as bytes and decoded strictly (no newline translation, the same as newline=''); written back as UTF-8
    without BOM with the original line ending and final-newline state.
    """

    def __init__(self, path: Path, raw: bytes | None = None):
        self.path = Path(path)
        if raw is None:
            if not self.path.is_file():
                raise Refusal('page not found: %s' % self.path)
            raw = self.path.read_bytes()
        self.raw = raw
        if raw.startswith(b'\xef\xbb\xbf'):
            raise Refusal('%s starts with a UTF-8 BOM; the page must be UTF-8 without BOM. Nothing changed.' % self.path.name)
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError as error:
            raise Refusal('%s is not valid UTF-8 (%s). Nothing changed.' % (self.path.name, error)) from None
        crlf, lf, cr = raw.count(b'\r\n'), raw.count(b'\n'), raw.count(b'\r')
        if (crlf and crlf != lf) or cr != crlf:
            raise Refusal('%s mixes line endings (CRLF %d, LF %d, CR %d). Normalise it first. Nothing changed.'
                          % (self.path.name, crlf, lf - crlf, cr - crlf))
        self.eol = '\r\n' if crlf else '\n'
        self.trailing = text.endswith(self.eol)
        body = text[:-len(self.eol)] if self.trailing else text
        self.lines = body.split(self.eol)

    def render(self, lines: list[str]) -> bytes:
        return (self.eol.join(lines) + (self.eol if self.trailing else '')).encode('utf-8')


def write_atomic(path: Path, data: bytes) -> None:
    """Temp file in the same folder, fsync, os.replace: readers see the old or the new page, never half."""
    handle, tmp = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(handle, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, path.stat().st_mode & 0o7777 if path.exists() else 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _unique(lines: list[str], text: str, start: int = 0, end: int | None = None) -> int:
    hits = [i for i in range(start, len(lines) if end is None else end) if lines[i] == text]
    if len(hits) != 1:
        raise Refusal('expected exactly one line %r, found %d. The page layout changed; nothing changed.' % (text, len(hits)))
    return hits[0]


def _close_after(lines: list[str], start: int, text: str) -> int:
    for i in range(start + 1, len(lines)):
        if lines[i] == text:
            return i
    raise Refusal('no %r after line %d. The page layout changed; nothing changed.' % (text, start + 1))


def core_span(lines: list[str]) -> tuple[int, int]:
    start = _unique(lines, CORE_OPEN)
    return start, _close_after(lines, start, SCRIPT_CLOSE)


def catalog_entries(lines: list[str]) -> tuple[int, int, list[dict]]:
    """Return ('[' index, ']' index, entries). Each entry: index, raw (no comma), obj, comma."""
    opener = _unique(lines, CATALOG_OPEN)
    close = _close_after(lines, opener, SCRIPT_CLOSE)
    if lines[opener + 1] != '[' or lines[close - 1] != ']':
        raise Refusal('the catalog block is not "[", one cell per line, "]". Nothing changed.')
    entries = []
    for i in range(opener + 2, close - 1):
        line = lines[i]
        comma = line.endswith(',')
        raw = line[:-1] if comma else line
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as error:
            raise Refusal('catalog line %d is not one JSON object: %s. Nothing changed.' % (i + 1, error)) from None
        if not isinstance(obj, dict) or not raw.startswith('{'):
            raise Refusal('catalog line %d is not one object per line. Nothing changed.' % (i + 1))
        entries.append({'index': i, 'raw': raw, 'obj': obj, 'comma': comma})
    for n, entry in enumerate(entries):
        if entry['comma'] != (n < len(entries) - 1):
            raise Refusal('catalog line %d has a wrong trailing comma. Nothing changed.' % (entry['index'] + 1))
    return opener + 1, close - 1, entries


def views_entries(lines: list[str]) -> tuple[dict, dict]:
    """Return (views, line index per view key) from the views block (one workspace per line)."""
    opener = _unique(lines, VIEWS_OPEN)
    close = _close_after(lines, opener, SCRIPT_CLOSE)
    if lines[opener + 1] != '{' or lines[close - 1] != '}':
        raise Refusal('the views block is not "{", one workspace per line, "}". Nothing changed.')
    views, where = {}, {}
    for i in range(opener + 2, close - 1):
        raw = lines[i][:-1] if lines[i].endswith(',') else lines[i]
        try:
            obj = json.loads('{' + raw + '}')
        except json.JSONDecodeError as error:
            raise Refusal('views line %d is not one "key":{...} entry: %s' % (i + 1, error)) from None
        if len(obj) != 1:
            raise Refusal('views line %d holds more than one workspace' % (i + 1))
        key, value = next(iter(obj.items()))
        views[key], where[key] = value, i
    return views, where


def view_line(key: str, value: dict) -> str:
    return json.dumps({key: value}, ensure_ascii=False, separators=(',', ':'))[1:-1]


def meta_line_index(lines: list[str]) -> int:
    opener = _unique(lines, META_OPEN)
    if _close_after(lines, opener, SCRIPT_CLOSE) != opener + 2:
        raise Refusal('catalog-meta is not a single line between its script tags')
    return opener + 1


# ---------------------------------------------------------------- core tables
ONE_LINE_TABLES = {
    'connections': (re.compile(r'^(const connections = \[)(.*)(\];)$'),
                    re.compile(r"\{from:'([a-z0-9_-]+)',to:'([a-z0-9_-]+)'(,optional:true|,condition:'(?:healthy|started|completed)')?\}"), ','),
    'actionComposeDirs': (re.compile(r'^(const actionComposeDirs = \{)(.*)(\};)$'),
                          re.compile(r"([a-z0-9_-]+):'([^'\\]*)'"), ', '),
    'removalAppImages': (re.compile(r'^(const removalAppImages = \{)(.*)(\};)$'),
                         re.compile(r"([a-z0-9_-]+):'([^'\\]*)'"), ', '),
    'removalPipx': (re.compile(r'^(const removalPipx = \{)(.*)(\};)$'),
                    re.compile(r"([a-z0-9_-]+):'([^'\\]*)'"), ', '),
    'manualRelaunchIds': (re.compile(r'^(const manualRelaunchIds = new Set\(\[)(.*)(\]\);)$'),
                          re.compile(r"'([a-z0-9_-]+)'"), ','),
}
BLOCK_TABLES = ('dependencyStartup', 'removalPackages', 'relaunchReasons', 'removalReasons')
_PKG_TOKEN = re.compile(r"([a-z0-9_-]+):'([^'\\]*)'")
_REASON_LINE = re.compile(r"^  ([a-z0-9_-]+):'((?:[^'\\]|\\.)*)'(,?)$")
_DEP_START = re.compile(r'^  ([a-z0-9_-]+): \{')


def one_line_table(lines: list[str], name: str) -> dict:
    """Locate a one-line table and split it into tokens; refuse unless the tokens re-join to the exact line."""
    line_re, token_re, sep = ONE_LINE_TABLES[name]
    start, end = core_span(lines)
    hits = [i for i in range(start, end) if line_re.match(lines[i])]
    if len(hits) != 1:
        raise Refusal('expected one "%s" line in the core script, found %d. Nothing changed.' % (name, len(hits)))
    head, body, tail = line_re.match(lines[hits[0]]).groups()
    tokens = [m.group(0) for m in token_re.finditer(body)]
    if sep.join(tokens) != body:
        raise Refusal('the %s line has a layout the helper does not recognise; edit it by hand. Nothing changed.' % name)
    keys = [token_re.fullmatch(t).groups() for t in tokens]
    return {'index': hits[0], 'head': head, 'tail': tail, 'tokens': tokens, 'keys': keys, 'sep': sep}


def block_table(lines: list[str], name: str) -> dict:
    """Locate `const NAME = {` ... `};` and map each id to the line span of its entry."""
    start, end = core_span(lines)
    opener = _unique(lines, 'const %s = {' % name, start, end)
    close = _close_after(lines, opener, '};')
    entries: list[dict] = []  # {id, first, last, tokens?}
    i = opener + 1
    while i < close:
        line = lines[i]
        if name == 'removalPackages':
            body = line[2:].rstrip(',') if line.startswith('  ') else None
            tokens = [m.group(0) for m in _PKG_TOKEN.finditer(body or '')]
            if body is None or not tokens or ', '.join(tokens) != body:
                raise Refusal('removalPackages line %d has a layout the helper does not recognise' % (i + 1))
            for token in tokens:
                entries.append({'id': _PKG_TOKEN.fullmatch(token).group(1), 'first': i, 'last': i, 'tokens': tokens})
        elif name in ('relaunchReasons', 'removalReasons'):
            match = _REASON_LINE.match(line)
            if not match:
                raise Refusal('%s line %d has a layout the helper does not recognise' % (name, i + 1))
            entries.append({'id': match.group(1), 'first': i, 'last': i})
        else:  # dependencyStartup: one-line entries, or `  id: {` ... `  }` blocks (comments allowed inside)
            match = _DEP_START.match(line)
            if not match:
                raise Refusal('dependencyStartup line %d has a layout the helper does not recognise' % (i + 1))
            last = i
            if line.endswith('{'):
                last = next((j for j in range(i + 1, close) if re.match(r'^  \},?$', lines[j])), None)
                if last is None:
                    raise Refusal('dependencyStartup entry %s has no closing "  }" line' % match.group(1))
            elif not re.search(r'\},?$', line):
                raise Refusal('dependencyStartup line %d does not end with "}"' % (i + 1))
            entries.append({'id': match.group(1), 'first': i, 'last': last})
            i = last
        i += 1
    if entries and lines[entries[-1]['last']].endswith(','):
        raise Refusal('%s: the last entry ends with a comma; edit by hand. Nothing changed.' % name)
    return {'open': opener, 'close': close, 'entries': entries}


def table_has(lines: list[str], name: str, ident: str) -> bool:
    if name == 'connections':
        return any(ident in key[:2] for key in one_line_table(lines, name)['keys'])
    if name in ONE_LINE_TABLES:
        return any(key[0] == ident for key in one_line_table(lines, name)['keys'])
    return any(entry['id'] == ident for entry in block_table(lines, name)['entries'])


def edge_token(edge: dict) -> str:
    """An edge in the page's connections style; the default condition (healthy) is not written."""
    tail = ',optional:true' if edge.get('optional') else (
        ",condition:'%s'" % edge['condition'] if edge.get('condition', 'healthy') != 'healthy' else '')
    return "{from:'%s',to:'%s'%s}" % (edge['from'], edge['to'], tail)


def js_value(value) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise Refusal('only strings and whole numbers are written into a readiness check, not %r' % (value,))
    return str(value) if isinstance(value, int) else js_single_quote(value)


def dependency_line(ident: str, policy: dict) -> str:
    """`  id: {check:{kind:..., ..., seconds:N}, ready:'...', timeout:N}`, the page's one-line layout."""
    check = policy['check']
    body = ', '.join('%s:%s' % (key, js_value(check[key])) for key in CHECK_KEYS if key in check)
    return '  %s: {check:{%s}, ready:%s, timeout:%s}' % (ident, body, js_single_quote(policy['ready']), js_value(policy['timeout']))


def readiness_proof(result: dict, label: str) -> str:
    """bash -n and PATH checks on what the page's readinessCheck returned ({ok, test, tools} or {ok, error})."""
    if not result.get('ok'):
        raise Refusal('%s: the page\'s readinessCheck refuses it: %s' % (label, result.get('error')))
    code, _, err = run(['bash', '-n'], stdin='if ! { %s; }; then :; fi\n' % result['test'])
    if code != 0:
        raise Refusal('%s: the test %r does not parse with bash -n: %s' % (label, result['test'], err.strip()))
    missing = [tool for tool in result['tools'] if not TOOL_RE.match(tool) or shutil.which(tool) is None]
    if missing:
        raise Refusal('%s: %s not on PATH (readinessCheck names the tools a chain needs)' % (label, ', '.join(map(repr, missing))))
    return 'readinessCheck -> %s; bash -n parses it; tools on PATH: %s' % (result['test'], ', '.join(result['tools']) or 'none')


# ---------------------------------------------------------------- AppImage and pipx removal proofs (read-only)
def appimage_rel(text: str, home: Path | None = None) -> str:
    """~/x.AppImage, $HOME/x.AppImage or x.AppImage -> the path relative to $HOME the page's table holds."""
    home = home or Path.home()
    rel = text[2:] if text.startswith('~/') else text
    if rel.startswith('/'):
        prefix = str(home).rstrip('/') + '/'
        if not rel.startswith(prefix):
            raise Refusal('removalAppImages: %s is not under your home folder (%s)' % (text, home))
        rel = rel[len(prefix):]
    parts = rel.split('/')
    if not APPIMAGE_REL_RE.match(rel) or '..' in parts or '' in parts or '.' in parts:
        raise Refusal('removalAppImages %r must be a plain path under $HOME ending in .AppImage (no .., no leading /)' % text)
    return rel


def prove_appimage(cell: dict, text: str, home: Path | None = None) -> tuple[str, str]:
    """The file exists under $HOME, is a regular file (not a link) ending in .AppImage, and the command runs it."""
    home = home or Path.home()
    rel = appimage_rel(text, home)
    target = home / rel
    try:
        mode = os.lstat(target).st_mode
    except OSError:
        raise Refusal('removalAppImages refused: ~/%s does not exist' % rel) from None
    if not stat.S_ISREG(mode):
        raise Refusal('removalAppImages refused: ~/%s is not a regular file (a link or a folder); rm would not remove the app' % rel)
    if os.path.realpath(target) != os.path.join(os.path.realpath(home), rel):
        raise Refusal('removalAppImages refused: ~/%s goes through a linked folder' % rel)
    shape = classify_command(cell.get('command', ''), home)
    if shape['shape'] != 'path' or shape['errors'] or Path(shape['launcher']) != target:
        raise Refusal('removalAppImages refused: the command %r does not run ~/%s' % (cell.get('command'), rel))
    return rel, 'test -f ~/%s (a regular file, not a link); the command runs it' % rel


def pipx_packages() -> dict | None:
    """pipx list --short -> {package: version}, or None when pipx is missing or fails. Read-only."""
    if shutil.which('pipx') is None:
        return None
    code, out, _ = run(['pipx', 'list', '--short'], timeout=60)
    if code != 0:
        return None
    return {parts[0]: (parts[1] if len(parts) > 1 else '') for parts in (line.split() for line in out.splitlines()) if parts}


def pipx_venv_roots(home: Path | None = None) -> list[Path]:
    home = home or Path.home()
    roots = [Path(os.environ['PIPX_HOME']) / 'venvs'] if os.environ.get('PIPX_HOME') else []
    return roots + [home / '.local/share/pipx/venvs', home / '.local/pipx/venvs']


def pipx_package_of(launcher: str, home: Path | None = None) -> tuple[str, str] | None:
    """(venv name, evidence) when the launcher resolves into a pipx venv, or is a shim whose #! line points into one."""
    real = os.path.realpath(launcher)
    candidates = [(real, '%s resolves to %s' % (launcher, real))]
    try:
        with open(real, 'rb') as handle:
            first = handle.readline(512).decode('utf-8', 'replace').strip()
        if first.startswith('#!') and first[2:].split():
            interp = first[2:].split()[0]
            candidates.append((os.path.realpath(interp), '%s starts with #!%s' % (launcher, interp)))
    except OSError:
        pass
    for root in pipx_venv_roots(home):
        base = os.path.realpath(root)
        for path, evidence in candidates:
            rel = os.path.relpath(path, base)
            parts = rel.split(os.sep)
            if not rel.startswith('..') and len(parts) >= 2 and parts[0] not in ('.', ''):
                return parts[0], evidence
    return None


def prove_pipx(cell: dict, pkg: str) -> str:
    """pipx list --short lists PKG and the command runs from that package's venv (directly or through its shim)."""
    if not isinstance(pkg, str) or not PIPX_PKG_RE.match(pkg):
        raise Refusal('removalPipx %r must be a pipx package name' % (pkg,))
    shape = classify_command(cell.get('command', ''))
    if shape['shape'] not in ('path', 'bare') or not shape.get('launcher') or shape['errors']:
        raise Refusal('removalPipx needs a launcher binary; %r is a %s command' % (cell.get('command'), shape['shape']))
    listed = pipx_packages()
    if listed is None:
        raise Refusal('removalPipx %r is not proven: pipx is not on PATH or pipx list --short failed' % pkg)
    if pkg not in listed:
        raise Refusal('removalPipx %r is not proven: pipx list --short lists %s' % (pkg, ', '.join(sorted(listed)) or 'nothing'))
    owner = pipx_package_of(shape['launcher'])
    if not owner or owner[0] != pkg:
        raise Refusal('removalPipx %r is not proven: the command %r does not run from that pipx venv (%s)'
                      % (pkg, cell.get('command'), owner[1] if owner else os.path.realpath(shape['launcher'])))
    return 'pipx list --short -> %s %s; %s' % (pkg, listed[pkg], owner[1])


# ---------------------------------------------------------------- node gate
NODE_FACTS_JS = r"""
'use strict';
const fs = require('node:fs'), vm = require('node:vm');
const html = fs.readFileSync(0, 'utf8');
const want = JSON.parse(process.argv[1] || '{}');
const out = { problems: [], errors: [], canonical: [] };
const block = id => { const m = html.match(new RegExp('<script id="' + id + '" type="application/json">([\\s\\S]*?)</script>')); return m ? m[1] : null; };
try {
  const texts = { catalog: block('catalog'), views: block('views'), meta: block('catalog-meta') };
  for (const [key, text] of Object.entries(texts)) if (text === null) throw Error('the ' + key + ' block is missing');
  const catalog = JSON.parse(texts.catalog), views = JSON.parse(texts.views), meta = JSON.parse(texts.meta);
  const coreMatch = html.match(/<script id="core">([\s\S]*?)<\/script>/);
  if (!coreMatch) throw Error('the core script is missing');
  const context = { module: { exports: {} } };
  vm.runInNewContext(coreMatch[1], context, { timeout: 5000 });
  const core = context.module.exports;
  if (typeof core.validateCatalog !== 'function') throw Error('core does not export validateCatalog');
  out.problems = Array.from(core.validateCatalog(catalog, views));
  const order = ['id', 'name', 'view', 'group', 'type', 'command', 'port', 'note', 'status', 'warning', 'icon', 'tone'];
  const lines = texts.catalog.split(/\r?\n/).filter(line => line.startsWith('{'));
  if (lines.length !== catalog.length) out.canonical.push('the catalog is not one cell per line');
  lines.forEach((line, i) => {
    const object = JSON.parse(line.replace(/,$/, ''));
    const canonical = JSON.stringify(Object.fromEntries(order.filter(key => key in object).map(key => [key, object[key]])));
    if (line.replace(/,$/, '') !== canonical) out.canonical.push('catalog cell ' + (i + 1) + ' (' + object.id + ') is not in canonical form');
  });
  // Whole policies (check, prepare, ready, timeout, or a raw probe), and what the page's readinessCheck makes of each.
  if (typeof core.readinessCheck !== 'function') throw Error('core does not export readinessCheck; this helper needs the page with data readiness checks');
  const readiness = policy => { try { const r = core.readinessCheck(policy); return { ok: true, test: r.test, tools: Array.from(r.tools) }; }
    catch (error) { return { ok: false, error: String(error && error.message || error) }; } };
  const policies = {}, checks = {};
  for (const [key, value] of Object.entries(core.dependencyStartup || {})) { policies[key] = value; checks[key] = readiness(value); }
  for (const name of ['removalAppImages', 'removalPipx']) if (!core[name] || typeof core[name] !== 'object') throw Error('core does not export ' + name);
  out.facts = { ids: catalog.map(app => app.id), iconNames: Object.keys(core.icons || {}), views, meta, connections: core.connections,
    dependencyStartup: policies, readiness: checks, removalPackages: core.removalPackages, actionComposeDirs: core.actionComposeDirs,
    removalAppImages: core.removalAppImages, removalPipx: core.removalPipx,
    manualRelaunchIds: Array.from(core.manualRelaunchIds || []), relaunchReasons: core.relaunchReasons, removalReasons: core.removalReasons };
  if (want.readiness !== undefined) out.readiness = readiness(want.readiness);
  if (want.candidate) {
    const all = [...catalog, want.candidate];
    out.candidate = { problems: Array.from(core.validateCatalog(all, views)), sharedPorts: core.sharedPorts ? core.sharedPorts(all, want.candidate.id) : [] };
  }
  if (want.id && catalog.some(app => app.id === want.id)) {
    const id = want.id, app = catalog.find(item => item.id === id), facts = { present: true };
    try { const plan = core.startupPlan(catalog, core.connections, id); facts.startup = { ok: true, apps: plan.apps.map(item => item.id), command: plan.command }; }
    catch (error) { facts.startup = { ok: false, error: error.message }; }
    for (const kind of ['relaunch', 'remove']) {
      const plan = core.lifecyclePlan(catalog, core.connections, id, kind, true);
      facts[kind] = { offered: !!plan.command, note: plan.note };
    }
    facts.sharedPorts = core.sharedPorts ? core.sharedPorts(catalog, id) : [];
    facts.status = app.status || '';
    out.id = facts;
  } else if (want.id) out.id = { present: false };
} catch (error) { out.errors.push(String(error && error.message || error)); }
process.stdout.write(JSON.stringify(out));
"""


def node_facts(text: str, want: dict | None = None) -> dict:
    """Evaluate the page's own core script in node and return its facts (validateCatalog, tables, per-id plans)."""
    if shutil.which('node') is None:
        raise Refusal('node is not on PATH; validateCatalog cannot be run, so nothing is written')
    code, out, err = run(['node', '-e', NODE_FACTS_JS, json.dumps(want or {})], stdin=text, timeout=60)
    if code != 0:
        raise Refusal('node could not evaluate the page: %s' % (err.strip().splitlines() or ['exit %d' % code])[-1])
    result = json.loads(out)
    if result['errors']:
        raise Refusal('the page does not evaluate: %s' % '; '.join(result['errors']))
    return result


def script_blocks(text: str) -> list[tuple[str, str]]:
    """Every executable <script> block (not application/json) as (label, source)."""
    blocks = []
    for n, match in enumerate(re.finditer(r'<script(?P<attrs>[^>]*)>(?P<body>[\s\S]*?)</script>', text)):
        attrs = match.group('attrs')
        if 'application/json' in attrs:
            continue
        ident = re.search(r'id="([^"]+)"', attrs)
        blocks.append((ident.group(1) if ident else 'script-%d' % (n + 1), match.group('body')))
    return blocks


def gate(page: Page, lines: list[str]) -> dict:
    """Everything that must hold before a byte is written. Returns node facts; raises Refusal otherwise."""
    text = page.render(lines).decode('utf-8')
    for opener, label in ((CATALOG_OPEN, 'catalog'), (VIEWS_OPEN, 'views'), (META_OPEN, 'catalog-meta')):
        match = re.search(re.escape(opener) + r'([\s\S]*?)</script>', text)
        try:
            json.loads(match.group(1))
        except (AttributeError, json.JSONDecodeError) as error:
            raise Refusal('the %s block would no longer parse as JSON (%s). Nothing changed.' % (label, error)) from None
    blocks = script_blocks(text)
    if not any(label == 'core' for label, _ in blocks):
        raise Refusal('no core script found')
    with tempfile.TemporaryDirectory(prefix='launchpad-add-cell-') as tmp:
        for label, body in blocks:
            target = Path(tmp) / (label + '.js')
            target.write_text(body, encoding='utf-8')
            code, _, err = run(['node', '--check', str(target)])
            if code != 0:
                raise Refusal('node --check fails on the %s script: %s. Nothing changed.' % (label, err.strip()[-400:]))
    return node_facts(text)


# ---------------------------------------------------------------- diff report
def regions(lines: list[str]) -> list[tuple[int, int, str]]:
    """(first, last, label) spans used to name changed lines in the report."""
    spans = []
    try:
        first, last, _ = catalog_entries(lines)
        spans.append((first, last, 'catalog'))
    except Refusal:
        pass
    for opener, label in ((VIEWS_OPEN, 'views'), (META_OPEN, 'catalog-meta')):
        if opener in lines:
            i = lines.index(opener)
            spans.append((i, _close_after(lines, i, SCRIPT_CLOSE), label))
    try:
        for name in ONE_LINE_TABLES:
            i = one_line_table(lines, name)['index']
            spans.append((i, i, name))
        for name in BLOCK_TABLES:
            table = block_table(lines, name)
            spans.append((table['open'], table['close'], name))
    except Refusal:
        pass
    return spans


def label_of(spans, index: int) -> str:
    return next((label for first, last, label in spans if first <= index <= last), 'page')


def edit_report(old: list[str], new: list[str]) -> list[str]:
    """1-based line numbers: + new line, - removed line (old numbering), ~ changed line (old -> new)."""
    report, old_spans, new_spans = [], regions(old), regions(new)
    short = lambda s: s if len(s) <= 150 else s[:147] + '...'  # noqa: E731
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag == 'equal':
            continue
        pairs = min(i2 - i1, j2 - j1) if tag == 'replace' else 0
        for k in range(pairs):
            report.append('  ~ line %d (now %d) %s: %s' % (i1 + k + 1, j1 + k + 1, label_of(new_spans, j1 + k), short(new[j1 + k])))
        for i in range(i1 + pairs, i2):
            report.append('  - line %d %s: %s' % (i + 1, label_of(old_spans, i), short(old[i])))
        for j in range(j1 + pairs, j2):
            report.append('  + line %d %s: %s' % (j + 1, label_of(new_spans, j), short(new[j])))
    return report


def unified(old: list[str], new: list[str], name: str) -> str:
    return '\n'.join(difflib.unified_diff(old, new, 'a/' + name, 'b/' + name, lineterm='', n=1))
