const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => { try { return new Date(d).toISOString().slice(0, 10); } catch { return 'unknown date'; } };
const clean = (s) => String(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
const SUFFIXES = ['Kit', 'Lens', 'Forge', 'Flow', 'Scope', 'Lab', 'Base', 'Wave', 'Pilot', 'Dock'];
const PITCHES = [
  (sig, top) => `A focused ${sig} tool that does one job well, inspired by ${top} — small, documented, and aimed at the use the top repos leave rough.`,
  (sig, top) => `A starter + workflow for ${sig} work, built around what made ${top} spread — with the setup friction removed.`,
  (sig, top) => `A practical ${sig} utility for everyday builders, taking the core idea behind ${top} and cutting it down to a single clear job.`,
  (sig, top) => `A ${sig} helper that packages the pattern behind ${top} so a new project can start from a working example, not a blank page.`,
  (sig, top) => `A narrow ${sig} tool for a specific audience, learning from ${top} and deliberately skipping the features that bloat it.`,
];

function matchingRepos(snap, sig) {
  return snap.repos.filter((r) => r.language === sig.name || (r.topics || []).includes(sig.name.toLowerCase()) || (r.topics || []).includes(sig.name));
}
function signalStats(snap, sig) {
  const m = matchingRepos(snap, sig);
  const total = m.reduce((a, r) => a + r.stars, 0);
  const avgVel = m.length ? m.reduce((a, r) => a + r.stars_per_day, 0) / m.length : 0;
  return { m, total, avgVel, mentions: sig.hn_mentions + sig.devto_mentions };
}
function buildCards(snap) {
  // Deterministic: signals sorted by count, then total stars — no preset stack, no randomness.
  const withStats = snap.rising.map((sig) => ({ sig, ...signalStats(snap, sig) }));
  withStats.sort((a, b) => (b.sig.count_in_snapshot - a.sig.count_in_snapshot) || (b.total - a.total) || a.sig.name.localeCompare(b.sig.name));
  const maxVel = Math.max(1, ...withStats.map((x) => x.avgVel));
  const maxTotal = Math.max(1, ...withStats.map((x) => x.total));
  return withStats.slice(0, 10).map((x, i) => {
    const top = [...x.m].sort((a, b) => b.stars - a.stars)[0];
    const score = Math.round(50 * (x.avgVel / maxVel) + 30 * (x.total / maxTotal) + 20 * (Math.min(x.mentions, 5) / 5));
    const comps = [...x.m].sort((a, b) => b.stars - a.stars).slice(0, 3);
    return {
      name: clean(x.sig.name) + SUFFIXES[i % SUFFIXES.length],
      signal: x.sig.name, kind: x.sig.kind, score, avgVel: x.avgVel, total: x.total, mentions: x.mentions,
      hn: x.sig.hn_mentions, devto: x.sig.devto_mentions,
      pitch: PITCHES[i % PITCHES.length](x.sig.name, top ? top.full_name : 'the snapshot sample'),
      topRepo: top || null, comps,
      hypothesis: top
        ? `Differentiation hypothesis (not proven): focus on the narrow job inside “${esc(top.description || top.full_name)}” and ship it with better docs and a single demo, instead of matching the top repos feature-for-feature.`
        : 'Differentiation hypothesis (not proven): no matching repo in this snapshot sample — verify against a wider search before building.',
    };
  });
}
function drawHeat(canvas, snap, cards) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, rows = Math.max(cards.length, 1), rh = Math.floor(300 / rows);
  ctx.clearRect(0, 0, w, canvas.height);
  ctx.font = '13px system-ui'; ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--fg') || '#111';
  ctx.fillText('Signal', 10, 22); ctx.fillText('Rising (velocity)', 260, 22); ctx.fillText('Saturated (count in sample)', 560, 22);
  const maxVel = Math.max(1, ...cards.map((c) => c.avgVel));
  const maxCount = Math.max(1, ...snap.rising.slice(0, 10).map((s) => s.count_in_snapshot));
  cards.forEach((c, i) => {
    const y = 30 + i * rh;
    const sig = snap.rising.find((s) => s.name === c.signal);
    const rising = c.avgVel / maxVel, sat = (sig ? sig.count_in_snapshot : 1) / maxCount;
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--fg') || '#111';
    ctx.fillText(c.signal.slice(0, 22), 10, y + rh / 2);
    ctx.fillStyle = `rgba(26,92,58,${0.15 + 0.85 * rising})`; ctx.fillRect(260, y + 4, 220 * rising + 20, rh - 8);
    ctx.fillStyle = `rgba(160,60,20,${0.15 + 0.85 * sat})`; ctx.fillRect(560, y + 4, 220 * sat + 20, rh - 8);
    ctx.fillStyle = '#fff'; ctx.fillText(`${c.avgVel.toFixed(1)}/day`, 266, y + rh / 2); ctx.fillText(`${sig ? sig.count_in_snapshot : 0} in sample`, 566, y + rh / 2);
  });
}
async function copyText(btn, text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
  const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1500);
}
function cardHtml(c, snapDate) {
  const compHtml = c.comps.length ? c.comps.map((r) => `<li><a href="${esc(r.html_url)}">${esc(r.full_name)}</a> — ${r.stars} stars, ${r.stars_per_day}/day, last activity ${fmtDate(r.pushed_at || r.updated_at)}.</li>`).join('')
    : '<li>None in this snapshot sample — marked unchecked, not “no competitors exist”.</li>';
  const pad = c.comps.length < 3 ? `<li>${3 - c.comps.length} further competitor slot(s): unchecked in this snapshot sample.</li>` : '';
  return `<article class="card" data-signal="${esc(c.signal)}">
    <h3>${esc(c.name)} <span class="small">— SUGGESTION</span></h3>
    <p>${esc(c.pitch)}</p>
    <p><strong>Interest signal: ${c.score}/100 — ESTIMATE, not a virality prediction.</strong><br><span class="small">Components: avg velocity ${c.avgVel.toFixed(1)}/day; sample stars ${c.total}; HN title mentions ${c.hn}; dev.to title mentions ${c.devto}. Triggering evidence: ${c.topRepo ? esc(c.topRepo.full_name) + ' (' + c.topRepo.stars + ' stars, created ' + fmtDate(c.topRepo.created_at) + ')' : 'none in snapshot sample'}; snapshot generated ${snapDate}.</span></p>
    <p><strong>72-hour MVP — Build:</strong> core in ${esc(c.signal)}; one demo from the snapshot evidence; docs + worked example. <strong>Cut:</strong> accounts, payments, AI generation, mobile app.</p>
    <p><strong>Top 3 in snapshot sample:</strong></p><ul>${compHtml}${pad}</ul>
    <p><strong>Differentiation hypothesis:</strong> ${c.hypothesis}</p>
    <div class="export">
      <button type="button" data-export="readme">Copy README hook</button>
      <button type="button" data-export="hn">Copy HN title</button>
      <button type="button" data-export="x">Copy X opener</button>
      <button type="button" data-export="issue">Copy as GitHub issue/plan</button>
    </div></article>`;
}
function exportText(kind, c) {
  if (kind === 'readme') return `# ${c.name}\n\n${c.pitch}\n\nSUGGESTION — evidence numbers only are data. Interest signal ${c.score}/100 (ESTIMATE). See TrendGap snapshot for sources.`;
  if (kind === 'hn') return `Show HN: ${c.name} — ${c.pitch}`;
  if (kind === 'x') return `${c.name}: ${c.pitch} (Suggestion — evidence in TrendGap snapshot, not proof of a gap.)`;
  return `## Plan: ${c.name}\n\nPitch: ${c.pitch}\n\n72-hour MVP — Build: core, one demo, docs + example. Cut: accounts, payments, AI generation, mobile app.\n\nInterest signal: ${c.score}/100 (ESTIMATE). Differentiation hypothesis: see TrendGap card — hypothesis, not proven.`;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const darkParam = params.get('dark');
  if (darkParam === '1' || (darkParam !== '0' && localStorage.getItem('trendgap-dark') === '1')) document.body.classList.add('dark');
  $('#darkToggle').textContent = document.body.classList.contains('dark') ? 'Light mode' : 'Dark mode';
  $('#darkToggle').addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('trendgap-dark', document.body.classList.contains('dark') ? '1' : '0');
    $('#darkToggle').textContent = document.body.classList.contains('dark') ? 'Light mode' : 'Dark mode';
    const u = new URLSearchParams(location.search); u.set('dark', document.body.classList.contains('dark') ? '1' : '0'); history.replaceState(null, '', '?' + u.toString());
    render();
  });

  let snap = null, render;
  try {
    const res = await fetch('data/snapshot.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('snapshot HTTP ' + res.status);
    snap = await res.json();
  } catch (e) {
    $('#freshness').textContent = 'Snapshot could not be loaded. Serve this folder over HTTP (for example: python3 -m http.server) and reload — the page does not work from file:// for the snapshot fetch.';
    $('#banner').hidden = false; $('#banner').textContent = 'No data yet — snapshot could not be loaded. Nothing below is presented as real data.';
    return;
  }
  const gen = new Date(snap.generated_at);
  const hours = Number.isFinite(gen.getTime()) ? (Date.now() - gen.getTime()) / 3600000 : NaN;
  const snapDate = fmtDate(snap.generated_at);
  const stale = Number.isFinite(hours) && hours > 24;
  $('#freshness').textContent = Number.isFinite(hours)
    ? `Snapshot updated ${hours < 1 ? 'less than 1h' : Math.floor(hours) + 'h'} ago (${snap.generated_at}). ${snap.sample_note || ''}`
    : `Snapshot date unknown (${snap.generated_at}). Treat as stale.`;
  if (stale || !Number.isFinite(hours)) { $('#banner').hidden = false; $('#banner').textContent = 'Stale snapshot (>24h old or undated) — numbers are from the last build, not live. Rebuild data/snapshot.json before relying on them.'; }
  if (snap.unavailable_sources && snap.unavailable_sources.length) {
    $('#liveNote').textContent = 'Unavailable at build time: ' + snap.unavailable_sources.map((s) => s.name + ' (' + s.reason + ')').join('; ') + '. The page degrades to the remaining snapshot sources.';
  }
  $('#sources').innerHTML = 'Sources at build time: ' + (snap.sources || []).map((s) => `${esc(s.name)} — ${esc(s.status)}`).join('; ') + '.';

  const allCards = buildCards(snap);
  // Default = all 10 card signals (from the snapshot top), so 10 cards show on load; user can deselect to filter.
  const defaultSignals = allCards.map((c) => c.signal);
  let selected = new Set((params.get('topics') ? params.get('topics').split(',').filter(Boolean) : defaultSignals));
  const chipsEl = $('#chips');
  const signals = [...new Set(allCards.map((c) => c.signal))];
  signals.forEach((sig) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = sig; b.setAttribute('aria-pressed', selected.has(sig) ? 'true' : 'false');
    b.addEventListener('click', () => { selected.has(sig) ? selected.delete(sig) : selected.add(sig); syncUrl(); render(); });
    chipsEl.appendChild(b);
  });
  $('#allChips').addEventListener('click', () => { selected = new Set(signals); syncUrl(); render(); });
  function syncUrl() {
    const u = new URLSearchParams(location.search);
    u.set('topics', [...selected].join(',')); u.set('dark', document.body.classList.contains('dark') ? '1' : '0');
    history.replaceState(null, '', '?' + u.toString());
    [...chipsEl.children].forEach((b) => b.setAttribute('aria-pressed', selected.has(b.textContent) ? 'true' : 'false'));
  }
  render = () => {
    const shown = selected.size ? allCards.filter((c) => selected.has(c.signal)) : allCards;
    if (!allCards.length) {
      $('#emptyNote').hidden = false; $('#emptyNote').textContent = 'No data yet — this snapshot is empty. No idea cards can be generated from an empty snapshot, and none are invented here.';
      $('#cards').innerHTML = ''; return;
    }
    $('#emptyNote').hidden = true;
    $('#cards').innerHTML = shown.map((c) => cardHtml(c, snapDate)).join('') || '<p>No cards match the selected topics. Choose “All” to reset.</p>';
    drawHeat($('#heat'), snap, shown.length ? shown : allCards);
    document.querySelectorAll('[data-export]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cardEl = btn.closest('.card'); const card = allCards.find((c) => c.name === cardEl.querySelector('h3').textContent.split(' —')[0]);
        if (card) copyText(btn, exportText(btn.dataset.export, card));
      });
    });
  };
  syncUrl(); render();

  // Live-call attempt: one GitHub Search call, snapshot stays the source of truth.
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 8000);
    const r = await fetch('https://api.github.com/search/repositories?q=created:%3E2026-10-17&sort=stars&order=desc&per_page=1', { signal: ctl.signal });
    $('#liveNote').textContent = (r.ok ? 'Live check: GitHub Search API reachable just now. ' : 'Live calls unavailable just now (GitHub returned ' + r.status + ') — showing the snapshot. ') + ($('#liveNote').textContent || '');
  } catch {
    $('#liveNote').textContent = 'Live calls unavailable just now (network or CORS) — showing the snapshot. ' + ($('#liveNote').textContent || '');
  }
}
main().catch((e) => { $('#freshness').textContent = 'Page failed to start: ' + e.message; });
