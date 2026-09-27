#!/usr/bin/env bash
# Opens the display output full screen on this machine's monitor / capture output.
#   ./deploy/kiosk.sh                      # main output
#   ./deploy/kiosk.sh "/display?bg=green"  # any output URL from the control panel
set -euo pipefail
URL="http://localhost:${PORT:-8080}${1:-/display?bg=black}"

# Wait for the server to come up (useful at boot).
for _ in $(seq 1 60); do curl -fs -o /dev/null "http://localhost:${PORT:-8080}/api/state" && break; sleep 1; done

BROWSER=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)
[ -n "$BROWSER" ] || { echo "Install Google Chrome or Chromium" >&2; exit 1; }

# Hide the mouse pointer if unclutter is installed.
command -v unclutter >/dev/null && (unclutter -idle 0.5 -root &) || true

exec "$BROWSER" \
  --kiosk --start-fullscreen --noerrdialogs --disable-infobars --no-first-run \
  --disable-session-crashed-bubble --disable-features=Translate,TranslateUI \
  --autoplay-policy=no-user-gesture-required \
  --user-data-dir="${XDG_CACHE_HOME:-$HOME/.cache}/propresenter-receiver-kiosk" \
  --app="$URL"
