"""Forecast weekly strait transits for the page's stats section.

Reads data/processed/chokepoint_weekly.json (IMF PortWatch transits per strait per
week) and writes web/data/forecast.json with:

  - an 8-week forecast for every busy strait, with 5/25/50/75/95% quantiles
  - the model's probability for each weekly strait market in market_seeds.json
  - a backtest on the last 26 weeks against a "same as last week" baseline
  - which inputs the model leans on (permutation importance)
  - history for the charts (two years of weekly totals and the vessel mix)

The model is gradient-boosted trees, the same family as LightGBM, using
scikit-learn's HistGradientBoostingRegressor (LightGBM isn't installed here and
this needs no extra install). One model per horizon (1 to 8 weeks ahead) and per
quantile, all straits pooled so quiet straits borrow strength from busy ones.
The target is the log change from this week, so a strait's size doesn't matter.

Run from the repo root:
    /opt/anaconda3/bin/python web/tools/forecast.py
"""

import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance

ROOT = Path(__file__).resolve().parents[2]
WEEKLY = ROOT / "data" / "processed" / "chokepoint_weekly.json"
SEEDS = ROOT / "data" / "processed" / "market_seeds.json"
INDEX = ROOT / "data" / "processed" / "efficiency_index.json"
OUT = ROOT / "web" / "data" / "forecast.json"

HORIZONS = range(1, 9)
QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95]
MIN_WEEKLY = 20          # skip straits with fewer ships than this in a typical week
BACKTEST_WEEKS = 26
VESSELS = ["container", "tanker", "dry_bulk", "general_cargo", "roro"]


def load_panel():
    """One row per strait per week: total and vessel counts."""
    raw = json.loads(WEEKLY.read_text())
    frames = []
    for name, d in raw.items():
        df = pd.DataFrame({"week": pd.to_datetime(d["week_ending"]), "total": d["total"]})
        for v in VESSELS:
            df[v] = d.get(v, [0] * len(df))
        df["strait"] = name
        frames.append(df)
    panel = pd.concat(frames, ignore_index=True)

    typical = panel.groupby("strait")["total"].median()
    busy = typical[typical >= MIN_WEEKLY].index
    panel = panel[panel["strait"].isin(busy)].copy()
    return panel.sort_values(["strait", "week"]).reset_index(drop=True), raw


def add_features(panel, world_eff):
    """Features known at the end of week t, for predicting week t + h."""
    out = []
    for name, df in panel.groupby("strait"):
        df = df.copy()
        y = np.log1p(df["total"])
        df["y"] = y
        # recent level and momentum, all relative to this week so size drops out
        for lag in [1, 2, 3, 4, 8]:
            df[f"chg_{lag}"] = y - y.shift(lag)
        df["vs_mean_4"] = y - y.rolling(4).mean()
        df["vs_mean_13"] = y - y.rolling(13).mean()
        df["vs_mean_52"] = y - y.rolling(52).mean()
        df["vs_last_year"] = y - y.shift(52)
        df["vol_13"] = y.diff().rolling(13).std()
        # what's going through it
        tot = df["total"].replace(0, np.nan)
        df["share_container"] = df["container"] / tot
        df["share_tanker"] = df["tanker"] / tot
        df["share_bulk"] = df["dry_bulk"] / tot
        # season
        woy = df["week"].dt.isocalendar().week.astype(float)
        df["season_sin"] = np.sin(2 * np.pi * woy / 52.18)
        df["season_cos"] = np.cos(2 * np.pi * woy / 52.18)
        # the world: how efficient shipping routes are overall this week
        df["world_eff"] = df["week"].map(world_eff)
        df["world_eff_chg_4"] = df["world_eff"] - df["world_eff"].shift(4)
        # targets: log change h weeks ahead
        for h in HORIZONS:
            df[f"target_{h}"] = y.shift(-h) - y
        out.append(df)
    feat = pd.concat(out, ignore_index=True)
    feat["strait_code"] = feat["strait"].astype("category").cat.codes
    return feat


FEATURES = [
    "chg_1", "chg_2", "chg_3", "chg_4", "chg_8",
    "vs_mean_4", "vs_mean_13", "vs_mean_52", "vs_last_year", "vol_13",
    "share_container", "share_tanker", "share_bulk",
    "season_sin", "season_cos", "world_eff", "world_eff_chg_4", "strait_code",
]
FEATURE_LABELS = {
    "chg_1": "Change vs last week", "chg_2": "Change vs 2 weeks ago", "chg_3": "Change vs 3 weeks ago",
    "chg_4": "Change vs 4 weeks ago", "chg_8": "Change vs 8 weeks ago",
    "vs_mean_4": "Vs 4-week average", "vs_mean_13": "Vs 13-week average", "vs_mean_52": "Vs 52-week average",
    "vs_last_year": "Vs same week last year", "vol_13": "Recent volatility",
    "share_container": "Container share", "share_tanker": "Tanker share", "share_bulk": "Dry bulk share",
    "season_sin": "Time of year", "season_cos": "Time of year (2)",
    "world_eff": "World route efficiency", "world_eff_chg_4": "World efficiency, 4-week change",
    "strait_code": "Which strait",
}


