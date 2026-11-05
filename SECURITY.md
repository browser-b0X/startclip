# Security and privacy

## Reporting

Prefer GitHub private vulnerability reporting when it is available on this repository.
Otherwise contact the repository owner through a private channel you already know.
Do not post sensitive details in a public issue. No security-report email address or
response-time guarantee is currently established.

## Official sources

Get Startclip only from [github.com/browser-b0X/startclip](https://github.com/browser-b0X/startclip).
The MIT License lets anyone publish a modified copy, but not under the Startclip name or logo
(see [TRADEMARKS.md](TRADEMARKS.md)). Treat a "Startclip" download from anywhere else as
untrusted: its cards copy commands that you then run in your own terminal. If you find one,
please report it.

## What Startclip does and doesn't do

- Startclip is one HTML file that runs in your browser. It never runs anything: a click copies
  a command, and you decide whether to paste it into a terminal.
- A Content-Security-Policy (`default-src 'none'`) blocks every network request the page could
  make. It loads no remote scripts, fonts or analytics. Links such as Feedback open in your
  browser only when you click them.
- Your map lives in `index.html` on your own disk. Your workspace order, recent copies, theme
  and Get started progress stay in your browser's storage for that file.
- Startup chains, re-launch and removal scripts are copied as text. Re-launch and removal
  scripts ask you to type a confirmation in a real terminal before they change anything.
  Read every script before you run it.
- The `launchpad-add-cell` skill reads your system to propose a card (launchers, packages,
  ports) and writes only `index.html`, after a dry run you approve. It never runs the apps it
  finds, never runs `sudo`, and never installs or removes packages.
- `setup.sh` and `setup.cmd` only add or remove their own menu and desktop shortcuts, and ask
  before each step.

## Sensitive data

Your map can hold home-folder paths, ports and the names of the tools you run. Before you share
a screenshot, a copy of `index.html` or a bug report:

- remove personal paths, user names and host names you don't want public;
- never include tokens, passwords or keys, including any in an `env VAR=value` prefix of a
  command;
- reproduce the problem with a made-up app where you can.

## Limits

The automated checks use synthetic data; they are not a security audit. Startup chains and
removal scripts are written for Linux with bash and fish; review them before you run them
anywhere else.
