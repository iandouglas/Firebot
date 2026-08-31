#!/usr/bin/env bash
#
# start.sh — build and launch the Firebot fork (with YouTube integration).
#
# Equivalent to `npm start` (grunt prep && electron . --dev) but with helpful
# preflight checks for the things this fork needs to boot (deps + secrets.json),
# plus a self-heal for vite 8's rolldown native binding (npm's optional-deps bug).
#
# Run from anywhere; it always operates from the repo root.

set -euo pipefail

# Always run from the repo root (the directory this script lives in).
cd "$(dirname "$0")"

echo "==> Firebot (YouTube fork) launcher"

# 1. Node / npm present?
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node is not installed or not on PATH." >&2
    exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm is not installed or not on PATH." >&2
    exit 1
fi
echo "    node: $(node -v)   npm: $(npm -v)"

# 2. Dependencies installed?
if [ ! -d node_modules ]; then
    echo "==> node_modules not found; installing dependencies (npm ci)..."
    npm ci
    npm rebuild
else
    echo "==> node_modules present; skipping install."
fi

# 3. Self-heal the rolldown native binding. Vite 8 bundles with rolldown, whose
#    platform binary is an optional dependency that npm sometimes skips (the
#    "Cannot find native binding" error). Install the right one if it's missing.
BINDING="$(node -e '
    const os = require("os");
    const p = require("./node_modules/rolldown/package.json");
    const opt = p.optionalDependencies || {};
    const plat = os.platform();
    const arch = os.arch();
    const key = Object.keys(opt).find(k => k.includes("-" + plat + "-" + arch) && !k.includes("musl"));
    if (key) console.log(key + "@" + opt[key]);
' 2>/dev/null || true)"
if [ -n "$BINDING" ]; then
    BINDING_NAME="${BINDING%@*}"
    if [ ! -d "node_modules/@rolldown/${BINDING_NAME#@rolldown/}" ]; then
        echo "==> Installing missing rolldown native binding: $BINDING"
        npm install --no-save "$BINDING"
    fi
fi

# 4. secrets.json present? Firebot refuses to boot without it.
if [ ! -f src/secrets.json ]; then
    echo "WARNING: src/secrets.json is missing. Firebot will not boot." >&2
    echo "         Create it from src/secrets.template.json and fill in the keys." >&2
    echo "         See SETUP.md section 2." >&2
fi

# 5. Build (compiles TypeScript -> build/, SCSS, vite, index.html).
echo "==> Building (grunt prep)..."
npx grunt prep

# 6. Launch.
echo "==> Launching Firebot..."
exec ./node_modules/.bin/electron . --dev
