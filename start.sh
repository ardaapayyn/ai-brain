#!/usr/bin/env sh
# AI Brain - avvio automatico su Linux/macOS (richiede Node.js 20.10+).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js non trovato: installalo da https://nodejs.org (LTS) e rilancia." >&2
  exit 1
fi
exec node scripts/setup.mjs "$@"