def make_model(q):
    return HistGradientBoostingRegressor(
        loss="quantile", quantile=q,
        max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=40,
        l2_regularization=1.0, categorical_features=[FEATURES.index("strait_code")],
        random_state=0,
    )


def fit_models(train):
    """models[h][q] for every horizon and quantile."""
    models = {}
    for h in HORIZONS:
        rows = train.dropna(subset=[f"target_{h}"])
        X, y = rows[FEATURES], rows[f"target_{h}"]
        models[h] = {}
        for q in QUANTILES:
            models[h][q] = make_model(q).fit(X, y)
    return models


def predict(models, X):
    """Quantile predictions of log change, sorted so the quantiles never cross."""
    out = {}
    for h, by_q in models.items():
        preds = np.column_stack([by_q[q].predict(X) for q in QUANTILES])
        out[h] = np.sort(preds, axis=1)
    return out


def prob_at_least(level_now, quantile_changes, threshold):
    """P(count >= threshold), reading the CDF off the predicted quantiles."""
    counts = np.expm1(np.log1p(level_now) + quantile_changes)
    probs_below = np.array(QUANTILES)
    # extend the tails a little so thresholds outside the 5-95% range still get a number
    xs = np.concatenate([[counts[0] - (counts[1] - counts[0]) * 2], counts, [counts[-1] + (counts[-1] - counts[-2]) * 2]])
    ps = np.concatenate([[0.005], probs_below, [0.995]])
    p_below = float(np.interp(threshold - 0.5, xs, ps))
    return round(1 - p_below, 3)


