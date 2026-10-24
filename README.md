# TrendGap

**Tagline:** Repo ideas with the evidence shown — and the crowded competitors shown too.

TrendGap is a static page (vanilla JS ES modules + one CSS file, no build step, no backend, no secrets) that turns a dated snapshot sample into 10 deterministic idea cards.

## What the evidence is — and is not

- **Is:** a snapshot sample built 2026-10-24 from:
  - GitHub Search API — first 30 results for repos created after 2026-10-17, sorted by stars descending. No key.
  - Hacker News Algolia API — 10 stories matching "open source".
  - dev.to API — 10 top articles from the last 7 days.
  - Every snapshot carries `generated_at`, a source list, and a sample note. The UI shows "snapshot updated Xh ago" and a banner if the snapshot is over 24 hours old.
- **Is not:** an official GitHub trending feed (GitHub has no official trending API), a complete market survey, or proof of a gap. Popularity is not proof of a gap.
- **Idea cards are SUGGESTIONS.** Only the evidence numbers are data. Competitor rows are the top matches *in this snapshot sample*, not a global top 3; slots with no match in the sample are marked "unchecked", never invented.
- **Interest signal is an ESTIMATE, not a virality prediction.** Formula, published in the UI: `50 × (avg stars/day ÷ max avg stars/day in snapshot) + 30 × (sample stars ÷ max sample stars) + 20 × (min(HN + dev.to title mentions, 5) ÷ 5)`, rounded 0–100, with components shown per card.
- **Differentiation angles are hypotheses**, labelled as such, not proven differentiation.
- **Card names are suggestions only.** Their npm / PyPI / domain availability was not checked here.

## Rename note

RepoRadar was checked 2026-10-24 and is taken: an exact GitHub repo exists (Nether404/RepoRadar), 193 GitHub name matches, npm `reporadar` is at 1.8.0, and a Product Hunt "Repo Radar" product launched in September 2025. The project was renamed to TrendGap. TrendGap was checked 2026-10-24: 1 GitHub name match, npm free (404), PyPI free (404). A name check is not a reservation — recheck at creation time.

## Run locally

```sh
cd trendgap
python3 -m http.server 8765
# open http://127.0.0.1:8765/index.html
```

The page must be served over HTTP: the snapshot fetch does not work from `file://`. It works from the snapshot if live calls fail, and shows a banner when live calls are unavailable.

## How the snapshot is built

Re-run the source fetches (GitHub Search, HN Algolia, dev.to) without a key, trim each repo to name, URL, description, language, topics, stars, forks, created/pushed/updated dates and stars/day, count languages/topics, count HN/dev.to title mentions per signal, and write `data/snapshot.json` with `generated_at`, `sources` (with status) and `unavailable_sources`. If a source fails, record it as unavailable and degrade to the remaining sources — never fabricate repos, stars, or counts. If no real source works, the snapshot must be a clearly labelled sample and the UI must show "Sample data — live snapshot not yet connected".

In this local build, all three sources worked on the first successful attempt (one transient GitHub curl failure, HTTP 000, succeeded on retry with a User-Agent header). No source was cut from the snapshot. A browser CORS check for the live GitHub call was not run in this local build — the live call is a best-effort "reachable?" note only, and the snapshot remains the source of truth.

## Cuts from v3 (per the v4 spec)

- Virality score → transparent interest-signal ESTIMATE.
- "Crowded" verdict → competitor rows + differentiation hypothesis.
- Preset skill chips (Python/GenAI/agents/pgvector) → defaults from the snapshot's top rising topics/languages; chips remain selectable.
- BYOK Gemini generation → deterministic templates, no key.
- Shareable image export → copyable text export (README hook, HN title, X opener, GitHub issue/plan).
- Workflow/Pages: `.github/workflows/pages.yml` refreshes the snapshot daily (scripts/build_snapshot.py) and deploys Pages in the same run.

## Status

Published to GitHub Pages at https://hydope.github.io/TrendGap/ — snapshot refreshed daily by `.github/workflows/pages.yml` (same workflow also deploys Pages, since GITHUB_TOKEN commits do not trigger other workflows). No star claim is made here; stars, if any, come only from real people after launch.
