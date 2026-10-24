// TrendGap v5 — full rewrite. Live GitHub Search first, snapshot only as fallback.
// No build step, no backend, no secrets, no key. Ideas are SUGGESTIONS;
// only evidence numbers are data; angles are hypotheses, never proven gaps.
// GitHub has NO official trending API — "trending now" here means repos
// created in the last 7 days, sorted by stars in GitHub Search.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => { try { return new Date(d).toISOString().slice(0, 10); } catch { return "unknown date"; } };
const clean = (s) => String(s || "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
const CACHE_KEY = "trendgap-v5-live";
const CACHE_TTL = 60 * 60 * 1000;

function date7DaysAgo() {
  const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
function ageDays(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(1, Math.floor(ms / 86400000));
}
function normalizeApiRepo(item) {
  const age = ageDays(item.created_at);
  return {
    full_name: item.full_name, name: item.name, html_url: item.html_url,
    description: item.description || "", language: item.language || "Unknown",
    topics: item.topics || [], stars: item.stargazers_count || 0,
    forks: item.forks_count || 0, created_at: item.created_at,
    pushed_at: item.pushed_at, updated_at: item.updated_at,
    stars_per_day: Math.round((item.stargazers_count || 0) / age * 10) / 10, age_days: age,
  };
}
function normalizeSnapshotRepo(r) {
  const age = r.age_days || ageDays(r.created_at);
  return {
    full_name: r.full_name, name: r.name, html_url: r.html_url,
    description: r.description || "", language: r.language || "Unknown",
    topics: r.topics || [], stars: r.stars || 0, forks: r.forks || 0,
    created_at: r.created_at, pushed_at: r.pushed_at, updated_at: r.updated_at,
    stars_per_day: r.stars_per_day ?? Math.round((r.stars || 0) / age * 10) / 10, age_days: age,
  };
}
function loadCache() {
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); return c && Date.now() - c.fetchedAt < CACHE_TTL ? c : null; } catch { return null; }
}
function saveCache(repos) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), repos })); } catch { /* cache optional */ }
}
async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/vnd.github+json" } });
    clearTimeout(timer);
    return res;
  } catch (e) { clearTimeout(timer); throw e; }
}
function githubSearchUrl(keywords) {
  const u = new URL("https://api.github.com/search/repositories");
  const q = keywords ? `${keywords} created:>${date7DaysAgo()}` : `created:>${date7DaysAgo()}`;
  u.searchParams.set("q", q);
  u.searchParams.set("sort", "stars");
  u.searchParams.set("order", "desc");
  u.searchParams.set("per_page", "20");
  return u.toString();
}

