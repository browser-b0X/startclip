# Checklist per app kind

`discover.py` infers the kind; `--kind gui|cli|model-server|compose|service` overrides it. For every kind: the
command must exist on this machine, nothing is launched to "test" it, and any fact the helper could not prove is
asked, not filled in.

## GUI desktop app (desktop entry with Terminal=false)

- Source: the desktop entry (user entries in `~/.local/share/applications` override system ones). Command = `Exec`
  without field codes (`%U`, `%f`) and a trailing `--`; a bare launcher becomes its absolute path like `/usr/bin/obsidian`;
  an `env VAR=value` prefix is kept (`env SOME_FLAG=false /usr/bin/someapp --no-sandbox`).
- Name = the entry's `Name`. Ask when it is long (GIMP's "GNU Image Manipulation Program" → suggest "GIMP").
- Workspace `desktop`; group and icon from `Categories` (3DGraphics → creative/cube, Graphics → creative/layers,
  AudioVideo → creative/monitor, Development → coding/code, Network → daily/globe, Finance → daily/chart,
  Office/Utility → daily/file, otherwise daily/monitor). Confirm only if the user cares; these are medium confidence.
- removalPackages only with the pacman proof (see catalog-schema.md). Package required by others, desktop entry from a
  different package (VLC: vlc vs vlc-cli), /opt or /usr/local → a `removalReason` instead.
- AppImage in your home folder that the command runs directly: discover proposes
  `removalAppImages` with the evidence. A linked AppImage, or one outside home → a `removalReason`.
- manualRelaunch: yes.
- Ask: which entry, when several match equally; the command, when `Exec` uses quotes or `$` (the grammar refuses them).

## CLI agent or terminal tool (on PATH or in ~/.local/bin, no GUI entry)

- Command: `~/.local/bin/name` when it lives there (symlink target reported), otherwise the absolute PATH result.
- pipx install: when the launcher resolves into a pipx venv and `pipx list --short` lists that package, discover
  proposes `removalPipx` (the page offers `pipx uninstall PKG`, which removes all its commands; say so). A venv pipx
  does not list, and uv installs, get a removalReason.
- Default `ai` / `agents`, icon `terminal`, tone `agent`. Always confirm the workspace: a terminal tool is not
  necessarily an AI agent.
- Note: how it is meant to be run (from a project directory, needs an account or a local endpoint and which port).
- If it talks to a local model server, propose an optional edge `{from:'<server id>', to:'<new id>', optional:true}`
  only when the user confirms the server it uses.

## Local model server with a port (`~/serve-*.sh`, `~/start_*.sh`, `~/run-*.sh`, `~/launch-*.sh`, `~/<dir>/*.sh`)

- Command `bash ~/script.sh` (the script must exist). Port read from the script: `--port N`, `PORT=N`, `${PORT:-N}`,
  `127.0.0.1:N`, `-p N`. No port found → ask; never take one from documentation.
- Default `ai` / `models`, icon `chip`, tone `model`.
- Port shared with other cells → warning naming them (from the page's `sharedPorts`), status `setup`.
- `pkill`, `killall`, `kill -9`, `fuser -k` in the script → status `caution`, warning says it stops processes,
  no manualRelaunch. `0.0.0.0` → warning about all interfaces.
- removalReason: model files and runtimes may be shared; no removal script.
- Needs other cells to wait for it? Only then a readiness check, reviewed by the user, for example
  `--check-http http://127.0.0.1:PORT/health --ready 'the server answers on PORT' --timeout 300`, or
  `--check-tcp PORT` when there is no health URL. Pick the timeout from how long the model takes to load.
- Needs another cell first (a Docker engine, a shared backend)? `--connection FROM` when FROM has a readiness check.
  `--connection FROM:completed` for a setup step that exits. `--optional-connection FROM` only draws the link.

## Local web app (a launcher script with a port, no model server)

- `--kind web`, which the folder search sets. Default `services` / `independent`, icon `server`, tone `web`.
- Command, port rules, kill patterns and warnings as for a local model server above, without the model note.
- manualRelaunch: yes, unless the script stops processes. removalReason: launcher scripts may be shared.

## Docker Compose project (`~/<dir>/docker-compose.yml` under ~, ~/Projects, ~/src, ~/code, ~/dev)

- Command `cd ~/<dir>; and docker compose up -d` (fish syntax: the page runs commands with fish). Elsewhere: pass it with
  `--command`.
- Ports: host side of every `ports:` mapping, including `127.0.0.1:H:C`, `${VAR:-N}` and `.env` values. Any mapping
  without a loopback address → the warning says Docker ports may be reachable beyond loopback.
- Default `services` / `docker`, icon `layers`, tone `web`, status `setup`, warning "Requires a ready Docker engine."
- When a cell's readiness check runs `docker info`, the edge from that cell to `id` is proposed (required, healthy). No such
  cell: no edge, and the warning still says Docker must be ready. actionComposeDirs = `<dir>` only when the file is
  named exactly `docker-compose.yml`; `compose.yaml` projects get a removalReason instead.
- manualRelaunch: never (Compose restart comes from actionComposeDirs).

## systemd user service

- Command `systemctl --user start NAME.service` (user units only). A system-wide unit (for example `ollama.service`)
  needs root: ask which command the cell should copy instead; never propose `sudo`.
- Default `services` / `independent`, icon `server`, tone `web`; confirm the workspace.
- No manualRelaunch (systemd owns restarts), removalReason "Managed by systemd".
- When a desktop app or CLI also has a unit, discover asks which launcher the user actually uses.
