#!/usr/bin/env bash
# Re-apply the two Hermes-side changes this widget needs, after `hermes update`
# stashed them and failed to restore them (or rebuilt the TUI from clean code).
#
# `hermes update` stashes tracked modifications before it pulls, and a failed
# restore leaves the checkout clean: the SDK hook disappears from both the
# source and the freshly built bundle, so the dock renders
# `Quota · needs Hermes SDK hook`. This script puts both back, and is safe to
# run at any time — it is a no-op once the hook is live in source and bundle.
#
# Exit codes: 0 ok (applied and/or already present), 2 patch would not apply
# cleanly (nothing written), 3 patch applied but a hunk failed, 4 rebuild ran
# but the bundle still lacks the hook, 5 prerequisites missing.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
AGENT_ROOT="${HERMES_AGENT_ROOT:-$HERMES_HOME_DIR/hermes-agent}"
UI_DIR="$AGENT_ROOT/ui-tui"
WIDGET_SOURCE="$UI_DIR/src/sdk/userWidgets.ts"
BUNDLE="$UI_DIR/dist/entry.js"
STATUS="$HERMES_HOME_DIR/runtime/quota-hook-status.json"
HOOK="useSessionProvider"

log() { printf '%s\n' "$*"; }

write_status() { # state, detail
  mkdir -p "$(dirname "$STATUS")"
  python3 - "$STATUS" "$1" "$2" <<'PY'
import json, sys, datetime
from pathlib import Path
path, state, detail = sys.argv[1], sys.argv[2], sys.argv[3]
Path(path).write_text(json.dumps({
  "state": state,
  "detail": detail,
  "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
}, indent=2) + "\n")
PY
}

[ -d "$UI_DIR" ] || { log "no ui-tui at $UI_DIR"; exit 5; }
[ -f "$WIDGET_SOURCE" ] || { log "no widget SDK at $WIDGET_SOURCE"; exit 5; }

patches=("$REPO_DIR"/patches/0001-*.patch "$REPO_DIR"/patches/0002-*.patch)
for p in "${patches[@]}"; do
  [ -f "$p" ] || { log "missing patch: $p"; exit 5; }
done

# Files the patches touch — used to sweep the `.orig` files BSD patch leaves.
touched_paths=()
while IFS= read -r path; do
  touched_paths+=("$path")
done < <(sed -n 's|^+++ b/||p' "${patches[@]}")

# --- 1. source: apply the patches only when the hook is absent ---------------
if grep -q "$HOOK" "$WIDGET_SOURCE"; then
  log "source: hook already present"
  source_state=present
else
  # A dry run first: if any hunk would reject, write NOTHING (upstream may have
  # reshaped these files). A half-applied tree is worse than the placeholder.
  for p in "${patches[@]}"; do
    if ! (cd "$AGENT_ROOT" && patch -p1 --dry-run --forward <"$p" >/dev/null 2>&1); then
      log "patch would not apply cleanly: $(basename "$p") — nothing written"
      write_status "conflict" "$(basename "$p") did not apply cleanly; apply it by hand"
      exit 2
    fi
  done
  for p in "${patches[@]}"; do
    (cd "$AGENT_ROOT" && patch -p1 --forward <"$p" >/dev/null) || {
      log "patch failed mid-way: $(basename "$p")"
      write_status "failed" "$(basename "$p") applied with rejects"
      exit 3
    }
  done
  # BSD patch leaves `<file>.orig` behind; it is noise in `git status`, not work.
  for f in "${touched_paths[@]}"; do rm -f "$AGENT_ROOT/$f.orig"; done
  grep -q "$HOOK" "$WIDGET_SOURCE" || { log "patched but the hook is still absent"; write_status "failed" "hook absent after patch"; exit 3; }
  log "source: hook re-applied"
  source_state=applied
fi

# --- 2. bundle: rebuild only when the built hook is missing ------------------
if grep -q "$HOOK" "$BUNDLE" 2>/dev/null; then
  log "bundle: hook already present"
  write_status "ok" "source=$source_state bundle=present"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  for d in "$HERMES_HOME_DIR"/tools/node-*/bin "$HERMES_HOME_DIR"/tools/npm-*/bin; do
    [ -d "$d" ] && PATH="$d:$PATH"
  done
fi
command -v npm >/dev/null 2>&1 || { log "npm not found"; write_status "failed" "npm not found"; exit 5; }

log "bundle: rebuilding the TUI…"
(cd "$UI_DIR" && npm run build) || { log "build failed"; write_status "failed" "npm run build failed"; exit 4; }

if ! grep -q "$HOOK" "$BUNDLE"; then
  log "built, but the hook is still absent from $BUNDLE"
  write_status "failed" "hook absent from the built bundle"
  exit 4
fi
log "bundle: rebuilt with the hook"
write_status "ok" "source=$source_state bundle=rebuilt"
exit 0
