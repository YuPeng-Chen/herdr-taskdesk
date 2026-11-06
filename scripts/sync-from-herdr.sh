#!/bin/sh
# Copy the live taskdesk files from the Herdr home into this repo, then show what changed.
# The layout is read from <home>/layouts/$TASKDESK_LAYOUT.json (default: shepherdr-lite)
# and written as layouts/taskdesk.json.
set -eu

if [ -z "${HERDR_APP_HOME:-}" ]; then
    HERDR_APP_HOME="${USERPROFILE:-$HOME}/.config/herdr-app"
fi
LAYOUT="${TASKDESK_LAYOUT:-shepherdr-lite}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

cp "$HERDR_APP_HOME/layouts/$LAYOUT.json" "$REPO/layouts/taskdesk.json"

for dir in "$REPO"/mods/*/; do
    name="$(basename "$dir")"
    for file in main.js mod.json card.js changes.svg; do
        if [ -f "$HERDR_APP_HOME/mods/$name/$file" ]; then
            cp "$HERDR_APP_HOME/mods/$name/$file" "$dir$file"
        fi
    done
done

if ! cmp -s "$REPO/mods/lite-card/card.js" "$REPO/mods/lite-agents/card.js"; then
    echo "warning: lite-card/card.js and lite-agents/card.js differ; they must be identical" >&2
fi

git -C "$REPO" status --short