// ---- v5.2 search: ALL stages evaluated, merged, relevance-ranked.
// v5.1 bug, proven 2026-10-24 for "Meta rayban video connect": first-non-
// empty-wins stopped at stage "meta ray-ban video connect" (1 repo, a DAT
// SDK plugin, 0 stars) and never reached "Meta rayban video" (2 on-topic
// video repos). So v5.2 evaluates EVERY stage, dedupes by repo, and ranks
// the merged set by (a) distinct original query tokens matched, (b) relevance
// score, (c) stars. A repo only counts if an original query word actually
// appears in its name, description or topics (hyphen-insensitive, so
// "rayban" matches "ray-ban").
// Stages: full query in:name,description; rayban -> ray-ban variant;
// progressively dropping the last word down to one word. All stages are
// shown to the user, with which stage each repo came from. TRANSFORMED is
// not DROPPED: "rayban" -> "ray-ban" is the same word with a hyphen, and
// the status text must say transformed, never dropped.
function queryTokens(query) {
  return String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function searchStageDefs(query) {
  const tokens = queryTokens(query);
  const defs = [];
  const push = (toks, label) => { if (toks.length) defs.push({ tokens: [...toks], label: label || toks.join(" ") }); };
  push(tokens);
  if (tokens.includes("rayban")) push(tokens, tokens.map((t) => (t === "rayban" ? "ray-ban" : t)).join(" "));
  // v5.3: for 3+ token queries, drop-last stops at 2 words. The bare
  // single-word stage ("meta" alone: 332,874 matches, 17 of 39 merged repos
  // in the 2026-10-24 check) is pure noise and wastes rate budget. For 1–2
  // token queries all stages are kept.
  const minWords = tokens.length >= 3 ? 2 : 1;
  for (let n = tokens.length - 1; n >= minWords; n--) push(tokens.slice(0, n));
  const seen = new Set();
  return defs.filter((d) => (seen.has(d.label) ? false : (seen.add(d.label), true)));
}
function normFlat(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function matchedInfo(repo, originalTokens) {
  const name = normFlat(repo.name);
  const desc = normFlat(repo.description);
  const topics = normFlat((repo.topics || []).join(" "));
  let count = 0;
  let score = 0;
  for (const raw of originalTokens) {
    const t = normFlat(raw);
    if (!t) continue;
    let hit = false;
    if (name.includes(t)) { score += 3; hit = true; }
    if (desc.includes(t)) { score += 2; hit = true; }
    if (topics.includes(t)) { score += 1; hit = true; }
    if (hit) count += 1;
  }
  return { count, score };
}
function relevanceScore(repo, stageQuery) {
  return matchedInfo(repo, queryTokens(stageQuery)).score;
}
// ---- v5.3 TIERED RELEVANCE: a repo whose NAME or TOPICS contain 2+
// distinct query words is Tier A ("Name/topic match"); everything else
// that matched is Tier B ("Description-only match"). Tier sorts BEFORE
// words-matched/relevance/stars, because a name/topic match is a much
// stronger intent signal than a description word. SDK/plugin/library repos
// are demoted ONE tier when the topic is not about SDKs/plugins (their
// name contains sdk/plugin/library but the topic words do not) — labelled
// on the row, never silently excluded: they stay visible, just lower.
// Example, "Meta rayban video connect": MetaRaybanCameraApp's name contains
// meta+rayban = Tier A; flutter_meta_wearables' name contains meta only =
// Tier B, and it is also an SDK/plugin-style name, so it drops further.
function tierInfo(repo, originalTokens) {
  const name = normFlat(repo.name);
  const topics = normFlat((repo.topics || []).join(" "));
  const nameWords = new Set();
  const topicWords = new Set();
  for (const raw of originalTokens) {
    const t = normFlat(raw);
    if (!t) continue;
    if (name.includes(t)) nameWords.add(t);
    if (topics.includes(t)) topicWords.add(t);
  }
  const strong = new Set([...nameWords, ...topicWords]);
  let tier = strong.size >= 2 ? 0 : 1;
  const topicFlat = new Set(originalTokens.map(normFlat));
  const isSdkName = /(sdk|plugin|library)/.test(name);
  const topicIsSdk = ["sdk", "plugin", "library"].some((w) => topicFlat.has(w));
  const demoted = isSdkName && !topicIsSdk;
  if (demoted) tier += 1;
  return { tier, demoted, strongCount: strong.size,
    label: tier === 0 ? "Tier A — Name/topic match" : tier === 1 ? "Tier B — Description-only match" : "Tier C — SDK/plugin building block" };
}
function strengthTier(repo) {
  if (repo.stars >= 100) return "Established";
  if (repo.stars >= 10) return "Emerging";
  return "Early";
}
function interestTier(repo) {
  if (repo.stars >= 1000) return "Breakout";
  if (repo.stars >= 100) return "Strong";
  if (repo.stars >= 10) return "Emerging";
  return "Early (weak)";
}
function interestLine(repo) {
  return `Interest: ${interestTier(repo)} — ${repo.stars} stars, ${repo.stars_per_day}/day`;
}
async function searchAllStages(query) {
  const original = queryTokens(query);
  const defs = searchStageDefs(query);
  const stageResults = [];
  const byName = new Map();
  for (const def of defs) {
    const u = new URL("https://api.github.com/search/repositories");
    u.searchParams.set("q", `${def.label} in:name,description`);
    u.searchParams.set("sort", "stars");
    u.searchParams.set("order", "desc");
    u.searchParams.set("per_page", "20");
    const res = await fetchJson(u.toString());
    if (res.status === 403 || res.status === 429) throw new Error("rate-limited");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    stageResults.push({ label: def.label, tokens: def.tokens, total: data.total_count || 0, returned: (data.items || []).length });
    for (const item of data.items || []) {
      const repo = normalizeApiRepo(item);
      const info = matchedInfo(repo, original);
      if (info.count === 0) continue;
      const prev = byName.get(repo.full_name);
      if (prev) {
        prev.sources.push(def.label);
        if (info.count > prev.matched || (info.count === prev.matched && info.score > prev.score)) {
          prev.matched = info.count; prev.score = info.score;
        }
      } else {
        byName.set(repo.full_name, { repo, sources: [def.label], matched: info.count, score: info.score });
      }
    }
  }
  const merged = [...byName.values()]
    .map((x) => { const t = tierInfo(x.repo, original); x.tier = t.tier; x.demoted = t.demoted; x.tierLabel = t.label; return x; })
    .sort((a, b) => a.tier - b.tier || b.matched - a.matched || b.score - a.score || b.repo.stars - a.repo.stars)
    .map((x) => { x.repo._sources = [...new Set(x.sources)]; x.repo._matched = x.matched; x.repo._score = x.score; x.repo._tier = x.tier; x.repo._tierLabel = x.tierLabel; x.repo._demoted = x.demoted; return x.repo; });
  const transformed = original.includes("rayban") ? ["rayban → ray-ban"] : [];
  const droppedInStages = [];
  for (const def of defs) {
    for (const t of original) if (!def.tokens.includes(t) && !droppedInStages.includes(t)) droppedInStages.push(t);
  }
  return { repos: merged, stages: stageResults, transformed, droppedInStages, totalUnique: merged.length };
}
// Back-compat name used by older callers: now returns the merged set.
async function stagedSearch(query) {
  const r = await searchAllStages(query);
  return { repos: r.repos, stages: r.stages, transformed: r.transformed, dropped: r.droppedInStages, total: r.totalUnique, stage: null };
}

// ---- Angles: chosen from the repo's own topics/language ONLY. A missing
// topic is not proof the repo lacks a feature — the hypothesis text says so.
const WEB_LANGS = new Set(["javascript", "typescript"]);
const ANGLE_DEFS = [
  { key: "mobile", word: "Mobile", label: "Mobile version", audience: "phones",
    applies: (r) => WEB_LANGS.has((r.language || "").toLowerCase()) && !hasTopic(r, ["mobile", "android", "ios", "react-native", "flutter"]),
    why: (r) => `no mobile topic (mobile/android/ios) is listed for ${r.full_name}` },
  { key: "cli", word: "CLI", label: "Command-line version", audience: "the terminal",
    applies: (r) => !hasTopic(r, ["cli", "command-line", "terminal"]),
    why: (r) => `no cli/command-line topic is listed for ${r.full_name}` },
  { key: "selfhosted", word: "SelfHosted", label: "Self-hosted alternative", audience: "your own server",
    applies: (r) => (r.language || "").toLowerCase() === "python" && hasTopic(r, ["api"]),
    why: (r) => `${r.full_name} is Python and lists an api topic` },
  { key: "offline", word: "Offline", label: "Offline-first variant", audience: "no-connection use",
    applies: (r) => !hasTopic(r, ["offline", "pwa", "local-first"]),
    why: (r) => `no offline/local-first topic is listed for ${r.full_name}` },
  { key: "starter", word: "Starter", label: "Beginner-friendly starter", audience: "first-time users",
    applies: () => true, why: (r) => `${r.full_name} is a focused tool that a starter could make approachable` },
  { key: "team", word: "Team", label: "Team edition", audience: "small teams",
    applies: () => true, why: (r) => `${r.full_name} is a focused tool that a team edition could extend` },
];
function hasTopic(r, names) {
  const t = new Set((r.topics || []).map((x) => String(x).toLowerCase()));
  return names.some((n) => t.has(n));
}
function anglesFor(repo) { return ANGLE_DEFS.filter((a) => a.applies(repo)); }
function descShort(repo) {
  const d = (repo.description || "").trim();
  if (!d) return "No description listed on GitHub.";
  return d.length > 140 ? d.slice(0, 137).trim() + "…" : d;
}
function ideaName(repo, angle) {
  const full = clean(repo.name);
  let name = full + angle.word;
  if (name.length > 24) {
    const first = clean(repo.name.split(/[-_]/)[0]);
    name = first + angle.word;
  }
  if (name.length > 24) name = name.slice(0, 24);
  return name;
}
function ideaFor(repo, variant) {
  const angles = anglesFor(repo);
  const angle = angles[variant % angles.length];
  const name = ideaName(repo, angle);
  const article = /^[aeiou]/i.test(angle.label) ? "An" : "A";
  const pitch = `${article} ${angle.label.toLowerCase()} spin-off of ${repo.full_name}: ${descShort(repo)}`;
  return { repo, angle, name, pitch };
}
function competitorsFor(repo, repos) {
  const lang = (repo.language || "").toLowerCase();
  const topics = new Set((repo.topics || []).map((t) => String(t).toLowerCase()));
  return repos
    .filter((r) => r.full_name !== repo.full_name &&
      ((r.language || "").toLowerCase() === lang ||
       (r.topics || []).some((t) => topics.has(String(t).toLowerCase()))))
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 3);
}
function packageFor(repo, variant, repos, opts) {
  const idea = ideaFor(repo, variant);
  const angle = idea.angle;
  const interest = interestLine(repo);
  const comps = competitorsFor(repo, repos);
  const topTopic = (repo.topics || [])[0] || repo.language;
  const features = [
    `${angle.label} build of the core job in ${repo.full_name} — ${descShort(repo)} — rebuilt for ${angle.audience}.`,
    `Same scope, smaller surface: ${repo.language} implementation around its ${topTopic} topic, with one working demo and docs first.`,
    `Demo from the source repo's own job: a minimal version of what ${repo.full_name} does, without copying its code or claiming its features.`,
  ];
  const hypothesis = `Hypothesis (based only on listed topics/language, NOT a proven gap): ${angle.why(repo)}, so a ${angle.label.toLowerCase()} is a possible angle. Topics are not a feature list — the repo may already do this in a way GitHub's API does not show. Verify against the repo itself before building.`;
  const explorationNote = opts && opts.exploration
    ? `EXPLORATION ONLY — ${repo.full_name} is a trending repo shown for exploration. It is NOT evidence for your search query and is unrelated to it.\n\n`
    : "";
  const markdown = `# ${idea.name}\n\n${idea.pitch}\n\nSUGGESTION — only the evidence numbers are data.\n\n${explorationNote}## README outline\n\nProblem → Solution → Features → Demo → Evidence → Differentiation.\n\n## Problem / solution\n\n${idea.pitch}\n\n## Features (suggestions, tied to the source repo — not evidence)\n\n${features.map((f) => `- ${f}`).join("\n")}\n\n## Suggested stack\n\n${repo.language} (the source repo's language, from GitHub — the reason is that the idea is a spin-off of a ${repo.language} repo, not a market claim).\n\n## 72-hour MVP\n\nBuild: core ${angle.label.toLowerCase()} in ${repo.language}; one demo; docs + worked example.\nCut: accounts, payments, AI generation, mobile app (unless the angle itself is mobile — then cut accounts, payments, AI generation).\n\n## Evidence\n\n- Source repo: ${repo.full_name} — ${repo.html_url}\n- Stars: ${repo.stars}; stars/day: ${repo.stars_per_day} (stars ÷ ${repo.age_days} days); created ${fmtDate(repo.created_at)}; last push ${fmtDate(repo.pushed_at || repo.updated_at)}\n- Language: ${repo.language}; topics: ${(repo.topics || []).join(", ") || "none listed"}\n- ${interest} (absolute tiers by stars: 1000+ Breakout, 100+ Strong, 10+ Emerging, else Early — NOT relative to this fetched set)\n- Source: ${opts && opts.sourceLabel ? opts.sourceLabel : "fetched set"}\n- Top competitors in fetched set:\n${comps.length ? comps.map((r) => `  - ${r.full_name} — ${r.stars} stars, ${r.stars_per_day}/day, last push ${fmtDate(r.pushed_at || r.updated_at)}`).join("\n") : "  None in this fetched set — marked unchecked, not “no competitors exist”."}\n\n## Differentiation hypothesis (not proven)\n\n${hypothesis}\n`;
  const html = `<article class="package">
    <h3>${esc(idea.name)} <span class="small">— SUGGESTION${opts && opts.exploration ? ' · <strong>Exploration only — unrelated to your query</strong>' : ''}</span></h3>
    <p>${esc(idea.pitch)}</p>
    <p><strong>Angle (hypothesis):</strong> ${esc(angle.label)} — ${esc(hypothesis)}</p>
    <p><strong>README outline:</strong> Problem → Solution → Features → Demo → Evidence → Differentiation. The full draft is in “Copy full package” below.</p>
    <p><strong>Features (suggestions, tied to the source repo):</strong></p><ul>${features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    <p><strong>Suggested stack:</strong> ${esc(repo.language)} — the source repo's language (a suggestion, not a market claim).</p>
    <p><strong>72-hour MVP — Build:</strong> core ${esc(angle.label.toLowerCase())} in ${esc(repo.language)}; one demo; docs + worked example. <strong>Cut:</strong> accounts, payments, AI generation${angle.key === "mobile" ? "" : ", mobile app"}.</p>
    <div class="evidence">
      <p><strong>Evidence:</strong> Source repo <a href="${esc(repo.html_url)}" target="_blank" rel="noopener">${esc(repo.full_name)}</a> — ${repo.stars} stars, ${repo.stars_per_day}/day (stars ÷ ${repo.age_days} days), created ${fmtDate(repo.created_at)}, last push ${fmtDate(repo.pushed_at || repo.updated_at)}.</p>
      <p>Language: ${esc(repo.language)}; topics: ${esc((repo.topics || []).join(", ") || "none listed")}.</p>
      <p>${esc(interest)} (absolute tiers by stars — not relative to this fetched set, so a 2-star repo can never read "100/100").</p>
      <p>Source: ${esc(opts && opts.sourceLabel ? opts.sourceLabel : "fetched set")}.</p>
      <p><strong>Top competitors in fetched set:</strong></p><ul>${comps.length ? comps.map((r) => `<li><a href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.full_name)}</a> — ${r.stars} stars, ${r.stars_per_day}/day, last push ${fmtDate(r.pushed_at || r.updated_at)}.</li>`).join("") : '<li>None in this fetched set — marked unchecked, not “no competitors exist”.</li>'}</ul>
    </div>
    <p><strong>Differentiation hypothesis:</strong> ${esc(hypothesis)}</p>
    <div class="export">
      <button type="button" data-pkg-export="full">Copy full package</button>
      <button type="button" data-pkg-export="readme">Copy README draft</button>
      <button type="button" data-pkg-export="hn">Copy HN title</button>
      <button type="button" data-pkg-export="x">Copy X opener</button>
      <button type="button" data-pkg-export="issue">Copy as GitHub issue/plan</button>
    </div></article>`;
  return {
    html, markdown, repo, angle, interest,
    hn: `Show HN: ${idea.name} — ${idea.pitch}`,
    x: `${idea.name}: ${idea.pitch} (Suggestion — evidence in TrendGap, not proof of a gap.)`,
    issue: `## Plan: ${idea.name}\n\nPitch: ${idea.pitch}\n\n72-hour MVP — Build: core, one demo, docs + example. Cut: accounts, payments, AI generation.\n\n${interest}. Differentiation hypothesis: see package — hypothesis, not proven.`,
  };
}
async function copyText(btn, text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove();
  }
  const old = btn.textContent; btn.textContent = "Copied"; setTimeout(() => { btn.textContent = old; }, 1500);
}

