# launchpad-add-cell

A Claude Code skill for the offline Startclip page (`index.html` at the root of this repository). The page ships with
an empty map and this skill fills it. Say "add Obsidian to
Startclip", "I just installed X, add it" or `/launchpad-add-cell X`: Claude runs a read-only discovery (desktop
entries, PATH, `~/.local/bin`, AppImages, pipx venvs, Compose projects, `~/*.sh` launchers, systemd units,
`pacman -Qo/-Qi`, `pipx list --short`),
asks only about facts it cannot verify, shows you a dry-run diff, and after your yes adds one catalog line plus the
table entries it can prove. It also updates (`update ID --set field=value`) and removes cells (`remove ID`, the exact
byte inverse of an add), and `check` re-proves the whole page read-only.

No app in mind? Say "search ~/Applications for apps to add" (any folder works). `scripts/scan_folder.py` lists the desktop
entries, AppImages, Compose projects, launcher scripts and programs that are not on the map yet, you pick by number, and
`add_cell.py add-many` adds your picks in one all-or-nothing write. The search runs nothing, follows no folder links and
opens no `.env` file. It is plain Python, so any agent that can read `SKILL.md` and run a command can drive it.

Orphaned cells (a launcher moved or deleted) are caught two ways: `scripts/session_check.py` as a SessionStart
hook prints a one-line note only when `check` has findings, and each card's "Map entry" footer on the page copies
the check command or a ready-made `claude '...'` update or remove prompt. Hook entry in `~/.claude/settings.json`:

```json
{"matcher": "startup|resume", "hooks": [{"type": "command", "timeout": 30,
  "command": "python3 -I -B ~/.claude/skills/launchpad-add-cell/scripts/session_check.py 2>/dev/null || true"}]}
```

## Activate after vetting

Read `SKILL.md`, `scripts/*.py`, `scripts/smoke_check.cjs` and `references/*.md` (about 2,350 lines of code plus
525 lines of self-tests; Python standard library only, Playwright optional). It needs the page with data readiness
checks (`readinessCheck`, `removalAppImages`, `removalPipx` exported by the core script). Then link the folder into your global
skills and restart Claude Code (skills load at session start):

```fish
ln -s /path/to/launchpad-add-cell ~/.claude/skills/launchpad-add-cell    # wherever the folder was installed
```

Optional: point the click check at a Playwright install with `set -Ux LAUNCHPAD_TEST_TOOLS /path/to/node_modules`. By
default it uses `~/.cache/launchpad-test-tools/node_modules`, else a `node_modules` folder beside the page.
`LAUNCHPAD_PAGE` overrides the page path; `--page PATH` overrides both.

## Self-tests

```fish
python3 -I -B -m unittest discover -s ~/.claude/skills/launchpad-add-cell/scripts -v
```

27 tests, about a minute and a half. They copy the page into a temp folder with a stub test suite, a fake `HOME`
(with a fake AppImage and fake pipx venvs) and a fake read-only `pacman` and `pipx`, and cover add/remove byte round
trips (LF and CRLF, new group, Compose, data check plus dependent, each check kind read back, edge conditions,
AppImage and pipx tables), update, rollback after a failing test, a red baseline, discovery (including AppImage and
pipx proposals), `check`, and a refusal matrix of 62 cases (plus BOM, mixed line endings, three unknown table
layouts and a missing test suite) that all leave the page byte-identical. Your page, tests, package database and
pipx environments are never touched.

## Safety rules

- Copy-only stays copy-only: the skill never runs the app, a catalog command, a startup chain, a readiness check or
  a lifecycle script, and never runs sudo, `pacman -S/-R`, docker, or pipx beyond `pipx list --short`. Subprocesses:
  `pacman -Qo/-Qi`, `pipx list --short`, `systemctl list-unit-files`, `ss -ltn`, `node --check`, `bash -n`,
  `node --test tests/` (your suite) and headless Chromium with a stubbed clipboard.
- Only `scripts/add_cell.py` writes, only `index.html` (atomic replace, UTF-8 without BOM, line endings kept), plus a
  copy of the previous bytes in `~/.local/state/launchpad-add-cell/`. Every write is preceded by a dry run you approve.
- Refuses rather than guesses: uninstalls need a pacman proof with no dependents, the AppImage file the command runs,
  or a pipx package that `pipx list --short` lists and the command runs from; Compose actions need
  `~/<dir>/docker-compose.yml`; `healthy` and `started` edges need a readiness check; new groups and readiness checks
  need your explicit request, and a new check must pass the page's own `readinessCheck`, `bash -n` and PATH.
- Gate before writing: JSON re-parse, `node --check` on every script block, the page's own `validateCatalog`, and the
  remove-after-add inverse check. After writing: `node --test` and the click check; any failure restores the old bytes.
- If your tests already fail before an edit, nothing is written unless you allow `--allow-preexisting-failures`.
