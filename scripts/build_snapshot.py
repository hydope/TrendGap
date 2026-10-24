#!/usr/bin/env python3
"""Build data/snapshot.json from real public sources, no key required.

Sources: GitHub Search API (repos created in the last 7 days, first 30 by
stars), Hacker News Algolia API (10 stories matching "open source"),
dev.to API (10 top articles, last 7 days).

Rules, matching the v4 plan:
- A failed source is recorded in unavailable_sources and the snapshot
  degrades to the remaining sources. Nothing is fabricated.
- If NO source works, the script exits non-zero so the workflow does not
  deploy a fabricated snapshot; the previous snapshot stays live and its
  stale banner shows.
- Rising signals: languages + topics from the repo sample, combined,
  sorted by count desc then name, capped at 21 (same shape as the
  2026-10-24 local snapshot). HN/dev.to mentions are case-insensitive
  title substring matches in that run's HN/dev.to sample only.
"""
import json
import time
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone

HEADERS = {"User-Agent": "TrendGap-snapshot-builder", "Accept": "application/json"}
OUT = "data/snapshot.json"


def fetch_json(url):
    # GitHub Search drops connections transiently; retry before giving up.
    last = None
    for attempt, delay in enumerate([0, 2, 5]):
        if delay:
            time.sleep(delay)
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - recorded in unavailable_sources
            last = e
    raise last


def main():
    since = (date.today() - timedelta(days=7)).isoformat()
    sources, unavailable = [], []
    repos, hn_items, devto_items = [], [], []

    gh_url = (
        f"https://api.github.com/search/repositories"
        f"?q=created:%3E{since}&sort=stars&order=desc&per_page=30"
    )
    try:
        data = fetch_json(gh_url)
        for item in data.get("items", [])[:30]:
            created = item.get("created_at", "")
            try:
                age = max(
                    1,
                    (datetime.now(timezone.utc)
                     - datetime.fromisoformat(created.replace("Z", "+00:00"))).days,
                )
            except Exception:
                age = 1
            repos.append({
                "full_name": item.get("full_name"),
                "name": item.get("name"),
                "html_url": item.get("html_url"),
                "description": item.get("description"),
                "language": item.get("language"),
                "topics": item.get("topics") or [],
                "stars": item.get("stargazers_count", 0),
                "forks": item.get("forks_count", 0),
                "created_at": created,
                "pushed_at": item.get("pushed_at"),
                "updated_at": item.get("updated_at"),
                "stars_per_day": round(item.get("stargazers_count", 0) / age, 1),
                "age_days": age,
            })
        sources.append({"name": "GitHub Search API", "url": gh_url, "status": "ok",
                        "note": "Unauthenticated, no key. Search API returns max 1,000 results per query; this snapshot uses the first 30."})
    except Exception as e:
        unavailable.append({"name": "GitHub Search API", "reason": str(e)})

    hn_url = "https://hn.algolia.com/api/v1/search?query=open%20source&tags=story&hitsPerPage=10"
    try:
        data = fetch_json(hn_url)
        for hit in data.get("hits", [])[:10]:
            hn_items.append({
                "title": hit.get("title"),
                "url": hit.get("url"),
                "points": hit.get("points"),
                "num_comments": hit.get("num_comments"),
                "created_at": hit.get("created_at"),
            })
        sources.append({"name": "Hacker News Algolia API", "url": hn_url, "status": "ok",
                        "note": "10 recent stories matching 'open source'; mention counts are title matches in this sample only."})
    except Exception as e:
        unavailable.append({"name": "Hacker News Algolia API", "reason": str(e)})

    devto_url = "https://dev.to/api/articles?per_page=10&top=7"
    try:
        data = fetch_json(devto_url)
        for art in data[:10]:
            devto_items.append({
                "title": art.get("title"),
                "url": art.get("url"),
                "reactions": art.get("positive_reactions_count"),
                "comments": art.get("comments_count"),
                "published_at": art.get("published_at"),
            })
        sources.append({"name": "dev.to API", "url": devto_url, "status": "ok",
                        "note": "10 top articles from the last 7 days; mention counts are title matches in this sample only."})
    except Exception as e:
        unavailable.append({"name": "dev.to API", "reason": str(e)})

    if not sources:
        raise SystemExit("All snapshot sources failed; refusing to write a fabricated snapshot.")

    lang_counts = Counter(r["language"] for r in repos if r["language"])
    topic_counts = Counter(t for r in repos for t in r["topics"])
    hn_titles = " ".join((h["title"] or "") for h in hn_items).lower()
    devto_titles = " ".join((a["title"] or "") for a in devto_items).lower()

    signals = []
    for name, count in lang_counts.items():
        signals.append({"name": name, "kind": "language", "count_in_snapshot": count,
                        "hn_mentions": hn_titles.count(name.lower()),
                        "devto_mentions": devto_titles.count(name.lower())})
    for name, count in topic_counts.items():
        signals.append({"name": name, "kind": "topic", "count_in_snapshot": count,
                        "hn_mentions": hn_titles.count(name.lower()),
                        "devto_mentions": devto_titles.count(name.lower())})
    signals.sort(key=lambda s: (-s["count_in_snapshot"], s["name"]))
    rising = signals[:21]

    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sample_note": (
            f"Snapshot sample only: first 30 results of a GitHub Search API query for repos "
            f"created after {since}, sorted by stars descending. It is NOT all of GitHub and "
            f"NOT an official trending feed — GitHub has no official trending API."
        ),
        "sources": sources,
        "unavailable_sources": unavailable,
        "rising": rising,
        "repos": repos,
        "hn_items": hn_items,
        "devto_items": devto_items,
        "languages": sorted(lang_counts.items(), key=lambda kv: (-kv[1], kv[0])),
        "topics": sorted(topic_counts.items(), key=lambda kv: (-kv[1], kv[0])),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, indent=2)
    print(f"Wrote {OUT}: {len(repos)} repos, {len(rising)} rising signals, "
          f"{len(sources)} sources ok, {len(unavailable)} unavailable.")


if __name__ == "__main__":
    main()
