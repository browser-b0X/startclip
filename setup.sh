#!/usr/bin/env bash
# Startclip setup for Linux: optionally add Startclip to the app menu and the desktop, and
# print (and copy) the page address so you can bookmark it. Every step asks first; the
# default is No. No sudo, no network; nothing outside your home folder is touched.
#
#   bash setup.sh              ask, then do what you said yes to
#   bash setup.sh --dry-run    show what would be written; write and copy nothing
#   bash setup.sh --uninstall  remove only the files this script made
#
# Windows: run setup.cmd (it starts setup.ps1).
set -euo pipefail

# The file names and marker keep the command-line word, so a re-run updates earlier installs in place.
ID=launchpad-startup-map
MARK=X-Launchpad-Setup=1
DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PAGE=$DIR/index.html
DATA=${XDG_DATA_HOME:-$HOME/.local/share}
MENU=$DATA/applications/$ID.desktop
ICON=$DATA/icons/hicolor/scalable/apps/$ID.svg
DESKDIR=$(xdg-user-dir DESKTOP 2>/dev/null || true)
DESKDIR=${DESKDIR:-$HOME/Desktop}
DESK=$DESKDIR/$ID.desktop
MODE=run

case "${1:-}" in
  '') ;;
  --dry-run) MODE=dry ;;
  --uninstall) MODE=uninstall ;;
  -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) printf 'Unknown option: %s (try --help)\n' "$1" >&2; exit 2 ;;
esac
[ -f "$PAGE" ] || { printf 'index.html not found next to this script (%s).\n' "$DIR" >&2; exit 1; }

ours() { [ -f "$1" ] && grep -q "$MARK" "$1"; }
ask() {  # ask "Question" -> 0 only on y/yes
  local answer=''
  printf '%s [y/N] ' "$1"
  read -r answer || answer=''
  [ -t 0 ] || printf '\n'  # a terminal already echoed the Enter key
  case "$answer" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}
refresh_menu() {
  update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
  kbuildsycoca6 >/dev/null 2>&1 || kbuildsycoca5 >/dev/null 2>&1 || true
}
place() {  # place FILE CONTENT [executable]
  local file=$1 content=$2
  if [ -e "$file" ] && ! ours "$file"; then
    printf '  skipped %s: a file there was not made by setup.sh, so it is left alone.\n' "$file"
    return 1
  fi
  if [ "$MODE" = dry ]; then printf '  would write %s\n' "$file"; return 0; fi
  mkdir -p -- "$(dirname -- "$file")"
  printf '%s' "$content" > "$file"
  [ "${3:-}" = executable ] && chmod +x -- "$file"
  printf '  wrote %s\n' "$file"
}

if [ "$MODE" = uninstall ]; then
  for file in "$MENU" "$DESK" "$ICON"; do
    if ours "$file"; then rm -f -- "$file"; printf '  removed %s\n' "$file"
    elif [ -e "$file" ]; then printf '  kept %s: not made by setup.sh\n' "$file"; fi
  done
  refresh_menu
  printf 'Done. Bookmarks are yours to remove in the browser.\n'
  exit 0
fi

# The page address, percent-encoded like encodeURIComponent for each path segment.
url_path() {
  local LC_ALL=C s=$1 out='' c i
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case "$c" in [A-Za-z0-9/._~!*\'\(\)-]) out+=$c ;; *) printf -v c '%%%02X' "'$c"; out+=$c ;; esac
  done
  printf '%s' "$out"
}
URL="file://$(url_path "$PAGE")"

# Desktop Entry quoting: inside double quotes escape " ` $ \ ; a literal % is written %%.
exec_arg=${PAGE//\\/\\\\}; exec_arg=${exec_arg//\"/\\\"}; exec_arg=${exec_arg//\`/\\\`}; exec_arg=${exec_arg//\$/\\\$}; exec_arg=${exec_arg//%/%%}
ENTRY="[Desktop Entry]
Type=Application
Name=Startclip
GenericName=Startup map
Comment=Your local startup map: click a card to copy its command (never runs anything)
Exec=xdg-open \"$exec_arg\"
Icon=$ID
Terminal=false
Categories=Utility;
$MARK
"

printf 'Startclip: %s\n\n' "$PAGE"
[ "$MODE" = dry ] && printf 'Dry run: nothing will be written or copied.\n\n'

if ask 'Add Startclip to the app menu?'; then
  # The icon is the page's own favicon, so the menu, the desktop and the browser tab match.
  svg=$(grep -o '<link rel="icon" href="data:image/svg+xml,[^"]*"' "$PAGE" | sed 's/^.*svg+xml,//; s/"$//')
  svg=$(printf '%b' "${svg//%/\\x}")
  place "$ICON" "$svg
<!-- $MARK -->
" || true
  place "$MENU" "$ENTRY" && [ "$MODE" = run ] && refresh_menu
fi
if ask 'Also put a Startclip shortcut on the desktop?'; then
  place "$DESK" "$ENTRY" executable || true
fi

printf '\nBookmark: open %s and press Ctrl+D.\n' "$URL"
if [ "$MODE" = dry ]; then
  printf '(would copy the address to the clipboard)\n'
elif printf '%s' "$URL" | wl-copy 2>/dev/null; then printf 'The address is on the clipboard.\n'
elif printf '%s' "$URL" | xclip -selection clipboard 2>/dev/null; then printf 'The address is on the clipboard.\n'
elif printf '%s' "$URL" | xsel --clipboard --input 2>/dev/null; then printf 'The address is on the clipboard.\n'
elif qdbus6 org.kde.klipper /klipper setClipboardContents "$URL" >/dev/null 2>&1; then printf 'The address is on the clipboard.\n'
else printf 'No clipboard tool found; copy the address above by hand.\n'
fi
