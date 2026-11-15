#!/bin/bash
# Stamp a new site version, so open pages and cached browsers pick up a deploy.
#
# Run this right before merging into main (or as the last commit on frontend):
#     web/tools/stamp.sh
#
# What it does:
#   1. picks a version from the clock, like 20261115T2130
#   2. writes it to web/version.json
#   3. puts it on every local script/style link (?v=...) and in the page's
#      SITE_VERSION, in the root index.html and every web/*.html
#
# Each page checks web/version.json (always fetched fresh) when it opens and when
# you come back to the tab. If the published version is newer than the page's own,
# the page reloads once onto it, so nobody is stuck on a cached copy.

cd "$(git rev-parse --show-toplevel)" || exit 1
V=$(date -u +%Y%m%dT%H%M)

printf '{"v":"%s"}\n' "$V" > web/version.json

for f in index.html web/*.html; do
  [ -f "$f" ] || continue
  sed -i '' -E \
    -e "s/(\.(js|css))\?v=[0-9A-Za-z]+\"/\1?v=$V\"/g" \
    -e "s/SITE_VERSION = '[0-9A-Za-z]*'/SITE_VERSION = '$V'/" \
    "$f"
done

echo "stamped $V"
grep -l "SITE_VERSION = '$V'" index.html web/*.html 2>/dev/null | sed 's/^/  self-updating: /'
