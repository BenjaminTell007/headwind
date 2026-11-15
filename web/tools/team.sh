#!/bin/bash
# Shows the frontend team's notes (web/team/<name>.md) straight from GitHub.
#
# Each person's Claude writes only its own note, on its own branch, and pushes it.
# This script fetches every branch and prints the newest copy of everyone's note,
# so you can read each other without merging anything first.
#
#   web/tools/team.sh          everyone except me
#   web/tools/team.sh --all    include my own note
#   web/tools/team.sh --hash   just a fingerprint of the others' notes (used by hooks)
#
# "Me" is taken from the branch name: kimball's-branch -> kimball.
# Set HEADWAY_ME=<name> to override.

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
export GIT_TERMINAL_PROMPT=0
git fetch -q origin 2>/dev/null

branch=$(git rev-parse --abbrev-ref HEAD)
me="${HEADWAY_ME:-${branch%"'s-branch"}}"
mode="$1"

# One line per (note, branch): "<name>\t<commit time>\t<branch>"
list=$(
  git for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -v '^origin$' | grep -v '/HEAD$' |
  while IFS= read -r b; do
    git ls-tree --name-only "$b" web/team/ 2>/dev/null | while IFS= read -r f; do
      name=$(basename "$f" .md)
      [ "$name" = "README" ] && continue
      ts=$(git log -1 --format=%ct "$b" -- "$f")
      printf '%s\t%s\t%s\n' "$name" "$ts" "$b"
    done
  done
)

# Keep the newest copy of each person's note.
newest=$(printf '%s\n' "$list" | grep -v '^$' | sort -t$'\t' -k1,1 -k2,2nr | awk -F'\t' '!seen[$1]++')

out=""
while IFS=$'\t' read -r name ts b; do
  [ -z "$name" ] && continue
  [ "$mode" != "--all" ] && [ "$name" = "$me" ] && continue
  when=$(date -r "$ts" '+%H:%M %b %d' 2>/dev/null)
  out+="===== ${name} (from ${b}, updated ${when}) ====="$'\n'
  out+="$(git show "$b:web/team/$name.md")"$'\n\n'
done <<< "$newest"

if [ "$mode" = "--hash" ]; then
  printf '%s' "$out" | shasum | cut -c1-12
else
  printf '%s' "${out:-No notes from the team yet.}"$'\n'
fi
