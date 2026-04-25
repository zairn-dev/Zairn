"""
Fetch publicly-available Google Play customer reviews using the
google-play-scraper package (widely used in academic work).

Per-app: up to 500 most-recent English reviews. We store only
rating, title (often empty on Play), body, app-version, and
year-month; we do NOT store user names, user IDs, profile URLs,
or exact timestamps beyond year-month.
"""
import json, time
from pathlib import Path
from google_play_scraper import Sort, reviews, app

OUT = Path(__file__).parent

APPS = [
    ("life360",  "com.life360.android.safetymapd",       "Life360 (family)"),
    ("findmy",   "com.google.android.apps.adm",          "Google Find My Device"),
    ("snapchat", "com.snapchat.android",                 "Snapchat / Snap Map (social)"),
    ("glympse",  "com.glympse.android.glympse",          "Glympse (temporary)"),
    ("zenly",    "app.zenly.locator",                    "Zenly (social, discontinued 2023)"),
]

def year_month(ts):
    # ts is datetime object or None
    if ts is None: return ""
    return f"{ts.year:04d}-{ts.month:02d}"

def fetch_one(pkg, count=500):
    result, _ = reviews(
        pkg,
        lang='en',
        country='us',
        sort=Sort.NEWEST,
        count=count,
    )
    out = []
    for r in result:
        out.append({
            "rating":     r.get("score"),
            "title":      "",  # Play reviews have no separate title
            "body":       r.get("content") or "",
            "version":    r.get("reviewCreatedVersion") or "",
            "year_month": year_month(r.get("at")),
        })
    return out

def main():
    all_data = {}
    app_meta = []
    for slug, pkg, label in APPS:
        print(f"\n=== {label} ({pkg}) ===")
        try:
            got = fetch_one(pkg, count=500)
            print(f"  fetched {len(got)} reviews")
            all_data[slug] = got
            app_meta.append({"slug": slug, "pkg": pkg, "label": label})
            time.sleep(1)
        except Exception as e:
            print(f"  ERROR: {e}")
            all_data[slug] = []
            app_meta.append({"slug": slug, "pkg": pkg, "label": label, "error": str(e)})

    out_path = OUT / "play-reviews.json"
    with out_path.open("w", encoding="utf-8") as f:
        json.dump({"apps": app_meta, "reviews": all_data}, f, ensure_ascii=False, indent=2)
    print(f"\nWritten: {out_path}")
    for slug, data in all_data.items():
        print(f"  {slug:10s} n={len(data)}")

if __name__ == "__main__":
    main()