// ---- v5.2 GAP GENERATOR: what is MISSING in the market, and how to fix it.
// A "gap" here means exactly one thing: a GitHub Search for "<topic> <probe>"
// in names/descriptions found 0 repos, or only a repo under 5 stars. It is
// NEVER a claim that nothing exists in the world — GitHub Search is not a
// world survey, and a feature can exist in a repo whose name/description
// does not contain the probe word. Every gap idea says so on the card.
// Trending also needs execution, timing and distribution; no idea here is
// guaranteed to trend or be "top in the world".
const GAP_PROBES = ["backup", "blur", "transcript", "captions", "dual", "search", "translate", "offline", "sync", "editor"];
const GAP_FEATURES = {
  backup: ["Auto-backup for {topic} footage the moment it is captured — local copy first, cloud copy when online, with deduplication so the same clip is never stored twice.",
    "Date-organised library for {topic} clips with one-tap restore and export, so a lost phone does not mean lost footage.",
    "Backup health check: shows what is backed up, what is only on the glasses, and what is at risk — before the user deletes anything."],
  blur: ["On-device face and licence-plate detection for {topic} clips, with auto-blur applied before anything is posted.",
    "Manual blur brush and review step: the user checks every blurred frame before export, so no face slips through.",
    "Export that keeps the original private and shares only the blurred version — the unblurred clip never leaves the device."],
  transcript: ["Speech-to-text for {topic} clips, run on-device where possible, producing a timestamped transcript per clip.",
    "Searchable transcript index: find a clip by what was said in it, not by scrolling dates.",
    "Transcript export (plain text + SRT) alongside the clip, so the words travel with the video."],
  captions: ["Automatic captions for {topic} clips with word-level timing and an editable text layer.",
    "Caption styles built for vertical video: readable at a glance, positioned away from the subject.",
    "Burn-in captions plus a separate SRT file, so the same clip works captioned or clean."],
  dual: ["Synced capture: {topic} glasses footage and phone footage recorded as one session with a shared clock.",
    "Angle switch in the editor: cut between the glasses angle and the phone angle on one timeline.",
    "Synced audio: one audio track, both angles, so the cut never drifts out of lip-sync."],
  search: ["Search across all {topic} footage by transcript words, scene tags and date — not by filename.",
    "Filters for date, location and favourites, with instant results as you type.",
    "Saved searches: a query like 'all clips from this street' becomes a reusable collection."],
  translate: ["Live translation captions for {topic} audio: speak in one language, read captions in another, in real time.",
    "Language picker with the most common pairs first, and a visible 'translation is approximate' label on every caption.",
    "Offline translation model option, so translation works without uploading audio."],
  offline: ["Fully offline processing for {topic} clips: import, cut and export with no account and no upload required.",
    "Local library that works with no connection and syncs only when the user asks it to.",
    "Clear offline/online state on every screen, so the user always knows what left the device and what did not."],
  sync: ["Automatic sync for {topic} clips between glasses, phone and desktop, with progress and resume after interruption.",
    "Conflict handling that never silently overwrites a clip: duplicates are shown, not hidden.",
    "Sync status per clip — on glasses only, on phone, everywhere — visible at a glance."],
  editor: ["Timeline editor for {topic} clips: trim, cut and reorder on one screen, built for vertical video.",
    "Captions and titles inside the same editor, so a finished clip never needs a second app.",
    "Export presets for the places the clip will be posted (9:16, captions on/off) with one tap each."],
};
function gapIdeaName(topic, probe) {
  const toks = queryTokens(topic).filter((t) => !["the", "a", "an", "for", "to", "of", "with", "and"].includes(t));
  const base = clean(toks.join(" ")) + clean(probe);
  if (base.length <= 28) return base;
  const longest = [...toks].sort((a, b) => b.length - a.length)[0] || "Gap";
  return (clean(longest) + clean(probe)).slice(0, 28);
}
function gapIdea(topic, probeResult, saturated, stack) {
  const name = gapIdeaName(topic, probeResult.probe);
  const probe = probeResult.probe;
  const missingLine = probeResult.total === 0
    ? `GitHub Search for "${probeResult.query}" in repo names/descriptions found 0 repos.`
    : `GitHub Search for "${probeResult.query}" in repo names/descriptions found ${probeResult.total} repo(s), and the top one, ${probeResult.top.full_name}, has only ${probeResult.top.stars} star(s) — below the 5-star threshold for "exists".`;
  const features = (GAP_FEATURES[probe] || []).map((f) => f.replaceAll("{topic}", topic));
  const aiCore = ["transcript", "captions", "translate", "blur"].includes(probe);
  const cut = aiCore ? "accounts, payments, mobile app" : "accounts, payments, AI generation, mobile app";
  const notBuild = [...saturated].sort((a, b) => b.stars - a.stars).slice(0, 3);
  // ---- v5.3 "Why this could work (evidence)": every point cites a number
  // from THIS run — never a generic claim. No number, no point. Heading is
  // "Why this could work (evidence)", never "Why this WILL work", and never
  // a guarantee. Plus one honest "What could kill it" counter-line.
  const demandTop = [...saturated].sort((a, b) => b.stars - a.stars)[0];
  const totalTop10 = saturated.reduce((s, r) => s + (r.stars || 0), 0);
  const topicWords = queryTokens(topic);
  let adjacent = null; let adjacentShared = 0;
  for (const r of saturated) {
    const hay = normFlat(`${r.name} ${r.description} ${(r.topics || []).join(" ")}`);
    let shared = 0;
    for (const w of topicWords) if (hay.includes(normFlat(w))) shared += 1;
    if (r.language === stack.language) shared += 1;
    if (!adjacent || shared > adjacentShared || (shared === adjacentShared && r.stars > adjacent.stars)) { adjacent = r; adjacentShared = shared; }
  }
  const established = [...saturated].filter((r) => r.stars >= 100).sort((a, b) => b.stars - a.stars)[0];
  const killLine = established
    ? `An Established competitor, ${established.full_name} (${established.stars} stars), could add the "${probe}" feature itself and out-ship a brand-new repo.`
    : totalTop10 < 100
    ? `Topic demand is small: the topic's top 10 total only ${totalTop10} stars, so even a good idea may find few users.`
    : `A platform change could break it: if the glasses SDK, store rules, or APIs this idea depends on change, the core feature may need rebuilding.`;
  const evidencePoints = [
    `Topic demand: the top repo in this topic, ${demandTop ? demandTop.full_name : "none shown"} (${demandTop ? demandTop.stars : 0} stars), and the topic's top 10 total ${totalTop10} stars — people actually build and star things in this topic.`,
    `Unserved slice: GitHub Search for "${probeResult.query}" found ${probeResult.total} repo(s)${probeResult.top ? `; nearest is ${probeResult.top.full_name} (${probeResult.top.stars} stars)` : "; nearest repo: none"} — this slice specifically is unserved.`,
    `Adjacent proof: ${adjacent ? adjacent.full_name : "none shown"} (${adjacent ? adjacent.stars : 0} stars) shares ${adjacentShared} topic word(s)/stack match(es) with this idea — a neighbouring single-purpose tool in this space already found users.`,
    `Buildability: ${stack.language} is the stack of ${stack.count} of ${stack.total} top repos, and the MVP is one "${probe}" core feature with one demo in 72 hours — small scope, not a moonshot.`,
  ];
  const markdown = `# ${name}\n\nSUGGESTION — a market-gap idea, not a proven gap. Only the evidence numbers are data.\n\n## What's missing\n\n${missingLine} For ${topic}, the "${probe}" angle is the missing piece this idea fixes.\n\n## Evidence (what GitHub Search actually found — not a world survey)\n\n- Probe query: "${probeResult.query}" in:name,description — total matches: ${probeResult.total}${probeResult.top ? `\n- Nearest repo found: ${probeResult.top.full_name} — ${probeResult.top.stars} stars, ${probeResult.top.stars_per_day}/day, created ${fmtDate(probeResult.top.created_at)} — ${descShort(probeResult.top)}` : "\n- Nearest repo found: none."}\n- Topic's top repos (existing repos, tiered by stars): ${saturated.slice(0, 3).map((r) => `${r.full_name} (${r.stars} stars)`).join(", ") || "none shown"}.\n- "Missing" here means: no repo found by this GitHub search, or only a repo under 5 stars. A feature can exist in a repo whose name/description does not contain the probe word — verify against the repos themselves before building.\n\n## How to fix it (concrete build plan)\n\n${features.map((f) => `- ${f}`).join("\n")}\n\n## 72-hour MVP\n\nBuild: the "${probe}" core feature for ${topic}; one working demo on real footage; docs + worked example.\nCut: ${cut}.\n\n## Suggested stack\n\n${stack.language} (suggestion only — the most common language among the topic's top repos: ${stack.count} of ${stack.total} shown), because the existing repos around this topic are mostly ${stack.language}.\n\n## What already exists (top repos — with stars)\n\n${notBuild.map((r) => `- ${r.full_name} — ${r.stars} stars: ${descShort(r)}`).join("\n")}\n\n## Why this could work (evidence)\n\n${evidencePoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\n**What could kill it:** ${killLine}\n\n## Honesty note\n\nTrending also needs execution, timing and distribution. This idea is not guaranteed to trend or to be "top in the world" — the gap evidence above is the only claim being made, and it is limited to what GitHub Search found.\n`;
  const html = `<article class="package">
    <h3>${esc(name)} <span class="small">— SUGGESTION · GAP IDEA for "${esc(probe)}"</span></h3>
    <p><strong>What's missing:</strong> ${esc(missingLine)}</p>
    <div class="evidence">
      <p><strong>Evidence:</strong> Probe query "${esc(probeResult.query)}" in:name,description — total matches: ${probeResult.total}.${probeResult.top ? ` Nearest repo: <a href="${esc(probeResult.top.html_url)}" target="_blank" rel="noopener">${esc(probeResult.top.full_name)}</a> — ${probeResult.top.stars} stars, ${probeResult.top.stars_per_day}/day, created ${fmtDate(probeResult.top.created_at)}.` : " Nearest repo: none."}</p>
      <p>"Missing" means no repo found by <em>this GitHub search</em>, or only a repo under 5 stars — not that nothing exists in the world.</p>
    </div>
    <p><strong>How to fix it:</strong></p><ul>${features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    <p><strong>72-hour MVP — Build:</strong> the "${esc(probe)}" core feature for ${esc(topic)}; one working demo on real footage; docs + worked example. <strong>Cut:</strong> ${esc(cut)}.</p>
    <p><strong>Suggested stack:</strong> ${esc(stack.language)} — suggestion only, the most common language among the topic's top repos (${stack.count} of ${stack.total} shown).</p>
    <p><strong>What already exists (top repos — only Established ones are truly saturated):</strong></p><ul>${notBuild.map((r) => `<li><a href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.full_name)}</a> — ${r.stars} stars: ${esc(descShort(r))}</li>`).join("")}</ul>
    <h4>Why this could work (evidence)</h4>
    <ol>${evidencePoints.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
    <p><strong>What could kill it:</strong> ${esc(killLine)}</p>
    <p class="small">Trending also needs execution, timing and distribution. This idea is not guaranteed to trend or to be "top in the world".</p>
    <div class="export">
      <button type="button" data-gap-export="full">Copy full package</button>
      <button type="button" data-gap-export="readme">Copy README draft</button>
      <button type="button" data-gap-export="hn">Copy HN title</button>
      <button type="button" data-gap-export="x">Copy X opener</button>
    </div></article>`;
  return {
    html, markdown, name, probe, evidencePoints, killLine,
    hn: `Show HN: ${name} — the missing ${probe} piece for ${topic} (gap idea, evidence in TrendGap)`,
    x: `${name}: the missing ${probe} angle for ${topic}. Gap evidence in TrendGap — suggestion, not a guarantee it will trend.`,
  };
}

