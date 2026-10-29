#!/usr/bin/env bash
set -euo pipefail
app_dir=${APP_DIR:-/opt/clipflow}
runtime_dir="$app_dir/hypit-runtime"
source_dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$runtime_dir/bin"
cp "$source_dir/package.json" "$runtime_dir/package.json"
if [ -f "$source_dir/package-lock.json" ]; then cp "$source_dir/package-lock.json" "$runtime_dir/package-lock.json"; fi
npm install --prefix "$runtime_dir" --omit=dev --legacy-peer-deps --no-audit --no-fund --registry=https://registry.npmjs.org
cat > "$runtime_dir/bin/hypit" <<'LAUNCH'
#!/bin/sh
runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export PATH="$runtime_dir/node_modules/node/bin:$PATH"
exec "$runtime_dir/node_modules/node/bin/node" "$runtime_dir/node_modules/@hypit/hypit/bin/hypit.mjs" "$@"
LAUNCH
chmod 755 "$runtime_dir/bin/hypit"
if id clipflow >/dev/null 2>&1; then chown -R clipflow:clipflow "$runtime_dir"; fi
"$runtime_dir/bin/hypit" version --json
