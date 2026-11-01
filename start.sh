#!/usr/bin/env bash
# Spusti appku. Pouzije Node nainstalovany v ~/.local/share/node, ak systemovy nestaci.
set -euo pipefail
cd "$(dirname "$0")"

local_node="$HOME/.local/share/node/current/bin"
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$major" -lt 24 ] && [ -x "$local_node/node" ]; then
  export PATH="$local_node:$PATH"
fi

[ -d node_modules ] || npm ci
npm start
