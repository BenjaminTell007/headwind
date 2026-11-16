#!/bin/zsh
# Rebuild all the data from scratch, in order.
# The Comtrade steps are slow because of the free API's quota, but they cache
# every call, so rerunning only fetches what's missing.
#
#   zsh scripts/run_all.sh
#
# The live ship steps are separate (they need an aisstream key):
#   export AISSTREAM_API_KEY=...
#   ~/.venvs/chokepoint/bin/python -I scripts/ais_logger.py      # leave running
#   ~/.venvs/chokepoint/bin/python -I scripts/tune_gates.py      # after a few hours
#   ~/.venvs/chokepoint/bin/python -I scripts/summarize_live.py
#   ~/.venvs/chokepoint/bin/python -I scripts/build_markets.py

set -e
cd "$(dirname "$0")/.."
PY=~/.venvs/chokepoint/bin/python

$PY -I scripts/pull_portwatch.py
$PY -I scripts/pull_portwatch_ports.py
$PY -I scripts/pull_portwatch_network.py
$PY -I scripts/build_lanes.py
$PY -I scripts/build_routes.py
$PY -I scripts/build_efficiency.py
$PY -I scripts/build_country_trade.py
$PY -I scripts/add_chokepoint_gates.py
$PY -I scripts/build_overview.py
$PY -I scripts/build_ports_events.py
$PY -I scripts/pull_weather.py
$PY -I -u scripts/pull_comtrade.py
$PY -I scripts/build_trade.py
$PY -I scripts/build_countries.py
$PY -I scripts/build_markets.py
$PY -I -u scripts/pull_lane_cargo.py
