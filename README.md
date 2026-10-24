# TrendGap v5

**Tagline:** Repo ideas with the evidence shown — and the crowded competitors shown too.

TrendGap v5 is a full rewrite of v4. It is a static page (vanilla JS ES modules + one CSS file, no build step, no backend, no secrets, no key required) that answers one question: **what repo should you build next?**

## What v5 does (and why v4 was replaced)

v4 generated generic template cards ("A focused X tool that does one job well") with suffix names (PythonKit, RustLens) from a tiny 30-repo snapshot sample, and almost any user input fell back to "closest-match Python/Rust/C". v5 replaces that wholesale:

- **Live first.** On load, the browser fetches GitHub Search directly: repos created in the last 7 days, sorted by stars, 20 results, no key, cached 1 hour in localStorage. That list is shown as "Trending now".
- **Search that actually searches.** "What do you want to build?" runs a live GitHub Search for your keywords among repos created in the last 7 days, sorted by stars — so the evidence is about your topic. If that search returns 0 repos, the page says so plainly ("No recently-created repos matched — no idea is invented for this") and shows trending repos only as unrelated exploration, labelled as such, NOT as evidence for your query.
- **Specific spin-off ideas, not templates.** For each top repo, v5 generates one idea from that repo: its name, its description, its language and its topics. The name is derived from the repo's own name plus an angle word (e.g. AerialTvCLI, AerialTvOffline), the pitch names the repo and quotes its description, and the angle is chosen deterministically from the repo's topics/language (mobile version, CLI version, self-hosted alternative, offline-first variant, beginner-friendly starter, team edition).
- **Full packages.** Every idea opens as a full package: repo name suggestion, one-line pitch, 3 concrete features tied to the source repo, 72-hour MVP build vs cut, suggested stack (= the source repo's language, with a reason), evidence block, top 3 competitors from the fetched set, differentiation hypothesis, and exports: Copy full package, Copy README draft, Copy HN title, Copy X opener, Copy as GitHub issue/plan. "Regenerate variant" cycles the angle (and therefore name/pitch) from the same source repo — evidence numbers do not change.
- **Filters and sort that work.** Language chips derived from the fetched repos, sort by stars / stars-per-day / newest, and a text filter over the fetched repos and ideas.

## What the evidence is — and is not

- **Is:** GitHub Search results (live, or the dated snapshot below only if live fails), with per-repo stars, stars/day (stars ÷ age in days, age floored at 1 day), created date, last push, language and topics. Interest signal is an ESTIMATE, relative to the fetched set (not to all of GitHub): `50 × (stars/day ÷ max stars/day in fetched set) + 50 × (stars ÷ max stars in fetched set)`, rounded 0–100, components shown on each package.
- **Is not:** an official GitHub trending feed (GitHub has no official trending API), a complete market survey, or proof of a gap. Competitor rows are other repos *in the fetched set* with the same language or a shared topic, not a global top 3; slots with no match in the fetched set are marked "unchecked", never invented.
- **Angles and gaps are hypotheses**, labelled as such. An angle is chosen from the source repo's listed topics/language only. A missing topic is NOT proof the repo lacks a feature — topics are not a feature list. Verify against the repo itself before building.
- **Idea names are suggestions only.** Their npm / PyPI / domain availability was not checked here.
- **Rate limits:** unauthenticated GitHub Search is limited (about 10 searches/minute per IP in practice). If live search is rate-limited or unreachable, the page falls back to the snapshot and says so in a banner — it never invents repos. In a headless-browser test on this VM, live GitHub API calls were blocked by the network tunnel, so the fallback path was exercised there; the live path needs a real-browser check after deployment.

## Snapshot fallback (not the product anymore)

`data/snapshot.json` is kept only as a fallback when live search fails. It is built by `scripts/build_snapshot.py` (GitHub Search first 30 by stars, HN Algolia, dev.to) and refreshed daily by `.github/workflows/pages.yml`, which also deploys Pages in the same run (GITHUB_TOKEN commits do not trigger other workflows). The UI shows the snapshot's `generated_at` date whenever it is used, and a banner if it is stale — snapshot data is never presented as live.

## Rename note

RepoRadar was checked 2026-10-24 and is taken: an exact GitHub repo exists (Nether404/RepoRadar), 193 GitHub name matches, npm `reporadar` is at 1.8.0, and a Product Hunt "Repo Radar" product launched in September 2025. The project was renamed to TrendGap. TrendGap was checked 2026-10-24: 1 GitHub name match, npm free (404), PyPI free (404). A name check is not a reservation — recheck at creation time.

## Run locally

```sh
cd trendgap
python3 -m http.server 8765
# open http://127.0.0.1:8765/index.html
```

The page must be served over HTTP: the snapshot fallback fetch does not work from `file://`. Live GitHub Search runs from the browser; if it fails, the page falls back to the snapshot with a banner.

## Files (v5)

- `index.html` — hero, search form, package area, trending list, spin-off ideas, honesty section. Script/style URLs are versioned (`?v=`) — bump the version on every deploy that changes `app.js`/`styles.css`, or a cached old JS can pair with new HTML and break forms (2026-10-24 cache bug).
- `styles.css` — the one CSS file, mobile-first, dark mode.
- `app.js` — live search, snapshot fallback, spin-off generation, full packages, filters/sort, exports. No old snapshot-card code remains except the fallback loader.
- `data/snapshot.json` — fallback only.
- `scripts/build_snapshot.py` — snapshot builder for the daily workflow.
- `.github/workflows/pages.yml` — snapshot refresh + Pages deploy in one workflow.

## Status

TrendGap v5 is built locally in this folder and is NOT pushed — the parent agent pushes after review. The published site at https://hydope.github.io/TrendGap/ still serves v4 until v5 is pushed. No star claim is made here; stars, if any, come only from real people after launch. The 10,000-stars-overnight goal is not a claim this build makes.
