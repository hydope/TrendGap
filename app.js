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

// ---- v5.1 search: staged, relevance-ranked, all-time for topics.
// v5's bug, proven 2026-10-24 for "Meta rayban video connect": raw keywords +
// a 7-day window returned ZERO repos, so the page fell back to unrelated
// trending repos. Real evidence exists all-time (ray-ban in name/description:
// 941 repos; topic ray-ban-meta: 32), so a topic search must NOT be limited
// to 7 days, and must NEVER generate a package from an unrelated repo.
// Stages, in order, first non-empty wins — and the stage actually used is
// always shown to the user, including which words were dropped:
//   1. full query, in:name,description
//   2. "rayban" -> "ray-ban" variant of the full query (GitHub tokenises hyphens)
//   3. progressively dropping the last word ("Meta rayban video", "Meta rayban", …)
// Each stage is then relevance-scored and filtered: a repo only counts if a
// query word actually appears in its name, description or topics.
function searchStages(query) {
  const tokens = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const stages = [];
  const push = (toks) => { if (toks.length) stages.push(toks.join(" ")); };
  push(tokens);
  if (tokens.includes("rayban")) push(tokens.map((t) => (t === "rayban" ? "ray-ban" : t)));
  for (let n = tokens.length - 1; n >= 1; n--) push(tokens.slice(0, n));
  return [...new Set(stages)];
}
function normFlat(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function relevanceScore(repo, stageQuery) {
  const tokens = stageQuery.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(normFlat);
  const name = normFlat(repo.name);
  const desc = normFlat(repo.description);
  const topics = normFlat((repo.topics || []).join(" "));
  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    if (name.includes(t)) score += 3;
    if (desc.includes(t)) score += 2;
    if (topics.includes(t)) score += 1;
  }
  return score;
}
async function stagedSearch(query) {
  const stages = searchStages(query);
  for (const stage of stages) {
    const u = new URL("https://api.github.com/search/repositories");
    u.searchParams.set("q", `${stage} in:name,description`);
    u.searchParams.set("sort", "stars");
    u.searchParams.set("order", "desc");
    u.searchParams.set("per_page", "20");
    const res = await fetchJson(u.toString());
    if (res.status === 403 || res.status === 429) throw new Error("rate-limited");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const scored = (data.items || [])
      .map(normalizeApiRepo)
      .map((r) => ({ repo: r, score: relevanceScore(r, stage) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.repo.stars - a.repo.stars);
    if (scored.length) {
      return { repos: scored.map((x) => x.repo), stage, total: data.total_count || scored.length,
        dropped: stage === query.toLowerCase() ? [] : query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).filter((t) => !stage.toLowerCase().split(/[^a-z0-9]+/).includes(t)) };
    }
  }
  return { repos: [], stage: null, total: 0, dropped: [] };
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
function interestScore(repo, repos) {
  const maxVel = Math.max(1, ...repos.map((r) => r.stars_per_day));
  const maxStars = Math.max(1, ...repos.map((r) => r.stars));
  return Math.round(50 * (repo.stars_per_day / maxVel) + 50 * (repo.stars / maxStars));
}
function packageFor(repo, variant, repos, opts) {
  const idea = ideaFor(repo, variant);
  const angle = idea.angle;
  const score = interestScore(repo, repos);
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
  const markdown = `# ${idea.name}\n\n${idea.pitch}\n\nSUGGESTION — only the evidence numbers are data.\n\n${explorationNote}## README outline\n\nProblem → Solution → Features → Demo → Evidence → Differentiation.\n\n## Problem / solution\n\n${idea.pitch}\n\n## Features (suggestions, tied to the source repo — not evidence)\n\n${features.map((f) => `- ${f}`).join("\n")}\n\n## Suggested stack\n\n${repo.language} (the source repo's language, from GitHub — the reason is that the idea is a spin-off of a ${repo.language} repo, not a market claim).\n\n## 72-hour MVP\n\nBuild: core ${angle.label.toLowerCase()} in ${repo.language}; one demo; docs + worked example.\nCut: accounts, payments, AI generation, mobile app (unless the angle itself is mobile — then cut accounts, payments, AI generation).\n\n## Evidence\n\n- Source repo: ${repo.full_name} — ${repo.html_url}\n- Stars: ${repo.stars}; stars/day: ${repo.stars_per_day} (stars ÷ ${repo.age_days} days); created ${fmtDate(repo.created_at)}; last push ${fmtDate(repo.pushed_at || repo.updated_at)}\n- Language: ${repo.language}; topics: ${(repo.topics || []).join(", ") || "none listed"}\n- Interest signal: ${score}/100 (ESTIMATE, relative to the ${repos.length} repos fetched, not to all of GitHub)\n- Source: ${opts && opts.sourceLabel ? opts.sourceLabel : "fetched set"}\n- Top competitors in fetched set:\n${comps.length ? comps.map((r) => `  - ${r.full_name} — ${r.stars} stars, ${r.stars_per_day}/day, last push ${fmtDate(r.pushed_at || r.updated_at)}`).join("\n") : "  None in this fetched set — marked unchecked, not “no competitors exist”."}\n\n## Differentiation hypothesis (not proven)\n\n${hypothesis}\n`;
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
      <p>Interest signal: ${score}/100 (ESTIMATE, relative to the ${repos.length} repos fetched, not to all of GitHub).</p>
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
    html, markdown, repo, angle, score,
    hn: `Show HN: ${idea.name} — ${idea.pitch}`,
    x: `${idea.name}: ${idea.pitch} (Suggestion — evidence in TrendGap, not proof of a gap.)`,
    issue: `## Plan: ${idea.name}\n\nPitch: ${idea.pitch}\n\n72-hour MVP — Build: core, one demo, docs + example. Cut: accounts, payments, AI generation.\n\nInterest signal: ${score}/100 (ESTIMATE, relative to the fetched set). Differentiation hypothesis: see package — hypothesis, not proven.`,
  };
}
async function copyText(btn, text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove();
  }
  const old = btn.textContent; btn.textContent = "Copied"; setTimeout(() => { btn.textContent = old; }, 1500);
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
    const top = [...filteredRepos()].sort((a, b) => b.stars - a.stars).slice(0, 10);
    $("ideasList").innerHTML = top.map((r) => {
      const idea = ideaFor(r, 0);
      const score = interestScore(r, allRepos);
      return `<article class="card">
        <h3>${esc(idea.name)} <span class="small">— SUGGESTION</span></h3>
        <p>${esc(idea.pitch)}</p>
        <p class="small"><strong>Angle (hypothesis):</strong> ${esc(idea.angle.label)} — based only on listed topics/language, not a proven gap.</p>
        <p class="small">From <a href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.full_name)}</a> — ${r.stars} stars, ${r.stars_per_day}/day, interest ${score}/100 (relative to the ${allRepos.length} fetched).</p>
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
    renderAll();
  }
  $("searchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("query").value.trim();
    if (!q) { backToTrending("Back to trending now."); return; }
    currentQuery = q;
    $("searchStatus").textContent = `Searching live GitHub for “${q}” (name/description, all-time, relevance-ranked)…`;
    try {
      const found = await stagedSearch(q);
      if (!found.repos.length) {
        mode = "search-empty"; exploration = true; allRepos = trendingRepos;
        $("searchStatus").textContent = `No repos matched “${q}” in name or description, even after trying shorter queries — no idea is invented for this, and no package is generated from unrelated repos. Below are trending repos for exploration only, labelled as unrelated, NOT as evidence for your query.`;
        renderAll(); return;
      }
      mode = "search"; exploration = false; allRepos = found.repos; selectedLang = null;
      const droppedNote = found.dropped.length ? ` (exact query matched 0 — dropped ${found.dropped.map((w) => `“${w}”`).join(", ")}; results are for “${found.stage}”)` : "";
      sourceLabel = `Live GitHub Search just now, query “${found.stage}” in:name,description, all-time, relevance-ranked (name match > description match > topic match), then stars`;
      setSource(`Source: ${sourceLabel}.`);
      $("searchStatus").textContent = `Live search for “${q}”: ${found.repos.length} repos (of ${found.total} total matches)${droppedNote}. Every repo shown contains a query word in its name, description or topics — repos with no word match are filtered out.`;
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
  $("filterText").addEventListener("input", (e) => { filterText = e.target.value.trim().toLowerCase(); renderTrending(); renderIdeas(); });
  $("sortSel").addEventListener("change", (e) => { sortMode = e.target.value; renderTrending(); });
  $("allLangsBtn").addEventListener("click", () => { selectedLang = null; renderAll(); });

  await loadTrending();
  allRepos = trendingRepos;
  if (trendingRepos.length && sourceLabel.includes("Snapshot")) mode = "fallback";
  $("sourcesNote").textContent = `Sources: ${sourceLabel}. Live search: GitHub Search API, no key, cached 1 hour. Fallback: data/snapshot.json (daily workflow).`;
  renderAll();
}
main().catch((e) => {
  const el = $("sourceStatus");
  if (el) el.textContent = "Page failed to start: " + e.message;
});
