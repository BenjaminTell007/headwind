#!/bin/bash
# Keeps the Headway repo in sync with GitHub during Claude Code sessions,
# and shows Claude the other frontend Claude's note when it changes.
# Install: see "Auto-sync hook" in web/CLAUDE.md.
#
#   headway-sync.sh pull     pull the latest from GitHub (session start, each prompt)
#   headway-sync.sh commit   after Claude edits a file: commit that one file and push it
#                            to the current branch (never main or frontend directly)
#
# Reads the hook's JSON on stdin. Only acts on files inside the Headway repo,
# never commits anything git ignores (PRIVATE.md, logs), never force-pushes.

REPO="${HEADWAY_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
LOCK="/tmp/headway-sync.lock"
export GIT_TERMINAL_PROMPT=0

[ -d "$REPO/.git" ] || exit 0
cd "$REPO" || exit 0

# One sync at a time, so back-to-back edits don't trip over git's own lock.
for i in $(seq 1 30); do
  mkdir "$LOCK" 2>/dev/null && break
  sleep 1
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

message() {
  # Shown to the user in Claude Code.
  /usr/bin/python3 -c 'import json,sys; print(json.dumps({"systemMessage": sys.argv[1]}))' "$1"
}

case "$1" in
  pull)
    event=$(/usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("hook_event_name",""))' 2>/dev/null)
    branch=$(git rev-parse --abbrev-ref HEAD)
    git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1 || exit 0
    if ! git pull --rebase=merges --autostash -q origin "$branch" 2>/tmp/headway-sync.err; then
      git rebase --abort 2>/dev/null
      message "Headway: pulling $branch from GitHub failed ($(head -c 200 /tmp/headway-sync.err | tr '\n' ' ')). Nothing was changed; sort it out before editing."
      exit 0
    fi
    # Teammate notes (web/team/*.md on any branch): hand them to Claude when they change.
    if [ -x web/tools/team.sh ] && { [ "$event" = "UserPromptSubmit" ] || [ "$event" = "SessionStart" ]; }; then
      seen_file="$REPO/.git/team-notes-seen"
      h=$(web/tools/team.sh --hash 2>/dev/null)
      if [ -n "$h" ] && [ "$h" != "da39a3ee5e6b" ] && [ "$h" != "$(cat "$seen_file" 2>/dev/null)" ]; then
        echo "$h" > "$seen_file"
        notes=$(web/tools/team.sh 2>/dev/null | head -c 6000)
        /usr/bin/python3 -c '
import json, sys
ev, notes = sys.argv[1], sys.argv[2]
print(json.dumps({
  "systemMessage": "Headway: the other frontend Claude updated its note.",
  "hookSpecificOutput": {"hookEventName": ev, "additionalContext":
    "The other frontend Claude updated its note in web/team/. Read it, follow web/CLAUDE.md, answer any Asks addressed to you in your own note (web/team/<your name>.md), and tell your human about anything that affects them.\n\n" + notes}
}))' "$event" "$notes"
      fi
    fi
    ;;

  commit)
    file=$(/usr/bin/python3 -c '
import json, sys
d = json.load(sys.stdin)
ti = d.get("tool_input") or {}
tr = d.get("tool_response") or {}
print(ti.get("file_path") or ti.get("notebook_path") or (tr.get("filePath") if isinstance(tr, dict) else "") or "")
' 2>/dev/null)
    case "$file" in
      "$REPO"/*) ;;
      *) exit 0 ;;
    esac
    rel="${file#$REPO/}"
    branch=$(git rev-parse --abbrev-ref HEAD)
    # Work happens on personal branches (kimball's-branch -> frontend -> main).
    # Never auto-commit straight onto frontend or main.
    case "$branch" in main|frontend|HEAD) message "Headway: on $branch, so $rel was not auto-committed. Switch to your own branch."; exit 0 ;; esac
    [ "$(basename "$rel")" = "PRIVATE.md" ] && exit 0
    git check-ignore -q "$rel" && exit 0
    git add -- "$rel" 2>/dev/null || exit 0
    git diff --cached --quiet && exit 0
    git commit -q -m "Update $rel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" || exit 0
    if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1 && ! git pull --rebase=merges --autostash -q origin "$branch" 2>/tmp/headway-sync.err; then
      git rebase --abort 2>/dev/null
      message "Headway: committed $rel but couldn't pull before pushing ($(head -c 200 /tmp/headway-sync.err | tr '\n' ' ')). The commit is local only."
      exit 0
    fi
    if ! git push -q -u origin "$branch" 2>/tmp/headway-sync.err; then
      message "Headway: committed $rel but the push failed ($(head -c 200 /tmp/headway-sync.err | tr '\n' ' ')). The commit is local only."
    fi
    ;;
esac
exit 0
