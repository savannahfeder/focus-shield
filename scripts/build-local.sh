#!/usr/bin/env bash
# Builds the extension into dist/ with your own OpenAI key baked in, so the
# bouncer asks OpenAI directly and no server is needed. dist/ is gitignored;
# never upload this build to the Chrome Web Store, since it carries the key.
#
# The key comes from OPENAI_API_KEY if set, otherwise from the macOS Keychain
# item OPENAI_API_KEY. FOCUS_SHIELD_MODEL picks another model.
set -euo pipefail
cd "$(dirname "$0")/../client"

key="${OPENAI_API_KEY:-}"
if [ -z "$key" ] && command -v security >/dev/null; then
  key="$(security find-generic-password -s OPENAI_API_KEY -w 2>/dev/null || true)"
fi
if [ -z "$key" ]; then
  echo "No OpenAI key: set OPENAI_API_KEY or add it to the Keychain as OPENAI_API_KEY." >&2
  exit 1
fi

[ -d node_modules ] || npm ci
VITE_OPENAI_API_KEY="$key" VITE_OPENAI_MODEL="${FOCUS_SHIELD_MODEL:-}" npm run build
echo "Built ../dist. In chrome://extensions, Load unpacked (or reload) that folder."