async function main() {
  // Dark mode.
  const savedTheme = localStorage.getItem("trendgap-theme");
  const applyTheme = (t) => { document.body.classList.toggle("dark", t === "dark"); $("darkToggle").textContent = t === "dark" ? "Light mode" : "Dark mode"; };
  let theme = savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(theme);
  $("darkToggle").addEventListener("click", () => { theme = theme === "dark" ? "light" : "dark"; localStorage.setItem("trendgap-theme", theme); applyTheme(theme); });

  let trendingRepos = [];
  let trendingSourceLabel = "";
  let allRepos = [];
  let mode = "trending"; // trending | search | search-empty | fallback
  let currentQuery = "";
  let exploration = false;
  let sourceLabel = "loading…";
  let selectedLang = null;
  let sortMode = "stars";
  let filterText = "";
  let pkgRepo = null;
  let pkgVariant = 0;
  let pkg = null;

  function setSource(text) { $("sourceStatus").textContent = text; }
  function showBanner(text) { const b = $("banner"); if (text) { b.hidden = false; b.textContent = text; } else { b.hidden = true; } }

  async function loadTrending() {
    setSource("Loading trending repos (live GitHub Search)…");
    showBanner("");
    const cached = loadCache();
    if (cached && cached.repos && cached.repos.length) {
      const hours = ((Date.now() - cached.fetchedAt) / 3600000).toFixed(1);
      trendingRepos = cached.repos.map(normalizeSnapshotRepo);
      sourceLabel = `Live GitHub Search, cached ${hours}h ago (1h cache)`;
      trendingSourceLabel = sourceLabel;
      setSource(`Source: ${sourceLabel}.`);
      return;
    }
    try {
      const res = await fetchJson(githubSearchUrl(""));
      if (res.status === 403 || res.status === 429) throw new Error("rate-limited");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      trendingRepos = (data.items || []).map(normalizeApiRepo);
      saveCache(trendingRepos);
      sourceLabel = "Live GitHub Search just now (repos created in the last 7 days, sorted by stars)";
      trendingSourceLabel = sourceLabel;
      setSource(`Source: ${sourceLabel}.`);
    } catch (e) {
      // Fallback to the dated snapshot — labelled as fallback, never as live.
      try {
        const res = await fetch("data/snapshot.json", { cache: "no-store" });
        if (!res.ok) throw new Error("snapshot HTTP " + res.status);
        const snap = await res.json();
        trendingRepos = (snap.repos || []).map(normalizeSnapshotRepo);
        sourceLabel = `Snapshot fallback from ${snap.generated_at || "unknown date"}`;
        trendingSourceLabel = sourceLabel;
        setSource(`Source: ${sourceLabel}.`);
        showBanner(`Showing snapshot fallback from ${snap.generated_at || "unknown date"} — live search unavailable (${e.message}). Snapshot data is NOT live data.`);
      } catch (e2) {
        trendingRepos = [];
        sourceLabel = "unavailable";
        setSource("Source unavailable — live search and snapshot fallback both failed. No repos are shown, and none are invented.");
        showBanner(`Could not load repos: live search failed (${e.message}) and snapshot fallback failed (${e2.message}).`);
      }
    }
  }

  function filteredRepos() {
    let list = [...allRepos];
    if (selectedLang) list = list.filter((r) => (r.language || "Unknown") === selectedLang);
    if (filterText) {
      const q = filterText.toLowerCase();
      list = list.filter((r) => `${r.full_name} ${r.description} ${r.language} ${(r.topics || []).join(" ")}`.toLowerCase().includes(q));
    }
    if (sortMode === "velocity") list.sort((a, b) => b.stars_per_day - a.stars_per_day);
    else if (sortMode === "recent") list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.stars - a.stars);
    else if (mode !== "search") list.sort((a, b) => b.stars - a.stars);
    // search mode: keep relevance order (name > description > topic, then stars) — do not re-sort by stars alone.
    return list;
  }
  function renderLangs() {
    const counts = new Map();
    for (const r of allRepos) counts.set(r.language || "Unknown", (counts.get(r.language || "Unknown") || 0) + 1);
    const langs = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    $("langChips").innerHTML = "";
    for (const [lang, n] of langs) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = `${lang} (${n})`; b.setAttribute("aria-pressed", selectedLang === lang ? "true" : "false");
      b.addEventListener("click", () => { selectedLang = selectedLang === lang ? null : lang; renderAll(); });
      $("langChips").appendChild(b);
    }
  }
  function renderTrending() {
    const list = filteredRepos();
    $("trendingCount").textContent = list.length
      ? `${list.length} repos shown from ${allRepos.length} fetched${mode === "search" ? ` for search “${currentQuery}”` : mode === "search-empty" ? " (exploration only — unrelated to your search)" : ""}.`
      : "No repos match the current filter. Clear the filter or choose All languages.";
    $("listHeading").textContent = mode === "search" ? `Search results for “${currentQuery}”` : mode === "search-empty" ? "Trending now (exploration only — unrelated to your search)" : "Trending now";
    $("trendingList").innerHTML = list.map((r) => `<article class="reporow">
      <h4><a href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.full_name)}</a></h4>
      <p>${esc(descShort(r))}</p>
      <div class="stats">
        <span class="stat">★ ${r.stars} stars</span>
        <span class="stat">${r.stars_per_day}/day</span>
        <span class="stat">${esc(r.language)}</span>
        <span class="stat">created ${fmtDate(r.created_at)}</span>
        <span class="stat">last push ${fmtDate(r.pushed_at || r.updated_at)}</span>
      </div>
      <p class="topic">Topics: ${esc((r.topics || []).join(", ") || "none listed")}</p>
      ${r._tierLabel ? `<p class="small">${esc(r._tierLabel)}${r._demoted ? " · SDK/plugin building block — ranked below end-user tools" : ""} · ${esc(strengthTier(r))} (${r.stars} stars)</p>` : ""}
      <button type="button" data-gen-repo="${esc(r.full_name)}">Generate from this repo</button>
    </article>`).join("");
    $("trendingList").querySelectorAll("[data-gen-repo]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const repo = allRepos.find((r) => r.full_name === btn.dataset.genRepo);
        if (repo) { renderPackage(repo, 0); $("packageSection").scrollIntoView({ behavior: "smooth" }); }
      });
    });
  }
  function renderIdeas() {
    // v5.3: in search mode keep the tiered merged order (tier, words, relevance, stars) — do not re-sort by stars alone, which would undo the tier ranking.
    const pool = mode === "search" ? filteredRepos() : [...filteredRepos()].sort((a, b) => b.stars - a.stars);
    const top = pool.slice(0, 10);
    $("ideasList").innerHTML = top.map((r) => {
      const idea = ideaFor(r, 0);
      return `<article class="card">
        <h3>${esc(idea.name)} <span class="small">— SUGGESTION</span></h3>
        <p>${esc(idea.pitch)}</p>
        <p class="small"><strong>Angle (hypothesis):</strong> ${esc(idea.angle.label)} — based only on listed topics/language, not a proven gap.</p>
        <p class="small">From <a href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.full_name)}</a> — ${interestLine(r)}${r._tierLabel ? ` · ${esc(r._tierLabel)}` : ""}.</p>
        <button type="button" data-gen-repo="${esc(r.full_name)}">Open full package</button>
      </article>`;
    }).join("");
    $("ideasList").querySelectorAll("[data-gen-repo]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const repo = allRepos.find((r) => r.full_name === btn.dataset.genRepo);
        if (repo) { renderPackage(repo, 0); $("packageSection").scrollIntoView({ behavior: "smooth" }); }
      });
    });
  }
  function renderAll() { renderLangs(); renderTrending(); renderIdeas(); }
  function renderPackage(repo, variant) {
    // v5.1 hard rule: never generate a package from an exploration repo.
    // An unrelated trending repo is not evidence for a search query, and
    // a package built from it is exactly the "trash, nothing evidence backed"
    // result the user reported 2026-10-24.
    if (exploration) {
      $("packageStatus").textContent = "No package generated: this repo is unrelated to your search query. A package is only generated from a repo that actually matched your search.";
      $("package").innerHTML = "";
      $("variantBtn").disabled = true;
      return;
    }
    pkgRepo = repo; pkgVariant = variant;
    pkg = packageFor(repo, variant, allRepos, { exploration, sourceLabel });
    $("packageStatus").textContent = exploration
      ? "Exploration package — this repo is unrelated to your search query. It is not evidence for it."
      : `Package generated from ${repo.full_name}. Evidence numbers are from the fetched set; name, pitch, features and stack are suggestions.`;
    $("package").innerHTML = pkg.html;
    $("variantBtn").disabled = false;
  }
  $("variantBtn").addEventListener("click", () => {
    if (!pkgRepo) return;
    renderPackage(pkgRepo, pkgVariant + 1);
  });
  $("package").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pkg-export]");
    if (!btn || !pkg) return;
    const kind = btn.dataset.pkgExport;
    const text = kind === "full" || kind === "readme" ? pkg.markdown : kind === "hn" ? pkg.hn : kind === "x" ? pkg.x : pkg.issue;
    copyText(btn, text);
  });

  function backToTrending(msg) {
    currentQuery = ""; mode = "trending"; exploration = false; allRepos = trendingRepos; selectedLang = null;
    sourceLabel = trendingSourceLabel; setSource(`Source: ${sourceLabel}.`);
    showBanner("");
    $("searchStatus").textContent = msg || "Back to trending now.";
    $("searchStages").textContent = "";
    // v5.2 stale-package fix: leaving a search also clears its package.
    pkg = null; pkgRepo = null; $("package").innerHTML = "";
    $("packageStatus").textContent = "No package yet — generate one from a repo below.";
    $("variantBtn").disabled = true;
    renderAll();
  }
  $("searchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    // v5.2 stale-package fix: a new search clears the previous package.
    pkg = null; pkgRepo = null; $("package").innerHTML = "";
    $("packageStatus").textContent = "No package yet — generate one from a repo below.";
    $("variantBtn").disabled = true;
    const q = $("query").value.trim();
    if (!q) { backToTrending("Back to trending now."); return; }
    currentQuery = q;
    $("searchStatus").textContent = `Searching live GitHub for “${q}” (all stages, name/description, all-time)…`;
    try {
      const found = await searchAllStages(q);
      const stageLines = found.stages.map((s) => {
        const contributed = found.repos.filter((r) => (r._sources || []).includes(s.label)).length;
        return `“${s.label}” — ${s.total} total matches, ${contributed} in the merged set`;
      }).join(" · ");
      $("searchStages").textContent = `Stages tried (all evaluated, merged — no first-non-empty stop): ${stageLines}. Transformed: ${found.transformed.length ? found.transformed.join(", ") : "none"} (transformed is NOT dropped — "rayban" → "ray-ban" is the same word with a hyphen). Words dropped in shorter stages: ${found.droppedInStages.length ? found.droppedInStages.map((w) => `“${w}”`).join(", ") : "none"} — repos from shorter stages are still ranked below repos matching more of your words, never hidden.`;
      if (!found.repos.length) {
        mode = "search-empty"; exploration = true; allRepos = trendingRepos;
        $("searchStatus").textContent = `No repos matched “${q}” in name or description at any stage — no idea is invented for this, and no package is generated from unrelated repos. Below are trending repos for exploration only, labelled as unrelated, NOT as evidence for your query.`;
        renderAll(); return;
      }
      mode = "search"; exploration = false; allRepos = found.repos; selectedLang = null;
      sourceLabel = `Live GitHub Search just now, all stages in:name,description, all-time, ranked by words matched, then relevance, then stars`;
      setSource(`Source: ${sourceLabel}.`);
      $("searchStatus").textContent = `Live search for “${q}”: ${found.repos.length} merged repos. Ranked by tier first (Tier A = name or topics contain 2+ of your words; Tier B = description-only match; SDK/plugin building blocks ranked one tier below end-user tools unless your topic is about SDKs/plugins), then words matched, then relevance (name 3 / description 2 / topic 1), then stars. Every repo shown contains at least one query word in its name, description or topics.`;
    } catch (err) {
      mode = "search-empty"; exploration = true; allRepos = trendingRepos;
      $("searchStatus").textContent = `Live search unavailable (${err.message}) — showing trending repos as fallback. These are NOT evidence for “${q}”, and no package is generated from them.`;
      showBanner(`Live search failed (${err.message}). Showing the trending set as fallback — do not treat it as search evidence.`);
    }
    renderAll();
  });
  $("genFromSearchBtn").addEventListener("click", () => {
    if (exploration || mode === "search-empty") { $("searchStatus").textContent = "No package: your search has no matching repos, so no package is generated from unrelated trending repos."; return; }
    if (!allRepos.length) { $("searchStatus").textContent = "No repos loaded yet — wait for trending or search results first."; return; }
    const top = mode === "search" ? allRepos[0] : [...allRepos].sort((a, b) => b.stars - a.stars)[0];
    renderPackage(top, 0);
    $("packageSection").scrollIntoView({ behavior: "smooth" });
  });
  $("clearSearchBtn").addEventListener("click", () => {
    $("query").value = ""; backToTrending("Back to trending now.");
  });

  // ---- v5.2 GAP GENERATOR handlers (hero section, above the trending list).
  // v5.2.1 rate-limit fix (2026-10-24): probes are paced at one per ~7s
  // (GitHub unauthenticated search ≈ 10/minute), a 403/429 captures GitHub's
  // X-RateLimit-Reset time, and unchecked probes can be retried on their own
  // instead of re-running the whole gap check. The status line counts probes
  // ACTUALLY checked — the v5.2 bug was claiming "all 10 checked" when 9
  // were unchecked.
  let gapPackages = [];
  let lastGapTopic = "";
  let lastGapSaturated = [];
  let lastGapProbes = [];
  let lastGapCovered = [];
  let gapRateLimitResetAt = null;
  // v5.3 topic-derived covered features: word frequency over the ALREADY
  // fetched top repos' descriptions + topics — zero extra API calls, so
  // zero rate-limit cost. Topic words and stopwords are excluded; the count
  // is repos containing the word, not raw occurrences. This is topic-aware
  // evidence (what existing repos already cover), unlike the fixed probes.
  const COVER_STOPWORDS = new Set("the a an and for to of with from by in on at into via using use used app tool tools that this these those are is was were be been can will just not more most other all any per its also than then when one two free open source based built simple fast real new".split(" "));
  function coveredFeatures(repos, topic) {
    const topicSet = new Set(queryTokens(topic));
    const counts = new Map();
    for (const r of repos) {
      const words = new Set(String(`${r.description} ${(r.topics || []).join(" ")}`).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !COVER_STOPWORDS.has(w) && !topicSet.has(w)));
      for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PROBE_DELAY_MS = 7000;
  function clearGap() {
    gapPackages = [];
    lastGapTopic = ""; lastGapSaturated = []; lastGapProbes = []; lastGapCovered = []; gapRateLimitResetAt = null;
    $("gapRetryBtn").hidden = true;
    $("gapSaturated").innerHTML = "";
    $("gapProbes").innerHTML = "";
    $("gapIdeas").innerHTML = "";
    $("gapPackageStatus").textContent = "No gap ideas yet — enter a topic above and run the gap finder.";
  }
  function gapVerdict(p) {
    if (p.total === null || p.error) return "UNCHECKED";
    if (p.total === 0 || (p.top && p.top.stars < 5)) return "MISSING";
    return "EXISTS";
  }
  function gapSummary(topic, saturated, probes, packages) {
    const checked = probes.filter((p) => p.total !== null && !p.error).length;
    const unchecked = probes.length - checked;
    const missing = probes.filter((p) => gapVerdict(p) === "MISSING").length;
    // v5.3: "saturated" is said ONLY about Established repos. The summary
    // counts the strength tiers of the top 10 so a list of 0-star repos is
    // never called saturated.
    const est = saturated.filter((r) => strengthTier(r) === "Established").length;
    const emg = saturated.filter((r) => strengthTier(r) === "Emerging").length;
    const ear = saturated.filter((r) => strengthTier(r) === "Early").length;
    let s = `Gap check done for “${topic}”: ${saturated.length} existing repos (${est} Established, ${emg} Emerging, ${ear} Early — only Established counts as truly saturated), ${checked} of ${probes.length} probes checked, ${missing} missing probe(s) → ${packages.length} gap idea(s)${packages.length ? ": " + packages.map((g) => g.name).join(", ") : ""}.`;
    if (unchecked) s += ` ${unchecked} probe(s) unchecked (rate-limited) — use “Retry unchecked probes” to check them; unchecked probes never become ideas.`;
    if (gapRateLimitResetAt) s += ` GitHub's search limit resets at ${gapRateLimitResetAt}.`;
    s += ` "Missing" means no repo found by this GitHub search (or only one under 5 stars) — not that nothing exists in the world. Trending also needs execution, timing and distribution; no idea here is guaranteed to trend.`;
    return s;
  }
  async function runGapProbes(topic, probeNames, onProgress) {
    const out = [];
    let stopped = false;
    for (let i = 0; i < probeNames.length; i++) {
      const probe = probeNames[i];
      if (stopped) { out.push({ probe, query: `${topic} ${probe}`, total: null, top: null, error: "not checked — search stopped after the rate limit" }); continue; }
      if (onProgress) onProgress(i, probe);
      await sleep(PROBE_DELAY_MS);
      try {
        const u = new URL("https://api.github.com/search/repositories");
        u.searchParams.set("q", `${topic} ${probe} in:name,description`);
        u.searchParams.set("sort", "stars");
        u.searchParams.set("order", "desc");
        u.searchParams.set("per_page", "5");
        const res = await fetchJson(u.toString());
        if (res.status === 403 || res.status === 429) {
          const reset = res.headers ? res.headers.get("x-ratelimit-reset") : null;
          if (reset) gapRateLimitResetAt = new Date(parseInt(reset, 10) * 1000).toLocaleTimeString();
          throw new Error("rate-limited");
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const items = (data.items || []).map(normalizeApiRepo);
        out.push({ probe, query: `${topic} ${probe}`, total: data.total_count || 0, top: items[0] || null });
      } catch (err) {
        out.push({ probe, query: `${topic} ${probe}`, total: null, top: null, error: `not checked — live search failed (${err.message})` });
        stopped = true;
      }
    }
    return out;
  }
  function renderGapResults(topic, saturated, probes) {
    $("gapProbes").innerHTML = `<h3>Missing-cluster probes — all 10, nothing hidden</h3>
      <p class="small">"MISSING" means this GitHub search found 0 repos, or only a repo under 5 stars. It does NOT mean nothing exists in the world. Non-missing probes are shown with their repo instead of being hidden. UNCHECKED means the search was never run (rate limit) — it is not evidence either way.</p>
      <p class="small">Probes are a fixed starter set — for topics where a probe word makes no sense (e.g. 'blur' for a CLI topic), ignore that probe; its 0 does not prove a gap.</p>
      <table class="probeTable"><thead><tr><th>Probe</th><th>Search query</th><th>Total matches</th><th>Top repo</th><th>Verdict</th></tr></thead><tbody>
      ${probes.map((p) => `<tr><td>${esc(p.probe)}</td><td><code>${esc(p.query)}</code></td><td>${p.total === null ? "—" : p.total}</td><td>${p.top ? `<a href="${esc(p.top.html_url)}" target="_blank" rel="noopener">${esc(p.top.full_name)}</a> (${p.top.stars}★)` : (p.error || "none")}</td><td class="${gapVerdict(p) === "MISSING" ? "verdict-missing" : "verdict-exists"}">${gapVerdict(p)}</td></tr>`).join("")}
      </tbody></table>`;
    const missing = probes
      .filter((p) => gapVerdict(p) === "MISSING")
      .sort((a, b) => (a.total || 0) - (b.total || 0) || ((a.top ? a.top.stars : 0) - (b.top ? b.top.stars : 0)))
      .slice(0, 5);
    if (!missing.length) {
      gapPackages = [];
      $("gapIdeas").innerHTML = "";
      $("gapPackageStatus").textContent = "No missing probes found for this topic — every checked probe returned a repo with 5+ stars, so no gap ideas are invented. (Unchecked probes, if any, are not counted as missing.)";
      $("gapStatus").textContent = gapSummary(topic, saturated, probes, []);
      $("gapRetryBtn").hidden = !probes.some((p) => p.total === null || p.error);
      return;
    }
    const langCounts = new Map();
    for (const r of saturated) langCounts.set(r.language || "Unknown", (langCounts.get(r.language || "Unknown") || 0) + 1);
    const stack = [...langCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const stackInfo = { language: stack ? stack[0] : "Unknown", count: stack ? stack[1] : 0, total: saturated.length };
    gapPackages = missing.map((p) => gapIdea(topic, p, saturated, stackInfo));
    $("gapIdeas").innerHTML = gapPackages.map((g) => g.html).join("");
    $("gapPackageStatus").textContent = `${gapPackages.length} gap idea(s) generated from the missing probes below. Each one says exactly what GitHub Search found — and what it did not.`;
    $("gapStatus").textContent = gapSummary(topic, saturated, probes, gapPackages);
    $("gapRetryBtn").hidden = !probes.some((p) => p.total === null || p.error);
  }
  $("gapForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const topic = $("gapTopic").value.trim();
    clearGap();
    // A gap run is also a new search: clear the stale spin-off package too.
    pkg = null; pkgRepo = null; $("package").innerHTML = "";
    $("packageStatus").textContent = "No package yet — generate one from a repo below.";
    $("variantBtn").disabled = true;
    if (!topic) { $("gapStatus").textContent = "Enter a topic first — for example, “Meta rayban video”."; return; }
    // v5.3 shareable URL state: the gap run's link reopens the same run.
    try { history.replaceState(null, "", "?topic=" + encodeURIComponent(topic)); } catch { /* URL state is optional */ }
    $("gapStatus").textContent = `Finding gaps for “${topic}”… first the topic's top repos, then one GitHub search per missing-cluster probe, paced at one per ~7 seconds for GitHub's ~10/minute unauthenticated limit. If it hits the limit the run stops honestly, marks the rest UNCHECKED with the reset time, and offers “Retry unchecked probes” — it never invents results.`;
    try {
      const found = await searchAllStages(topic);
      const stageLines = found.stages.map((s) => `“${s.label}” — ${s.total} total matches`).join(" · ");
      $("gapStages").textContent = `Topic stages tried (all evaluated, merged): ${stageLines}. Transformed: ${found.transformed.length ? found.transformed.join(", ") : "none"} (transformed is NOT dropped). Words dropped in shorter stages: ${found.droppedInStages.length ? found.droppedInStages.map((w) => `“${w}”`).join(", ") : "none"}. Merged ranking: tier first (name/topic match before description-only; SDK/plugin building blocks one tier below end-user tools), then words matched, then relevance, then stars.`;
      if (!found.repos.length) {
        $("gapStatus").textContent = `No repos matched “${topic}” in name or description at any stage — no gap analysis is invented, and no gap ideas are generated.`;
        return;
      }
      const saturated = found.repos.slice(0, 10);
      const covered = coveredFeatures(saturated, topic);
      lastGapCovered = covered;
      const tierCounts = { Established: 0, Emerging: 0, Early: 0 };
      for (const r of saturated) tierCounts[strengthTier(r)] += 1;
      $("gapSaturated").innerHTML = `<h3>Existing repos — what already exists for “${esc(topic)}”</h3>
        <p class="small">Top ${saturated.length} repos from the merged topic search, ranked by tier, then words matched, then relevance, then stars. Strength tiers by stars: Established 100+, Emerging 10–99, Early 0–9. This list: ${tierCounts.Established} Established, ${tierCounts.Emerging} Emerging, ${tierCounts.Early} Early — only Established counts as truly saturated; Early repos are barely started, not crowded markets.</p>
        <div class="repolist">${saturated.map((r) => `<article class="reporow">
          <h4><a href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.full_name)}</a></h4>
          <p>${esc(descShort(r))}</p>
          <p class="small">★ ${r.stars} stars · ${r.stars_per_day}/day · ${esc(r.language)} · ${esc(strengthTier(r))} · matched ${r._matched} of ${queryTokens(topic).length} topic words · from stage(s): ${esc((r._sources || []).join(", "))}${r._tierLabel ? ` · ${esc(r._tierLabel)}` : ""}${r._demoted ? " · SDK/plugin building block — ranked below end-user tools" : ""}</p>
        </article>`).join("")}</div>
        <h4>What the existing repos already cover (from their own descriptions/topics, no extra searches)</h4>
        ${covered.length ? `<p class="small">${covered.map(([w, n]) => `${esc(w)} (${n} repos)`).join(" · ")}</p>` : `<p class="small">No shared descriptive words found among these repos' descriptions/topics.</p>`}
        <p class="small">Covered words come from the repos already fetched for this topic — they cost zero extra GitHub searches. A word appearing here means existing repos already talk about it; it does not mean the feature is well built.</p>`;
      // Missing-cluster probes, one search each, in order, PACED at one per
      // ~7s (GitHub unauthenticated search ≈ 10/minute). A 403/429 stops the
      // run, captures GitHub's reset time, and leaves the rest UNCHECKED —
      // never invented. "Retry unchecked probes" re-runs only those.
      lastGapTopic = topic; lastGapSaturated = saturated;
      const probes = await runGapProbes(topic, GAP_PROBES, (pi, probe) => {
        $("gapStatus").textContent = `Finding gaps for “${topic}”… checking probe ${pi + 1} of ${GAP_PROBES.length} (“${probe}”) — paced at one search per ~7 seconds for GitHub's limit.`;
      });
      lastGapProbes = probes;
      renderGapResults(topic, saturated, probes);
    } catch (err) {
      $("gapStatus").textContent = `Gap check failed (${err.message}) — no gap ideas are invented from a failed search. Try again in a minute if this was a rate limit.`;
    }
  });
  $("gapClearBtn").addEventListener("click", () => {
    $("gapTopic").value = ""; $("gapStatus").textContent = ""; $("gapStages").textContent = ""; clearGap();
    try { history.replaceState(null, "", location.pathname); } catch { /* URL state is optional */ }
  });
  // v5.3 shareable gap report: plain text, no accounts, no backend, no
  // tracking — the link in it reopens the same gap run via ?topic=.
  $("gapReportBtn").addEventListener("click", () => {
    if (!lastGapTopic) { $("gapPackageStatus").textContent = "No gap report yet — run the gap finder first."; return; }
    const lines = [];
    lines.push(`TrendGap gap report — topic: ${lastGapTopic}`);
    lines.push(`Page: ${location.href}`);
    lines.push("");
    lines.push("Existing repos (top 5):");
    for (const r of [...lastGapSaturated].sort((a, b) => b.stars - a.stars).slice(0, 5)) lines.push(`- ${r.full_name} — ${r.stars} stars, ${r.stars_per_day}/day (${strengthTier(r)})`);
    lines.push("");
    lines.push("Probes:");
    for (const p of lastGapProbes) lines.push(`- ${p.probe}: total ${p.total === null ? "unchecked" : p.total} — ${gapVerdict(p)}${p.top ? ` (nearest: ${p.top.full_name}, ${p.top.stars} stars)` : ""}`);
    if (lastGapCovered.length) { lines.push(""); lines.push("What existing repos already cover: " + lastGapCovered.map(([w, n]) => `${w} (${n} repos)`).join(", ")); }
    lines.push("");
    lines.push("Gap ideas:");
    if (!gapPackages.length) lines.push("- none (no missing probes checked)");
    for (const g of gapPackages) {
      lines.push(`- ${g.name} (${g.probe}):`);
      for (const pt of (g.evidencePoints || [])) lines.push(`  - ${pt}`);
      lines.push(`  - What could kill it: ${g.killLine}`);
    }
    lines.push("");
    lines.push("Note: a gap means no repo found by this GitHub search (or only one under 5 stars) — not that nothing exists in the world. No idea here is guaranteed to trend.");
    copyText($("gapReportBtn"), lines.join("\n"));
  });
  $("gapRetryBtn").addEventListener("click", async () => {
    if (!lastGapTopic || !lastGapProbes.length) return;
    $("gapRetryBtn").disabled = true;
    const unchecked = lastGapProbes.filter((p) => p.total === null || p.error).map((p) => p.probe);
    if (!unchecked.length) { $("gapRetryBtn").disabled = false; return; }
    $("gapStatus").textContent = `Retrying ${unchecked.length} unchecked probe(s) for “${lastGapTopic}”… paced at one search per ~7 seconds for GitHub's limit.`;
    const retried = await runGapProbes(lastGapTopic, unchecked, (pi, probe) => {
      $("gapStatus").textContent = `Retrying unchecked probe ${pi + 1} of ${unchecked.length} (“${probe}”)…`;
    });
    const byProbe = new Map(retried.map((p) => [p.probe, p]));
    lastGapProbes = lastGapProbes.map((p) => byProbe.get(p.probe) || p);
    renderGapResults(lastGapTopic, lastGapSaturated, lastGapProbes);
    $("gapRetryBtn").disabled = false;
  });
  $("gapIdeas").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-gap-export]");
    if (!btn) return;
    const cards = [...$("gapIdeas").querySelectorAll(".package")];
    const idx = cards.indexOf(btn.closest(".package"));
    const g = gapPackages[idx];
    if (!g) return;
    const kind = btn.dataset.gapExport;
    const text = kind === "full" || kind === "readme" ? g.markdown : kind === "hn" ? g.hn : g.x;
    copyText(btn, text);
  });
  $("filterText").addEventListener("input", (e) => { filterText = e.target.value.trim().toLowerCase(); renderTrending(); renderIdeas(); });
  $("sortSel").addEventListener("change", (e) => { sortMode = e.target.value; renderTrending(); });
  $("allLangsBtn").addEventListener("click", () => { selectedLang = null; renderAll(); });

  await loadTrending();
  allRepos = trendingRepos;
  if (trendingRepos.length && sourceLabel.includes("Snapshot")) mode = "fallback";
  $("sourcesNote").textContent = `Sources: ${sourceLabel}. Live search: GitHub Search API, no key, cached 1 hour. Fallback: data/snapshot.json (daily workflow).`;
  renderAll();
  // v5.3 URL state: ?topic=... from a shared gap-report link fills the gap
  // topic and auto-runs the gap finder exactly once (only if the input was
  // empty, so a typed topic is never overwritten).
  try {
    const urlTopic = new URLSearchParams(location.search).get("topic");
    if (urlTopic && !$("gapTopic").value) {
      $("gapTopic").value = urlTopic;
      if ($("gapForm").requestSubmit) $("gapForm").requestSubmit();
      else $("gapBtn").click();
    }
  } catch { /* URL state is optional */ }
}
main().catch((e) => {
  const el = $("sourceStatus");
  if (el) el.textContent = "Page failed to start: " + e.message;
});
