"""Turn the raw Comtrade pull into the trade-pair file the page loads.

Inputs (data/raw/comtrade/, from pull_comtrade.py):
  us_totals_by_partner.csv, us_hs2_top_partners.csv, partnerAreas.json, HS.json

Output:
  data/processed/us_trade_pairs.json
    for each partner: name, ISO3, monthly US imports and exports,
    last-12-month totals and balance, and the product mix both ways by
    HS chapter and by HS section (sections are what the ribbon bands use)
  data/processed/us_partner_totals.csv
    monthly totals for every partner (for the trade-pair markets)

Values are US-reported, in US dollars (Comtrade primaryValue).
Note: Comtrade lists Taiwan as "Other Asia, nes" (code 490). I relabel it.

Run:  ~/.venvs/chokepoint/bin/python -I scripts/build_trade.py
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "comtrade"
OUT = ROOT / "data" / "processed"

# HS sections by chapter range. Short names for the ribbon bands.
SECTIONS = [
    (1, 5, "Animals & animal products"),
    (6, 14, "Vegetables & crops"),
    (15, 15, "Fats & oils"),
    (16, 24, "Food, drinks & tobacco"),
    (25, 27, "Minerals & fuels"),
    (28, 38, "Chemicals & pharma"),
    (39, 40, "Plastics & rubber"),
    (41, 43, "Leather & hides"),
    (44, 46, "Wood"),
    (47, 49, "Paper"),
    (50, 63, "Textiles & clothing"),
    (64, 67, "Footwear & headgear"),
    (68, 70, "Stone, ceramics & glass"),
    (71, 71, "Precious stones & metals"),
    (72, 83, "Base metals"),
    (84, 85, "Machinery & electronics"),
    (86, 89, "Vehicles, aircraft & ships"),
    (90, 92, "Instruments, clocks & watches"),
    (93, 93, "Arms"),
    (94, 96, "Furniture, toys & misc."),
    (97, 99, "Art & special categories"),
]


def section_for(chapter):
    n = int(chapter)
    for lo, hi, name in SECTIONS:
        if lo <= n <= hi:
            return name
    return "Other"


def main():
    partners = pd.DataFrame(json.loads((RAW / "partnerAreas.json").read_text())["results"])
    partners = partners.set_index("id")
    names = partners["text"].str.strip().to_dict()
    iso3 = partners["PartnerCodeIsoAlpha3"].to_dict()
    names[490] = "Taiwan"
    iso3[490] = "TWN"

    hs = pd.DataFrame(json.loads((RAW / "HS.json").read_text())["results"])
    chapters = hs[hs["aggrLevel"] == 2].set_index("id")["text"]
    # "84 - Machinery and ..." -> "Machinery and ..."
    chapter_names = chapters.str.split(" - ", n=1).str[1].to_dict()

    totals = pd.read_csv(RAW / "us_totals_by_partner.csv", dtype={"period": str})
    totals["partner"] = totals["partnerCode"].map(names)
    totals["iso3"] = totals["partnerCode"].map(iso3)
    totals["month"] = totals["period"].str[:4] + "-" + totals["period"].str[4:]
    totals["flow"] = totals["flowCode"].map({"M": "imports", "X": "exports"})
    wide = totals.pivot_table(index=["partnerCode", "partner", "iso3", "month"], columns="flow",
                              values="primaryValue", aggfunc="sum").reset_index()
    wide.to_csv(OUT / "us_partner_totals.csv", index=False)

    months = sorted(totals["month"].unique())
    last12 = months[-12:]

    hs2 = pd.read_csv(RAW / "us_hs2_top_partners.csv", dtype={"period": str, "cmdCode": str})
    hs2["cmdCode"] = hs2["cmdCode"].str.zfill(2)
    hs2["month"] = hs2["period"].str[:4] + "-" + hs2["period"].str[4:]
    hs2 = hs2[hs2["cmdCode"].str.fullmatch(r"\d\d")]
    hs2["flow"] = hs2["flowCode"].map({"M": "imports", "X": "exports"})
    hs2["section"] = hs2["cmdCode"].apply(section_for)

    out = {
        "source": "UN Comtrade, US-reported monthly trade, USD",
        "months": months,
        "last12": [last12[0], last12[-1]],
        "partners": {},
    }

    for code in sorted(hs2["partnerCode"].unique()):
        mine = wide[wide["partnerCode"] == code].set_index("month").reindex(months)
        recent = hs2[(hs2["partnerCode"] == code) & hs2["month"].isin(last12)]

        def mix(flow, level):
            part = recent[recent["flow"] == flow]
            if level == "chapter":
                grouped = part.groupby("cmdCode")["primaryValue"].sum().sort_values(ascending=False)
                total = grouped.sum()
                return [{"hs2": c, "name": chapter_names.get(c, c), "section": section_for(c),
                         "value": round(float(v)), "share": round(float(v / total), 4)}
                        for c, v in grouped.items() if v > 0]
            grouped = part.groupby("section")["primaryValue"].sum().sort_values(ascending=False)
            total = grouped.sum()
            return [{"section": s, "value": round(float(v)), "share": round(float(v / total), 4)}
                    for s, v in grouped.items() if v > 0]

        def monthly_by_section(flow):
            """Section -> one value per month, for every month in `months`."""
            part = hs2[(hs2["partnerCode"] == code) & (hs2["flow"] == flow)]
            table = part.pivot_table(index="month", columns="section", values="primaryValue", aggfunc="sum")
            table = table.reindex(months).fillna(0)
            return {section: [round(float(v)) for v in table[section]] for section in table.columns}

        def monthly_chapter(flow, chapter):
            part = hs2[(hs2["partnerCode"] == code) & (hs2["flow"] == flow) & (hs2["cmdCode"] == chapter)]
            series = part.groupby("month")["primaryValue"].sum().reindex(months).fillna(0)
            return [round(float(v)) for v in series]

        imports_12 = float(mine.loc[last12, "imports"].sum())
        exports_12 = float(mine.loc[last12, "exports"].sum())
        out["partners"][names.get(code, str(code))] = {
            "code": int(code),
            "iso3": iso3.get(code),
            "monthly_imports": [None if pd.isna(v) else round(float(v)) for v in mine["imports"]],
            "monthly_exports": [None if pd.isna(v) else round(float(v)) for v in mine["exports"]],
            "last12_imports": round(imports_12),
            "last12_exports": round(exports_12),
            "last12_balance": round(exports_12 - imports_12),
            "imports_by_section": mix("imports", "section"),
            "exports_by_section": mix("exports", "section"),
            "imports_by_chapter": mix("imports", "chapter"),
            "exports_by_chapter": mix("exports", "chapter"),
            "monthly_imports_by_section": monthly_by_section("imports"),
            "monthly_exports_by_section": monthly_by_section("exports"),
            # Chapter 71 (gold and precious metals) swings a lot and can swamp
            # everything else, so keep it separately to show trade with and without it.
            "monthly_imports_ch71": monthly_chapter("imports", "71"),
            "monthly_exports_ch71": monthly_chapter("exports", "71"),
        }

    (OUT / "us_trade_pairs.json").write_text(json.dumps(out))

    # Summary to eyeball.
    rows = []
    for name, p in out["partners"].items():
        top_import = p["imports_by_section"][0]["section"] if p["imports_by_section"] else ""
        rows.append({"partner": name, "imports_12m_bn": round(p["last12_imports"] / 1e9, 1),
                     "exports_12m_bn": round(p["last12_exports"] / 1e9, 1),
                     "balance_bn": round(p["last12_balance"] / 1e9, 1), "top_import_section": top_import})
    print(f"Last 12 months: {last12[0]} to {last12[-1]}")
    print(pd.DataFrame(rows).sort_values("imports_12m_bn", ascending=False).to_string(index=False))


if __name__ == "__main__":
    main()
