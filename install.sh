#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
if [[ $# -ne 0 ]]; then
  echo "Usage: ./install.sh" >&2
  exit 1
fi
node scripts/source-install.mjs preflight
npm ci --ignore-scripts
node scripts/install-source.mjs