def main():
    panel, raw = load_panel()
    eff = json.loads(INDEX.read_text())
    world_eff = pd.Series(eff["world"], index=pd.to_datetime(eff["weeks"]))
    feat = add_features(panel, world_eff)
    feat = feat.dropna(subset=["vs_mean_52", "vol_13"])
    last_week = feat["week"].max()
    print(f"{feat['strait'].nunique()} straits, {len(feat)} strait-weeks, data to {last_week.date()}")

    # ---------- backtest: train before the last 26 weeks, score on them ----------
    cutoff = last_week - pd.Timedelta(weeks=BACKTEST_WEEKS)
    train = feat[feat["week"] <= cutoff - pd.Timedelta(weeks=max(HORIZONS))]
    test = feat[feat["week"] > cutoff]
    bt_models = fit_models(train)
    bt_preds = predict(bt_models, test[FEATURES])
    backtest = []
    widen = {}
    for h in HORIZONS:
        ok = test[f"target_{h}"].notna().to_numpy()
        actual_chg = test[f"target_{h}"].to_numpy()[ok]
        level = test["total"].to_numpy()[ok]
        actual = np.expm1(np.log1p(level) + actual_chg)
        med = np.expm1(np.log1p(level) + bt_preds[h][ok, 2])
        lo = np.expm1(np.log1p(level) + bt_preds[h][ok, 0])
        hi = np.expm1(np.log1p(level) + bt_preds[h][ok, 4])
        # Conformal widening (CQR): how far outside the raw 5-95% band the actual log change
        # landed, at the 90th percentile. Added to both ends of every future band, so the
        # band covers ~90% on data like the backtest.
        a = actual_chg
        score = np.maximum(bt_preds[h][ok, 0] - a, a - bt_preds[h][ok, 4])
        widen[h] = float(np.quantile(score, 0.9))
        lo_c = np.expm1(np.log1p(level) + bt_preds[h][ok, 0] - widen[h])
        hi_c = np.expm1(np.log1p(level) + bt_preds[h][ok, 4] + widen[h])
        # WAPE: total absolute error over total ships, so busy straits count for more
        backtest.append({
            "h": h,
            "n": int(ok.sum()),
            "wape_model": round(float(np.sum(np.abs(med - actual)) / np.sum(actual)) * 100, 1),
            "wape_naive": round(float(np.sum(np.abs(level - actual)) / np.sum(actual)) * 100, 1),
            "coverage_90_raw": round(float(np.mean((actual >= lo) & (actual <= hi))) * 100, 1),
            "coverage_90_calibrated": round(float(np.mean((actual >= lo_c) & (actual <= hi_c))) * 100, 1),
        })
        b = backtest[-1]
        print(f"h={h}: WAPE model {b['wape_model']}% vs naive {b['wape_naive']}%, "
              f"90% band covers {b['coverage_90_raw']}% raw, {b['coverage_90_calibrated']}% calibrated")

    # ---------- final models on everything ----------
    models = fit_models(feat)
    latest = feat[feat["week"] == last_week].copy()
    preds = predict(models, latest[FEATURES])
    for h in HORIZONS:
        # widen the outer quantiles by the full conformal amount and the inner ones by half
        preds[h][:, 0] -= widen[h]
        preds[h][:, 1] -= widen[h] / 2
        preds[h][:, 3] += widen[h] / 2
        preds[h][:, 4] += widen[h]

    # what the 1-week median model leans on
    rows = feat.dropna(subset=["target_1"]).sample(n=min(6000, len(feat)), random_state=0)
    imp = permutation_importance(models[1][0.5], rows[FEATURES], rows["target_1"], n_repeats=5, random_state=0)
    importance = sorted(
        ({"feature": FEATURE_LABELS[f], "value": round(float(v), 5)} for f, v in zip(FEATURES, imp.importances_mean)),
        key=lambda d: -d["value"],
    )
    # merge the two "time of year" terms
    tot_season = sum(d["value"] for d in importance if d["feature"].startswith("Time of year"))
    importance = [d for d in importance if not d["feature"].startswith("Time of year")] + [{"feature": "Time of year", "value": round(tot_season, 5)}]
    importance.sort(key=lambda d: -d["value"])

    # ---------- per strait: history and forecast ----------
    straits = {}
    for k, (_, row) in enumerate(latest.iterrows()):
        name = row["strait"]
        hist = panel[panel["strait"] == name].tail(104)
        level = float(row["total"])
        fc = []
        for h in HORIZONS:
            counts = np.expm1(np.log1p(level) + preds[h][k])
            fc.append({
                "week": (last_week + pd.Timedelta(weeks=h)).date().isoformat(),
                "q": [round(float(c), 1) for c in counts],
            })
        p_up = prob_at_least(level, preds[1][k], level + 0.5)
        mix = hist.tail(52)
        straits[name] = {
            "weeks": [d.date().isoformat() for d in hist["week"]],
            "total": [int(x) for x in hist["total"]],
            "mix": {v: [int(x) for x in mix[v]] for v in VESSELS},
            "forecast": fc,
            "p_up_next_week": p_up,
            "median_next": fc[0]["q"][2],
        }

    # ---------- the model's odds for each weekly strait market ----------
    seeds = json.loads(SEEDS.read_text())
    market_odds = []
    for m in seeds.get("weekly", []):
        name = m["series"].split(":")[1]
        if name not in straits:
            continue
        k = list(latest["strait"]).index(name)
        week_end = pd.Timestamp(m["week"][1])
        h = int(round((week_end - last_week).days / 7))
        if h not in preds:
            continue
        p = prob_at_least(float(latest.iloc[k]["total"]), preds[h][k], m["threshold"])
        if not m.get("is_above", True):
            p = round(1 - p, 3)
        market_odds.append({
            "id": m["id"], "strait": name, "question": m["question"], "threshold": m["threshold"],
            "weeks_ahead": h, "model_p_yes": p, "last_8_weeks": m.get("last_8_weeks", []),
        })

    # ---------- ridgeline: weekly totals for the busiest straits, 2019 to now ----------
    busiest = panel.groupby("strait")["total"].median().sort_values(ascending=False).head(16).index
    ridge = {}
    for name in busiest:
        s = panel[panel["strait"] == name]
        ridge[name] = [int(x) for x in s["total"]]
    ridge_weeks = [d.date().isoformat() for d in panel[panel["strait"] == busiest[0]]["week"]]

    out = {
        "made": date.today().isoformat(),
        "data_to": last_week.date().isoformat(),
        "model": "Gradient-boosted trees (HistGradientBoostingRegressor, LightGBM-style), quantile loss, one model per horizon and quantile, all straits pooled",
        "quantiles": QUANTILES,
        "backtest": backtest,
        "backtest_note": "Trained on data up to 34 weeks before the end, scored on the last 26 weeks. WAPE = total absolute error / total ships. Naive = same as the latest week. Calibrated coverage is measured on the same 26 weeks used to set the widening, so it is optimistic.",
        "importance": importance,
        "straits": straits,
        "market_odds": market_odds,
        "ridge": {"weeks": ridge_weeks, "series": ridge},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB), {len(market_odds)} market odds")


if __name__ == "__main__":
    main()
