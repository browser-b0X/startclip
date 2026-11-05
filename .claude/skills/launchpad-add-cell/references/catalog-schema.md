# Startclip catalog schema and core tables

The authority is `validateCatalog()` in the page's `<script id="core">`; `add_cell.py` runs it through node before
every write. This file explains the format so proposals are right the first time. The current workspaces, groups
and icons are whatever the page declares: `discover.py` lists them whenever it asks about one.

## The catalog line

`<script id="catalog" type="application/json">` holds a JSON array: `[` on its own line, one cell per line, `]`. A
new page has no cells, only those two lines.
Each line is `JSON.stringify` of the cell with keys in this order, absent keys skipped, a comma after every line
except the last:

`id, name, view, group, type, command, port, note, status, warning, icon, tone`

Cells are grouped by workspace and then group, in the order the views block declares them. A new cell goes after
the last cell of its group (or where its group would start).

| Field | Rule (validateCatalog plus helper policy) |
|---|---|
| id | letters, digits, `-`, `_`; unique. New ids: `[a-z0-9][a-z0-9_-]{1,23}`. Used in `data-id`, the tables below and the typed confirmation tokens (`REMOVE id`, `RELAUNCH id`). |
| name | required; unique (the node's accessible name is "Copy startup command for NAME"); at most 40 characters. |
| view, group | a workspace key of the views block and one of its declared groups. A new group needs `--new-group KEY=Label` and the user's request. |
| type | required short label under the name, at most 48 characters. |
| command | required, one line, the exact text the node copies; fish runs it inside chains. Shapes: `/path [args]`, `~/path [args]`, `bash ~/script.sh [args]`, `cd ~/dir; and docker compose up -d`, `bare-command [args]` on PATH, optional `env VAR=value` prefix. Args: letters, digits, `space . _ = / , : + @ ~ -` only. The file must exist. |
| port | optional, `"8080"` or `"3000 · 8000"` (space, middle dot, space). |
| note | required; what is verified and what is not, in the page's voice. |
| status + warning | both or neither. `setup` = check prerequisites, `caution` = review before running (kill patterns, shared state), `blocked` = copy disabled. |
| icon | a key of the `icons` map in the core script. |
| tone | optional accent: `agent`, `model`, `web`; absent means a GUI app. |

No field may contain `<` or `>` (a `</script>` would end the block) or a line break.

## The other data blocks

- `<script id="views">`: `{`, one `"key":{"title","subtitle","default","groups":{key:label,…}}` per line, `}`.
  `--new-group` rewrites only that workspace's line (canonical JSON, group appended last).
- `<script id="catalog-meta">`: `{"checked":"YYYY-MM-DD"}`, or `{}` on a page with no cells. Writes set it to today only
  when `test -e` passes for every cell's launcher (the binary, the script or the compose folder); otherwise the date
  stays and the report names the misses. Removing the last cell clears it again.

## Core tables (in `<script id="core">`)

Each edit appends a token or a line; `remove` deletes exactly that, so add then remove gives back the same bytes.
A table whose layout differs from below is refused, never reformatted.

| Table | Layout | Written when |
|---|---|---|
| `connections` | one line, `[{from:'a',to:'b'},{from:'a',to:'c',condition:'completed'},{…,optional:true}]` | the proposal, `--connection FROM[:condition]` or `--optional-connection FROM` names an edge touching the new id. `condition` is `healthy` (the default, not written), `started` or `completed`. `healthy` and `started` need a valid readiness check for `from` (a cell already in `dependencyStartup`, or the new cell via `--check-*`). `completed` needs none: the chain runs `from` to the end in the foreground and stops if it fails. Optional edges only draw a dashed line and take no condition. |
| `dependencyStartup` | block; the helper writes one line, `  id: {check:{kind:'http', url:'…', seconds:3}, ready:'…', timeout:N}`. Multi-line entries with comments are read and kept. | only `--check-*`, when other cells must wait for this one. See "Readiness checks" below. The user reviews it: it runs inside every dependent chain. |
| `removalPackages` | block, `  id:'package'` | `pacman -Qo` of the launcher names that package, `pacman -Qi` shows it installed with `Required By: None`, the launcher is not an interpreter (bash, env, java, node, …) and takes no file arguments, and the desktop entry (if any) belongs to the same package. The page then offers `sudo pacman -R -- package` behind a typed token. |
| `actionComposeDirs` | one line, `{id:'dir/relative/to/home', …}` | `~/dir/docker-compose.yml` exists (the page hard-codes that file name), the command starts that folder, and no other cell owns it. Gives Compose restart and down scripts. |
| `removalAppImages` | one line, `{id:'Applications/App-1.0-x86_64.AppImage', …}` | `--removal-appimage PATH` or discover: the path is under `$HOME` (no `..`, no leading `/`), the file is a regular file (not a link) ending in `.AppImage`, the command runs exactly that file, and no other cell lists it. The page offers `rm -i -- "$HOME/<path>"`. |
| `removalPipx` | one line, `{id:'package', …}` | `--removal-pipx PKG` or discover: `pipx list --short` lists PKG, and the command resolves into `~/.local/share/pipx/venvs/PKG/` (directly, through its `~/.local/bin` link, or through a `#!` line). The page offers `pipx uninstall PKG`, which removes every command of that package. |
| `manualRelaunchIds` | one line, `new Set(['id',…])` | GUI apps, CLI tools and launcher scripts without `pkill`, `killall`, `kill -9` or `fuser -k`; never Compose or blocked cells. The re-launch script asks the user to quit the app, then starts it. |
| `relaunchReasons` | block, `  id:'why no re-launch script is offered'` | never by the helper: written by hand when the reason is worth more than the page's default sentence. `remove` drops the entry with its cell. |
| `removalReasons` | block, `  id:'why no removal script is offered'` | no removal script is offered and the reason is known (uv, a pipx venv that pipx does not list, /usr/local, /opt, an AppImage the proof does not cover, package with dependents, shared model files, systemd). |

One removal source per cell: `removalPackages`, `actionComposeDirs`, `removalAppImages` or `removalPipx`, and a
`removalReason` only when none applies. Not touched by the helper: `icons` (pick an existing icon) and a policy's
`prepare` line (kept, never written). The page lists dependents in re-launch and removal notes by itself. No app is
named in the engine: every per-app fact lives in one of these tables, and on a new page they are all empty.

## Readiness checks

A check is data; the page's exported `readinessCheck(policy)` turns it into the shell test a chain runs and the tools
it needs, and throws on anything invalid. The helper asks node for that result and never re-derives it.

| Flag | Written as | Rule (readinessCheck) |
|---|---|---|
| `--check-command 'docker info'` | `{kind:'command', run:'docker info', seconds:N}` | one line; test `timeout N <run> >/dev/null 2>&1`; tools `timeout` and the first word |
| `--check-http URL [--check-expect REGEX]` | `{kind:'http', url:'…', expect:'…', seconds:N}` | http or https on 127.0.0.1, localhost or [::1] only; tools `curl` (and `grep` with expect) |
| `--check-tcp PORT [--check-host HOST]` | `{kind:'tcp', port:N, host:'::1', seconds:N}` | port 1 to 65535; host 127.0.0.1 (default), localhost or ::1; tools `timeout`, `bash` |

`--check-seconds N` is 1 to 60 (default 3). `--ready 'words'` is required: it is the step text in every waiting chain.
`--timeout N` is 0 to 600 (default 120). Before writing: readinessCheck must not throw, `bash -n` must parse
`if ! { TEST; }; then :; fi`, and every tool it names must be on PATH. No string may contain `<` or a control
character. A raw `probe` string is still read (readinessCheck accepts it) but never written; `--probe` is refused.

## Gate, in order, before any byte is written

1. Field policy above, command grammar, launcher exists.
2. Table proofs (pacman, compose file, AppImage file, pipx list and venv, kill patterns, edge conditions, the new
   check through readinessCheck, `bash -n` and PATH).
3. The edited page: catalog, views and catalog-meta re-parse as JSON; `node --check` passes every script block;
   `validateCatalog` returns no problems; every catalog line is canonical; the tables evaluate to what was written
   (whole policies and edges, read back through node); `startupPlan` can build the cell's copy text and that of
   every cell it now precedes; `lifecyclePlan` offers exactly the scripts the tables promise.
4. For `add`: removing the id again reproduces the original page exactly.

After the atomic write: `node --test tests/` (compared with the run on the unchanged page) and `smoke_check.cjs`.
