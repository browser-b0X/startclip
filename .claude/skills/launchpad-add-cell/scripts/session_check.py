#!/usr/bin/env python3
"""SessionStart hook: run `add_cell.py check` quietly and speak only when Startclip needs attention.

Prints nothing when the page is healthy (or absent). Otherwise prints one JSON object for Claude Code:
a short systemMessage for the user and the findings as additionalContext, so the session can offer
`add_cell.py update ID --set command=...` or `remove ID`. Always exits 0; a hook must never block startup.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGE = Path(os.environ.get('LAUNCHPAD_PAGE', HERE.parents[3] / 'index.html'))


def report(message: str, context: str) -> None:
    print(json.dumps({'systemMessage': message,
                      'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': context}}))


def main() -> int:
    if not PAGE.is_file():
        return 0
    try:
        run = subprocess.run([sys.executable, '-I', '-B', str(HERE / 'add_cell.py'), 'check', '--page', str(PAGE)],
                             capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as error:
        report('Startclip check could not run: %s' % error, 'launchpad-add-cell check failed to run: %s' % error)
        return 0
    if run.returncode == 0:
        return 0
    findings = [line.strip()[len('FINDING: '):] for line in run.stdout.splitlines() if line.strip().startswith('FINDING: ')]
    if run.returncode == 1 and findings:
        report('Startclip: %d finding%s, e.g. %s. Ask "fix Startclip" to repair.'
               % (len(findings), '' if len(findings) == 1 else 's', findings[0][:160]),
               'Startclip (%s) check findings; offer the launchpad-add-cell skill (update ID --set command=..., or remove ID), '
               'never edit the page by hand:\n- %s' % (PAGE, '\n- '.join(findings)))
    else:
        detail = (run.stderr or run.stdout).strip().splitlines()
        report('Startclip check refused: %s' % (detail[-1][:160] if detail else 'exit %d' % run.returncode),
               'launchpad-add-cell check exited %d:\n%s' % (run.returncode, (run.stderr or run.stdout).strip()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
