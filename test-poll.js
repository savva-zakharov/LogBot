// test-poll.js
// Polls WT leaderboard (every 15s) and clan page, extracts metrics, writes to JSON log.

const fs = require('fs');
const path = require('path');

const LB_URL = 'https://warthunder.com/en/community/getclansleaderboard/dif/_hist/page/2/sort/dr_era5';
const CLAN_URL = 'https://warthunder.com/en/community/claninfo/Try%20Hard%20Coalition';
const TARGET_TAGL = 'xthcx'; // search in "tagl"
const OUT_FILE = path.join(process.cwd(), 'poll_metrics.json');
const INTERVAL_MS = 15_000;

// Keep last seen values to detect which source updated first
let LAST_API_VAL = null;
let LAST_WEB_VAL = null;
let LAST_DIFF_KEY = null; // remembers last emitted pair "api|web" to avoid duplicate posts

async function fetchWithTimeout(url, opts = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(opts.headers || {}),
      },
    });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function getDrEra5Hist() {
  try {
    const res = await fetchWithTimeout(LB_URL, {}, 12_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json().catch(() => null);
    if (!json) throw new Error('Invalid JSON');
    // API shape: { status: 'ok', data: [...] }
    const ok = (json && (json.status === 'ok' || json.ok === true));
    const rows = ok && Array.isArray(json.data) ? json.data : [];
    const norm = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    const item = rows.find(r => norm(r.tagl || r.tag) === TARGET_TAGL);
    if (!item) return null;
    const val = item && item.astat ? item.astat.dr_era5_hist : null;
    return Number.isFinite(val) ? val : (val != null ? Number(val) : null);
  } catch (e) {
    console.warn('[poll] getDrEra5Hist error:', e.message || e);
    return null;
  }
}

async function getSquadronRating() {
  try {
    const res = await fetchWithTimeout(CLAN_URL, {}, 12_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Try multiple patterns
    const patterns = [
      /Squadron\s*rating[^\d]*([\d,.]+)/i,
      /Squadron\s*Rank[^\d]*([\d,.]+)/i,
      /Rating[^\d]*([\d,.]+)\s*points/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) {
        const raw = m[1].replace(/,/g, '');
        const num = Number(raw);
        if (Number.isFinite(num)) return num;
      }
    }
    return null;
  } catch (e) {
    console.warn('[poll] getSquadronRating error:', e.message || e);
    return null;
  }
}

function appendOutput(entry) {
  try {
    let obj = { entries: [] };
    if (fs.existsSync(OUT_FILE)) {
      try {
        const raw = fs.readFileSync(OUT_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.entries)) obj = parsed;
      } catch (_) {}
    }
    obj.entries.push(entry);
    // Cap to last 1000 entries
    if (obj.entries.length > 1000) obj.entries = obj.entries.slice(-1000);
    fs.writeFileSync(OUT_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[poll] failed to write output:', e.message || e);
  }
}

async function tick() {
  const ts = new Date().toISOString();
  const [drEra5Hist, squadronRating] = await Promise.all([
    getDrEra5Hist(),
    getSquadronRating(),
  ]);
  // Determine whether to emit (only when a difference is detected and it's new)
  const bothPresent = Number.isFinite(drEra5Hist) && Number.isFinite(squadronRating);
  const isDifferent = bothPresent && drEra5Hist !== squadronRating;
  const key = isDifferent ? `${drEra5Hist}|${squadronRating}` : null;

  if (isDifferent && key !== LAST_DIFF_KEY) {
    // Determine which source changed vs its previous value
    let prefix = '';
    let first = null; // 'api' | 'web' | 'both' | 'unknown'
    const apiChanged = (LAST_API_VAL !== null && drEra5Hist !== LAST_API_VAL);
    const webChanged = (LAST_WEB_VAL !== null && squadronRating !== LAST_WEB_VAL);
    if (apiChanged && !webChanged) { prefix = '🅰️'; first = 'api'; }
    else if (!apiChanged && webChanged) { prefix = '🔡'; first = 'web'; }
    else if (apiChanged && webChanged) { prefix = '⚠️'; first = 'both'; }
    else { prefix = 'ℹ️'; first = 'unknown'; }

    console.log(`${prefix} diff detected at ${ts}: api(dr_era5_hist)=${drEra5Hist} vs web(squadron_rating)=${squadronRating}`);

    const entry = { ts, dr_era5_hist: drEra5Hist, squadron_rating: squadronRating, diff: { present: true, first } };
    appendOutput(entry);
    LAST_DIFF_KEY = key;
  }
  // Update last seen values after logging
  if (Number.isFinite(drEra5Hist)) LAST_API_VAL = drEra5Hist;
  if (Number.isFinite(squadronRating)) LAST_WEB_VAL = squadronRating;
}

(async () => {
  // run immediately, then at interval
  await tick();
  setInterval(tick, INTERVAL_MS);
})();
