# Headway

A tool for forecasting and hedging trade disruptions. It tracks what countries ship each other and the real ships moving it through the world's straits and canals, and lets anyone take positions on what happens next in markets that settle onchain on Monad against official trade and shipping data.

Built for Monad Blitz, November 15, 2026.

## What's in here

| Folder | What it is |
|---|---|
| `BRIEF.md` | The full idea: problem, product, economics, look and feel, demo and pitch |
| `PLAN.md` | Who builds what today, the interfaces we agreed on, and the timeline |
| `data/` | All the data, already processed. `data/README.md` explains every file and every caveat |
| `scripts/` | The Python that pulled and built the data, plus the live ship logger |
| `server/` | FastAPI server: serves the data and live ships, will hold the faucet and market keeper |
| `contracts/` | Markets and faucet contracts for Monad testnet (spec in `contracts/README.md`) |
| `web/` | The page |
| `design/` | Colours, type and the logo |

## Getting started

```bash
git clone https://github.com/kimballw1/Headway.git
```

```bash
cd Headway
```

Python (for the server and the data scripts):

```bash
python3 -m venv ~/.venvs/chokepoint
```

```bash
~/.venvs/chokepoint/bin/python -m pip install -r requirements.txt
```

The processed data is committed, so you don't need to rerun the pipeline. To rebuild it anyway:

```bash
zsh scripts/run_all.sh
```

Run the server and open the starter page: see `server/README.md` and `web/README.md`.

## Data sources

IMF PortWatch (daily transits for 28 straits and canals, port calls, the port network), UN Comtrade (US trade by partner and product, lane cargo mix), aisstream.io (live ship positions), Open-Meteo (weather at sea), `searoute` (sea lane geometry) and Natural Earth (country outlines). Details and caveats in `data/README.md`.

## Secrets

The aisstream key and any private keys go in `.env` in the repo root, which git ignores. Never commit them.
