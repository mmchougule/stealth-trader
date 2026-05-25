#!/usr/bin/env bash
#
# Record the stealth-trader smoke as docs/demo.gif.
#
# Interactive — asciinema opens a fresh shell, runs the smoke for you, then
# exits. The `--command` flag was unreliable (smoke output got dropped from
# the cast); piping a here-doc into the recorded shell is what works.
#
# Requires: asciinema (brew install asciinema), agg (brew install agg).
#
# Usage:
#   HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=... ./scripts/record-demo.sh
#
# Output: docs/demo.cast + docs/demo.gif.
set -euo pipefail

if [ -z "${HELIUS_RPC_URL:-}" ]; then
  echo "HELIUS_RPC_URL required" >&2
  exit 1
fi

command -v asciinema >/dev/null || { echo "install asciinema: brew install asciinema" >&2; exit 1; }
command -v agg        >/dev/null || { echo "install agg: brew install agg"               >&2; exit 1; }

mkdir -p docs
CAST=docs/demo.cast
GIF=docs/demo.gif
rm -f "$CAST"

# Use `script` to drive a PTY that asciinema captures cleanly.
# The here-doc runs inside the recorded shell as if you typed it.
asciinema rec --idle-time-limit 1.5 --overwrite "$CAST" <<EOF
clear
echo '\$ pnpm smoke'
echo
HELIUS_RPC_URL='$HELIUS_RPC_URL' pnpm exec tsx scripts/smoke.ts
echo
echo 'open the two Solscan links above — your depositor wallet is not in accountKeys.'
sleep 3
exit
EOF

# Convert .cast → .gif. Theme + speed tuned for README hero.
agg --font-size 14 --speed 1.2 --theme monokai "$CAST" "$GIF"

echo
echo "wrote $GIF ($(du -h "$GIF" | cut -f1))"
echo "preview: open $GIF"
