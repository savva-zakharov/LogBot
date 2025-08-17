// src/squadronTracker.js
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const { loadSettings } = require('./config');
const { autoIssueAfterSnapshot } = require('./lowPointsIssuer');

// --- Module constants ---
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 60_000;
const DAILY_CUTOFF_MIN = 23 * 60 + 30; // 23:30 UTC
const HTML_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
};

// Lazy accessor to avoid circular dependency at module load, memoized
let __discordSendChecked = false;
let __discordSendFn = null;
let __discordWinLossChecked = false;
let __discordWinLossFn = null;
let __discordWLUpdateChecked = false;
let __discordWLUpdateFn = null;
let __discordWLClearFn = null;

// --- Session state (W/L and starting points) ---
// Resets at daily cutoff. In-memory only.
const __session = {
  startedAt: null,           // Date
  dateKey: null,             // YYYY-MM-DD
  startingPoints: null,      // number
  wins: 0,
  losses: 0,
  windowKey: null,           // e.g., 2025-08-17|EU or 2025-08-17|US
};

// --- Session window helpers (US: 02:00–10:00 UTC, EU: 14:00–22:00 UTC) ---
function utcMinutes(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

// Given a Date, return the active window { label, start, end, key } or null if outside windows
function getCurrentWindow(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const baseKey = `${y}-${m}-${d}`;
  const mins = utcMinutes(now);
  const mkDate = (h, min) => new Date(Date.UTC(y, now.getUTCMonth(), now.getUTCDate(), h, min, 0, 0));
  // US window: 02:00–10:00
  const usStart = mkDate(2, 0);
  const usEnd = mkDate(10, 0);
  // EU window: 14:00–22:00
  const euStart = mkDate(14, 0);
  const euEnd = mkDate(22, 0);
  if (mins >= 120 && mins < 600) {
    return { label: 'US', start: usStart, end: usEnd, key: `${baseKey}|US` };
  }
  if (mins >= 14 * 60 && mins < 22 * 60) {
    return { label: 'EU', start: euStart, end: euEnd, key: `${baseKey}|EU` };
  }
  return null;
}

function parseWindowKey(windowKey) {
  if (!windowKey || typeof windowKey !== 'string') return null;
  const [dateKey, label] = windowKey.split('|');
  if (!dateKey || !label) return null;
  const [y, m, d] = dateKey.split('-').map(x => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const mk = (h, min) => new Date(Date.UTC(y, m - 1, d, h, min, 0, 0));
  if (label === 'US') return { label, start: mk(2, 0), end: mk(10, 0), key: windowKey };
  if (label === 'EU') return { label, start: mk(14, 0), end: mk(22, 0), key: windowKey };
  return null;
}

function isWithinWindow(ts, window) {
  if (!window) return false;
  const t = ts instanceof Date ? ts : new Date(ts);
  return t >= window.start && t < window.end;
}

// Build summary lines using points_change events within the window
function buildWindowSummaryLines(events, window) {
  const lines = [];
  let cumWins = 0;
  let cumLosses = 0;
  let sessionDelta = 0;
  const pad = (n) => String(n).padStart(2, '0');
  for (const ev of events) {
    const d = new Date(ev.ts);
    const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    const delta = Number(ev.delta || 0);
    sessionDelta += delta;
    cumWins += Number(ev.matchesWon || 0);
    cumLosses += Number(ev.matchesLost || 0);
    const ptsStr = (delta >= 0 ? `+ ${delta} points` : `- ${Math.abs(delta)} points`).padEnd(13, ' ');
    const wlStr = `${cumWins}/${cumLosses}`.padEnd(6, ' ');
    const timeStr = hhmm.padEnd(7, ' ');
    const sessStr = String(sessionDelta).padEnd(9, ' ');
    let matchText = 'no matches';
    const won = Number(ev.matchesWon || 0);
    const lost = Number(ev.matchesLost || 0);
    if (won > 0) matchText = `${won} match${won > 1 ? 'es' : ''} won`;
    else if (lost > 0) matchText = `${lost} match${lost > 1 ? 'es' : ''} lost`;
    lines.push(`${ptsStr} ${wlStr} ${timeStr} ${sessStr} ${matchText}`);
  }
  return lines;
}

// Build full summary content string for a window (title + body). If empty, include placeholder
function buildWindowSummaryContent(window) {
  if (!window) return '';
  const events = readEventsFile();
  const within = events.filter(ev => ev && ev.type === 'points_change' && isWithinWindow(ev.ts, window));
  within.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const lines = buildWindowSummaryLines(within, window);
  const d = window.start;
  const dd = d.getUTCDate();
  const mm = d.getUTCMonth() + 1;
  const yyyy = d.getUTCFullYear();
  const startLine = `${window.label} Session Start - ${dd}/${mm}/${yyyy}`;
  const body = lines.length ? lines.join('\n') : '(no entries yet)';
  return ['```', startLine, body, '```'].join('\n');
}

async function postWindowSummary(window) {
  try {
    if (!window) return;
    const events = readEventsFile();
    // Filter points_change events in this window
    const within = events.filter(ev => ev && ev.type === 'points_change' && isWithinWindow(ev.ts, window));
    if (!within.length) return;
    // Sort chronologically
    within.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const lines = buildWindowSummaryLines(within, window);
    const title = `${window.label} session summary ${window.start.toISOString().slice(0,16).replace('T',' ')}–${window.end.toISOString().slice(11,16)} UTC`;
    const body = lines.join('\n');
    const sendWL = getDiscordWinLossSend();
    const send = getDiscordSend();
    const content = [title, '```', body, '```'].join('\n');
    if (typeof sendWL === 'function') await sendWL(content);
    else if (typeof send === 'function') await send(content);
  } catch (_) {}
}

// --- Daily archive of squadron_data.json at UTC midnight ---
function ensureLogsDir() {
  const dir = path.join(process.cwd(), 'logs');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function archiveSquadronData(dateKeyOverride = null) {
  try {
    const src = path.join(process.cwd(), 'squadron_data.json');
    if (!fs.existsSync(src)) return;
    // If file exists but empty/invalid, still rotate to avoid carrying over
    const dateKey = dateKeyOverride || dateKeyUTC();
    const logsDir = ensureLogsDir();
    let dest = path.join(logsDir, `squadron_data-${dateKey}.json`);
    // Avoid overwrite if already present
    if (fs.existsSync(dest)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      dest = path.join(logsDir, `squadron_data-${dateKey}-${ts}.json`);
    }
    // Copy the current file to logs, keeping the original in place
    try { fs.copyFileSync(src, dest); } catch (_) {}
    console.log(`[SEASON] Archived (copied) squadron_data.json to ${dest}`);
  } catch (e) {
    console.warn(`[SEASON] Failed to archive squadron_data.json: ${e && e.message ? e.message : e}`);
  }
}

function msUntilNextUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.getTime() - now.getTime();
}

let __archiveTimer = null;
function scheduleDailyArchive() {
  try { if (__archiveTimer) clearTimeout(__archiveTimer); } catch (_) {}
  const delay = Math.max(1000, msUntilNextUtcMidnight());
  __archiveTimer = setTimeout(() => {
    try { archiveSquadronData(); } catch (_) {}
    // Re-schedule for the next midnight
    scheduleDailyArchive();
  }, delay);
  console.log(`[SEASON] Daily archive scheduled in ${(delay / 1000 / 60).toFixed(1)} minutes`);
}

// Determine the UTC date key of the data inside squadron_data.json.
// Prefer the last snapshot ts; fall back to file mtime if no snapshots.
function getSquadronDataDateKeyOrNull() {
  try {
    const file = path.join(process.cwd(), 'squadron_data.json');
    if (!fs.existsSync(file)) return null;
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Legacy array support
      if (obj && Array.isArray(obj.squadronSnapshots)) {
        const arr = obj.squadronSnapshots;
        const last = arr.length ? arr[arr.length - 1] : null;
        if (last && last.ts) {
          const d = new Date(last.ts);
          if (!isNaN(d.getTime())) return dateKeyUTC(d);
        }
      }
      // New single snapshot
      if (obj && obj.ts) {
        const d = new Date(obj.ts);
        if (!isNaN(d.getTime())) return dateKeyUTC(d);
      }
    } catch (_) {}
    // Fallback: file mtime
    try {
      const st = fs.statSync(file);
      const d = st && st.mtime ? new Date(st.mtime) : null;
      if (d && !isNaN(d.getTime())) return dateKeyUTC(d);
    } catch (_) {}
  } catch (_) {}
  return null;
}

// Archive immediately if the current data file belongs to a previous UTC date.
function archiveIfStale() {
  try {
    const curKey = dateKeyUTC();
    const fileKey = getSquadronDataDateKeyOrNull();
    if (fileKey && fileKey < curKey) {
      archiveSquadronData(fileKey);
    }
  } catch (_) {}
}

// Helper: get UTC date key YYYY-MM-DD
function dateKeyUTC(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Read events array from squadron_events.json
function readEventsFile() {
  try {
    const file = ensureEventsFile();
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(obj.events) ? obj.events : [];
  } catch (_) { return []; }
}

// Rebuild today's session from events (idempotent). Uses explicit session events when present,
// else infers from first/last points_change and accumulated w_l_update entries.
function rebuildSessionFromEvents() {
  try {
    const events = readEventsFile();
    if (!events.length) return;
    const now = new Date();
    const window = getCurrentWindow(now);
    if (!window) { return; }

    // Only consider events within this window
    let startingPoints = null;
    let startedAt = window.start;
    let wins = 0, losses = 0;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const ets = ev.ts ? new Date(ev.ts) : null;
      if (!ets || !isWithinWindow(ets, window)) continue;
      if (ev.type === 'session_start' || ev.type === 'session_reset') {
        if (typeof ev.startingPoints === 'number') startingPoints = ev.startingPoints;
        startedAt = ets || startedAt;
        wins = 0; losses = 0;
      } else if (ev.type === 'w_l_update') {
        const w = Number(ev.matchesWon || 0);
        const l = Number(ev.matchesLost || 0);
        if (Number.isFinite(w)) wins += w;
        if (Number.isFinite(l)) losses += l;
      } else if (ev.type === 'points_change') {
        const w = Number(ev.matchesWon || 0);
        const l = Number(ev.matchesLost || 0);
        if (Number.isFinite(w)) wins += w;
        if (Number.isFinite(l)) losses += l;
        if (startingPoints == null && typeof ev.from === 'number') startingPoints = ev.from;
      }
    }

    if (startingPoints != null) {
      __session.dateKey = dateKeyUTC(window.start);
      __session.startedAt = startedAt || window.start;
      __session.startingPoints = startingPoints;
      __session.wins = wins;
      __session.losses = losses;
      __session.windowKey = window.key;
    }
  } catch (_) { /* ignore */ }
}

function getDiscordSend() {
  if (!__discordSendChecked) {
    __discordSendChecked = true;
    try {
      const mod = require('./discordBot');
      __discordSendFn = typeof mod.sendMessage === 'function' ? mod.sendMessage : null;
    } catch (_) { __discordSendFn = null; }
  }
  return __discordSendFn;
}

// Prefer posting squadron tracker updates to the dedicated win/loss channel if configured
function getDiscordWinLossSend() {
  if (!__discordWinLossChecked) {
    __discordWinLossChecked = true;
    try {
      const mod = require('./discordBot');
      // Configure win/loss channel from settings.json if present
      try {
        const s = loadSettings();
        if (s && typeof s.discordWinLossChannell === 'string' && s.discordWinLossChannell.trim()) {
          try { if (typeof mod.setWinLossChannel === 'function') mod.setWinLossChannel(s.discordWinLossChannell); } catch (_) {}
        }
      } catch (_) {}
      __discordWinLossFn = (typeof mod.sendWinLossMessage === 'function') ? mod.sendWinLossMessage : null;
    } catch (_) { __discordWinLossFn = null; }
  }
  return __discordWinLossFn;
}

// Updater for win/loss channel message by key (e.g., session window key)
function getDiscordWinLossUpdater() {
  if (!__discordWLUpdateChecked) {
    __discordWLUpdateChecked = true;
    try {
      const mod = require('./discordBot');
      __discordWLUpdateFn = (typeof mod.postOrEditWinLossByKey === 'function') ? mod.postOrEditWinLossByKey : null;
      __discordWLClearFn = (typeof mod.clearWinLossByKey === 'function') ? mod.clearWinLossByKey : null;
    } catch (_) { __discordWLUpdateFn = null; __discordWLClearFn = null; }
  }
  return { updateByKey: __discordWLUpdateFn, clearByKey: __discordWLClearFn };
}

// --- JSON API based leaderboard fetching (faster and more robust than HTML scraping) ---
function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode !== 200) {
        // Notify Discord default channel about non-200 responses
        try {
          const send = getDiscordSend();
          if (typeof send === 'function') send(`fetchJson: non-200 (${res.statusCode}) for ${url}`);
        } catch (_) {}
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} resolve(null); });
  });
}

// Simple text fetcher (for HTML)
function fetchText(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const options = new URL(url);
    options.method = 'GET';
    options.headers = HTML_REQUEST_HEADERS;
    const req = https.get(options, res => {
      if (res.statusCode !== 200) {
        console.warn(`⚠️ fetchText: non-200 (${res.statusCode}) for ${url}`);
        // Notify Discord default channel about non-200 responses
        try {
          const send = getDiscordSend();
          if (typeof send === 'function') send(`fetchText: non-200 (${res.statusCode}) for ${url}`);
        } catch (_) {}
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log(`ℹ️ fetchText: received ${data.length} chars from ${url}`);
        resolve(data);
      });
    });
    req.on('error', (e) => { console.warn(`⚠️ fetchText error for ${url}:`, e && e.message ? e.message : e); resolve(null); });
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} resolve(null); });
  });
}

// Parse squadron page HTML using cheerio (no JS execution)
function parseSquadronWithCheerio(html) {
  try {
    const $ = cheerio.load(html);
    // Prefer semantic table if present
    const tableContainer = $('div.squadrons-members__table');
    if (tableContainer.length) {
      const table = tableContainer.find('table');
      if (table.length) {
        const headers = [];
        table.find('thead th').each((_, th) => headers.push($(th).text().trim()));
        const rows = [];
        table.find('tbody tr').each((_, tr) => {
          const obj = {};
          $(tr).children().each((i, td) => {
            const key = headers[i] || `col_${i}`;
            obj[key] = $(td).text().trim();
          });
          if (Object.keys(obj).length) rows.push(obj);
        });
        console.log(`ℹ️ Cheerio: table detected. headers=${headers.length}, rows=${rows.length}`);
        if (rows.length) return { headers, rows };
      }
    }

    // Fallback: parse grid items in the profile body using 6-item grouping per member
    const container = $('div.squadrons-profile__body.squadrons-members');
    const items = container.find('div.squadrons-members__grid-item');
    const nodes = Array.from(items);
    console.log(`ℹ️ Cheerio: grid container found=${container.length > 0}, grid-items=${nodes.length}`);
    const rows = [];
    const take = (el) => ($(el).text() || '').trim();
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    let start = 0;
    if (nodes.length >= 6) {
      const headers = [0,1,2,3,4,5].map(i => norm(take(nodes[i])));
      const expected = ['num.','player','personalclanrating','activity','role','dateofentry'].map(x => norm(x));
      const isHeader = headers.every((v, idx) => v === expected[idx]);
      if (isHeader) {
        start = 6;
        console.log('ℹ️ Cheerio: header row detected and skipped');
      } else {
        console.log('ℹ️ Cheerio: header row NOT detected');
      }
    }
    for (let i = start; i + 5 < nodes.length; i += 6) {
      const numRaw = take(nodes[i]);
      const nameEl = $(nodes[i + 1]);
      const link = nameEl.find('a[href*="userinfo/?nick="]');
      let player = '';
      if (link.length) {
        player = (link.text() || '').trim();
        if (!player) {
          const href = link.attr('href') || '';
          player = href.replace(/.*nick=/, '').trim();
        }
      } else {
        player = take(nodes[i + 1]);
      }
      const ratingRaw = take(nodes[i + 2]);
      const activityRaw = take(nodes[i + 3]);
      const roleRaw = take(nodes[i + 4]);
      const dateRaw = take(nodes[i + 5]);

      const num = numRaw.replace(/\D+/g, '') || String(rows.length + 1);
      const rating = ratingRaw.replace(/\D+/g, '') || '0';
      const activity = activityRaw.replace(/\D+/g, '') || activityRaw || '';
      const role = roleRaw || '';
      const date = dateRaw || '';

      if (player) {
        rows.push({
          'num.': num,
          'Player': player,
          'Personal clan rating': rating,
          'Activity': activity,
          'Role': role,
          'Date of entry': date,
        });
      }
    }
    console.log(`ℹ️ Cheerio: parsed member rows=${rows.length}`);
    return { headers: ['num.', 'Player', 'Personal clan rating', 'Activity', 'Role', 'Date of entry'], rows };
  } catch (_) {
    console.warn('⚠️ Cheerio: parse error');
    return { headers: [], rows: [] };
  }
}

function toNum(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}

// --- Startup: fetch Squadron Battles season schedule and persist ---
async function initSeasonSchedule() {
  const url = 'https://forum.warthunder.com/t/season-schedule-for-squadron-battles/4446';
  try {
    console.log(`[SEASON] Fetching schedule from: ${url}`);
    const raw = await fetchText(url);
    if (!raw) {
      console.warn('[SEASON] No HTML received from forum URL. Aborting schedule init.');
      return;
    }
    const $ = cheerio.load(raw);
    // Prefer the OpenGraph description which often summarizes the schedule in one line
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';
    const metaDesc = ogDesc || $('meta[name="description"]').attr('content') || '';
    if (!metaDesc) {
      console.warn('[SEASON] No og:description/meta description found. Aborting schedule init.');
      return;
    }
    console.log(`[SEASON] og:description length: ${metaDesc.length}`);
    // Prepare a cleaned version for EN parsing: strip Cyrillic, normalize dashes and whitespace
    const metaDescEn = String(metaDesc)
      // Replace en/em dashes and long dashes with a simple hyphen
      .replace(/[–—−]/g, '-')
      // Remove Cyrillic characters entirely
      .replace(/[\u0400-\u04FF]+/g, '')
      // Collapse excessive whitespace
      .replace(/[\t\r\f\v]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // Strip any introductory header line ending with ':' before the schedule list
    const stripHeaderPrefix = (s) => {
      try {
        const text = String(s || '');
        const colon = text.indexOf(':');
        if (colon !== -1) {
          const firstParen = text.indexOf('(');
          // Only treat it as a header if the colon appears early and before any date parens
          if (colon < 200 && (firstParen === -1 || colon < firstParen)) {
            return text.slice(colon + 1).trim();
          }
        }
        return text;
      } catch (_) { return String(s || ''); }
    };
    const metaDescStripped = stripHeaderPrefix(metaDesc);
    const metaDescEnStripped = stripHeaderPrefix(metaDescEn);
    // Extract schedule-like snippets from the description; support EN/RU markers and a (dd.mm — dd.mm) date range
    const lines = [];
    const pushMatch = (m) => { const s = (m && m[0] ? m[0] : '').trim(); if (s) lines.push(s); };
    // Patterns that include a date range in parens and either 'week' (optionally prefixed by an ordinal like '1st') or 'Until the end of season' (EN/RU)
    // Preserve leading ordinals such as "1", "1st", "2nd", "3rd", "4th" before the word 'week'
    const reWeek = /((?:\b\d+\s*(?:st|nd|rd|th)?\s*)?\bweek\b[^()]*\(\d{2}\.\d{2}\s*[—-]\s*\d{2}\.\d{2}\))/gi;
    const reUntil = /(Until the end of season[^()]*\(\d{2}\.\d{2}\s*[—-]\s*\d{2}\.\d{2}\))/gi;
    let m;
    // Apply EN patterns to cleaned text to avoid interference from Cyrillic
    while ((m = reWeek.exec(metaDescEnStripped))) pushMatch(m);
    // Apply RU patterns to original text (if present)
    // Note: RU patterns may have been removed; keep EN parsing robust regardless
    if (typeof reWeekRu !== 'undefined') {
      while ((m = reWeekRu.exec(metaDescStripped))) pushMatch(m);
    }
    while ((m = reUntil.exec(metaDescEnStripped))) pushMatch(m);
    if (typeof reUntilRu !== 'undefined') {
      while ((m = reUntilRu.exec(metaDescStripped))) pushMatch(m);
    }
    // Deduplicate while preserving order
    const seen = new Set();
    const scheduleLines = lines.filter(l => { if (seen.has(l)) return false; seen.add(l); return true; });
    console.log(`[SEASON] Candidate lines: ${lines.length}; unique retained: ${scheduleLines.length}`);
    if (!scheduleLines.length) {
      console.warn('[SEASON] No schedule lines matched expected pattern. Aborting schedule init.');
      return;
    }
    console.log(`[SEASON] First lines preview: ${scheduleLines.slice(0, 3).map(s => JSON.stringify(s)).join(' | ')}`);

    // Write sqbbr.txt
    try {
      const outPath = path.join(process.cwd(), 'sqbbr.txt');
      fs.writeFileSync(outPath, scheduleLines.join('\n') + '\n', 'utf8');
      console.log(`[SEASON] Wrote schedule lines to ${outPath}`);
    } catch (e) {
      console.warn('[SEASON] Failed writing sqbbr.txt:', e && e.message ? e.message : e);
    }

    // Parse into settings.json seasonSchedule
    const year = new Date().getUTCFullYear();
    const parseEntry = (text) => {
      // Example: "1st week мах BR 14.0 (01.07 — 06.07)"
      // or "Until the end of season, мах BR 4.7 (25.08 — 31.08)"
      const brMatch = text.match(/\b(?:BR|БР)\s*([0-9]+(?:\.[0-9]+)?)/i);
      const rangeMatch = text.match(/\((\d{2})\.(\d{2})\s*[—-]\s*(\d{2})\.(\d{2})\)/);
      let br = brMatch ? brMatch[1] : null;
      let startDate = null, endDate = null;
      if (rangeMatch) {
        const [_, d1, m1, d2, m2] = rangeMatch;
        const pad = (s) => String(s).padStart(2, '0');
        startDate = `${year}-${pad(m1)}-${pad(d1)}`;
        endDate = `${year}-${pad(m2)}-${pad(d2)}`;
        // Warn if looks like year wrap (month decreases), we still keep same year by default
        try {
          if (parseInt(m2, 10) < parseInt(m1, 10)) {
            console.warn(`[SEASON] Date range spans year boundary? '${text}' -> start ${startDate}, end ${endDate}`);
          }
        } catch (_) {}
      }
      return { br, startDate, endDate };
    };

    // Read current settings.json or create if missing
    const settingsPath = path.join(process.cwd(), 'settings.json');
    let settingsObj = {};
    try {
      if (fs.existsSync(settingsPath)) {
        settingsObj = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
      } else {
        settingsObj = { players: {}, squadrons: {} };
      }
    } catch (_) { settingsObj = { players: {}, squadrons: {} }; }

    const seasonSchedule = {};
    let idx = 1;
    for (const line of scheduleLines) {
      const entry = parseEntry(line);
      if (entry.br && entry.startDate && entry.endDate) {
        seasonSchedule[String(idx)] = {
          startDate: entry.startDate,
          endDate: entry.endDate,
          br: entry.br,
        };
        console.log(`[SEASON] Parsed #${idx}: br=${entry.br} start=${entry.startDate} end=${entry.endDate}`);
        idx++;
      } else {
        if (!(entry.br)) console.warn('[SEASON] Parse failed: BR not found for line:', line);
        if (!(entry.startDate && entry.endDate)) console.warn('[SEASON] Parse failed: dates not found for line:', line);
      }
    }
    if (Object.keys(seasonSchedule).length) {
      settingsObj.seasonSchedule = seasonSchedule;
      try {
        fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2), 'utf8');
        console.log(`[SEASON] Updated seasonSchedule in ${settingsPath}`);
      } catch (e) {
        console.warn('[SEASON] Failed writing settings.json:', e && e.message ? e.message : e);
      }
    } else {
      console.warn('[SEASON] No valid parsed entries to write to settings.json');
    }
  } catch (e) {
    console.warn('[SEASON] Unexpected error initializing season schedule:', e && e.message ? e.message : e);
  }
}

async function findOnLeaderboardViaApi(tag) {
  try {
    const needle = String(tag || '').trim().toLowerCase();
    if (!needle) return null;
    const makeUrl = (page) => `https://warthunder.com/en/community/getclansleaderboard/dif/_hist/page/${page}/sort/dr_era5`;
    let page = 1;
    const MAX_PAGES = 100; // sensible cap
    while (page <= MAX_PAGES) {
      const json = await fetchJson(makeUrl(page));
      if (!json || json.status !== 'ok') break;
      const arr = Array.isArray(json.data) ? json.data : [];
      if (!arr.length) break;
      const idx = arr.findIndex(e => String(e.tagl || '').toLowerCase() === needle);
      if (idx !== -1) {
        const cur = arr[idx];
        const found = {
          rank: cur.pos || null,
          points: toNum(cur?.astat?.dr_era5_hist),
        };
        // neighbors on same page
        const aboveEntry = idx > 0 ? arr[idx - 1] : null;
        const belowEntry = idx + 1 < arr.length ? arr[idx + 1] : null;
        let abovePoints = aboveEntry ? toNum(aboveEntry?.astat?.dr_era5_hist) : null;
        let belowPoints = belowEntry ? toNum(belowEntry?.astat?.dr_era5_hist) : null;
        // cross-page neighbors if needed
        if (!aboveEntry && page > 1) {
          const prev = await fetchJson(makeUrl(page - 1));
          const prevArr = prev && prev.status === 'ok' && Array.isArray(prev.data) ? prev.data : [];
          if (prevArr.length) abovePoints = toNum(prevArr[prevArr.length - 1]?.astat?.dr_era5_hist);
        }
        if (!belowEntry && arr.length > 0) {
          const next = await fetchJson(makeUrl(page + 1));
          const nextArr = next && next.status === 'ok' && Array.isArray(next.data) ? next.data : [];
          if (nextArr.length) belowPoints = toNum(nextArr[0]?.astat?.dr_era5_hist);
        }
        return {
          page,
          found,
          squadronPlace: found.rank || null,
          totalPointsAbove: Number.isFinite(abovePoints) ? abovePoints : null,
          totalPointsBelow: Number.isFinite(belowPoints) ? belowPoints : null,
        };
      }
      page++;
    }
  } catch (_) {}
  return null;
}

// Try to infer squadron tag from the current squadron page (from header/title)
async function extractSquadronTagFromPage(page) {
  try {
    const raw = await page.evaluate(() => {
      const pieces = [];
      const sel = [
        'h1',
        '.squadrons__title',
        '.squadrons-members__title',
        '.squadrons__header',
        'title'
      ];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el && el.textContent) pieces.push(el.textContent.trim());
      }
      return pieces.join(' | ');
    });
    const text = String(raw || '');
    // Look for a tag-like token (letters/numbers) possibly wrapped by symbols
    // Example: "╖xTHCx╖ Try Hard Coalition" -> xTHCx
    const tokens = text.split(/\s+/);
    for (const t of tokens) {
      const mid = t.replace(/[^A-Za-z0-9]/g, '');
      if (mid.length >= 2 && mid.length <= 8) {
        return mid; // plausible tag
      }
    }
  } catch (_) {}
  return '';
}

// Read leaderboard rows from the canonical table if present
async function parseLeaderboardPage(page) {
  return await page.evaluate(() => {
    const out = [];
    const push = (rank, text, href) => out.push({ rank, text, href });
    const table = document.querySelector('table.leaderboards');
    if (table) {
      const trs = Array.from(table.querySelectorAll('tbody tr'));
      for (const tr of trs) {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length >= 2) {
          const rankStr = (tds[0].innerText || '').trim();
          const nameCell = tds[1];
          const tagText = (nameCell.innerText || '').trim();
          const a = nameCell.querySelector('a[href]');
          const href = a && a.getAttribute('href');
          const r = parseInt(rankStr.replace(/[^0-9]/g, ''), 10);
          if (Number.isFinite(r) && tagText) push(r, tagText, href || null);
        }
      }
      return out;
    }
    // Minimal generic fallback: any table rows on the page
    const trs = Array.from(document.querySelectorAll('tr'));
    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length >= 2) {
        const rankStr = (tds[0].innerText || '').trim();
        const nameCell = tds[1];
        const tagText = (nameCell.innerText || '').trim();
        const a = nameCell.querySelector('a[href]');
        const href = a && a.getAttribute('href');
        const r = parseInt(rankStr.replace(/[^0-9]/g, ''), 10);
        if (Number.isFinite(r) && tagText) push(r, tagText, href || null);
      }
    }
    return out;
  });
}

// Try to locate our squadron in the War Thunder clans leaderboard and collect rank and neighbor links
async function findOnLeaderboard(browser, tag) {
  const base = 'https://warthunder.com/en/community/clansleaderboard';
  // Try both normal and hist type, multiple pages
  const maxPages = 25;
  let lbPage = null;
  try {
    lbPage = await browser.newPage();
    for (let p = 1; p <= maxPages; p++) {
      // Build candidate URLs for this page index
      const candidates = [];
      if (p === 1) {
        candidates.push(base, `${base}/?type=hist`);
      } else {
        candidates.push(`${base}/page/${p}/`, `${base}/page/${p}/?type=hist`);
      }
      for (const url of candidates) {
        try {
          await lbPage.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });
          // Prefer waiting for the specific leaderboard table if present
          try { await lbPage.waitForSelector('table.leaderboards', { timeout: 3000 }); } catch (_) {}
        } catch (_) { continue; }
        // Extract rows: rank, tag text, optional href
        try {
          const rows = await parseLeaderboardPage(lbPage);
          // Normalize and search for tag
          const norm = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
          const needle = norm(tag);
          if (!needle) continue;
          rows.sort((a, b) => a.rank - b.rank);
          const idx = rows.findIndex(r => norm(r.text).includes(needle));
          if (idx !== -1) {
            const found = rows[idx];
            const above = idx > 0 ? rows[idx - 1] : null;
            const below = idx + 1 < rows.length ? rows[idx + 1] : null;
            return { page: p, url, found, above, below };
          }
        } catch (_) {}
      }
    }
  } catch (_) {
    // ignore
  } finally {
    try { if (lbPage) await lbPage.close(); } catch (_) {}
  }
  return null;
}

async function extractPointsFromSquadLink(browser, href) {
  if (!href) return null;
  try {
    const abs = href.startsWith('http') ? href : ('https://warthunder.com' + (href.startsWith('/') ? '' : '/') + href);
    const p = await browser.newPage();
    try {
      await p.goto(abs, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Use the same extractor as for the main squad page
      const total = await extractTotalPoints(p);
      return (typeof total === 'number' && Number.isFinite(total)) ? total : null;
    } finally {
      try { await p.close(); } catch (_) {}
    }
  } catch (_) { return null; }
}

// --- Events logging (mirror Discord messages) ---
function ensureEventsFile() {
  const file = path.join(process.cwd(), 'squadron_events.json');
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8'); } catch (_) {}
  } else {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
        fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8');
      }
    } catch (_) {
      try { fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8'); } catch (_) {}
    }
  }
  return file;
}

function appendEvent(messageOrEvent, meta = {}) {
  try {
    const file = ensureEventsFile();
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(obj.events)) obj.events = [];
    let entry;
    if (messageOrEvent && typeof messageOrEvent === 'object' && !Array.isArray(messageOrEvent)) {
      entry = { ts: new Date().toISOString(), ...messageOrEvent };
    } else {
      entry = { ts: new Date().toISOString(), message: messageOrEvent, ...meta };
    }
    obj.events.push(entry);
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {}
}

// Remove noisy columns from rows and headers
function pruneSnapshot(snapshot) {
  const dropCols = new Set(['num.', 'Activity']);
  const safe = JSON.parse(JSON.stringify(snapshot || {}));
  if (safe && safe.data) {
    if (Array.isArray(safe.data.headers)) {
      safe.data.headers = safe.data.headers.filter(h => !dropCols.has(h));
    }
    if (Array.isArray(safe.data.rows)) {
      safe.data.rows = safe.data.rows.map(r => {
        const obj = {};
        Object.keys(r || {}).forEach(k => {
          if (!dropCols.has(k)) obj[k] = r[k];
        });
        return obj;
      });
    }
  }
  return safe;
}

function ensureParsedDataFile() {
  const file = path.join(process.cwd(), 'squadron_data.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({}, null, 2), 'utf8');
  } else {
    // If exists but not object, coerce
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        fs.writeFileSync(file, JSON.stringify({}, null, 2), 'utf8');
      }
    } catch (_) {
      fs.writeFileSync(file, JSON.stringify({}, null, 2), 'utf8');
    }
  }
  return file;
}

// Removed manual points calculation; we rely on API-derived points now.

function readLastSnapshot(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Legacy array support
    if (obj && Array.isArray(obj.squadronSnapshots)) {
      return obj.squadronSnapshots.length ? obj.squadronSnapshots[obj.squadronSnapshots.length - 1] : null;
    }
    // New single snapshot
    return obj && typeof obj === 'object' && Object.keys(obj).length ? obj : null;
  } catch (_) { return null; }
}

function appendSnapshot(file, snapshot) {
  // New behavior: always write a single latest snapshot (overwrite file)
  try {
    const pruned = pruneSnapshot(snapshot);
    fs.writeFileSync(file, JSON.stringify(pruned, null, 2), 'utf8');
    try { autoIssueAfterSnapshot(); } catch (_) {}
  } catch (_) {
    try {
      const pruned = pruneSnapshot(snapshot);
      fs.writeFileSync(file, JSON.stringify(pruned, null, 2), 'utf8');
      try { autoIssueAfterSnapshot(); } catch (_) {}
    } catch (_) {}
  }
}

async function extractTotalPoints(page) {
  // Find by tooltip bubble label 'Squadron rating' and extract nearest numeric value
  try {
    const fromLabel = await page.evaluate(() => {
      const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const spans = Array.from(document.querySelectorAll('span.new-tooltip__bubble.new-tooltip__bubble_top-center'));
      const label = spans.find(sp => normalize(sp.textContent).includes('squadron rating'));
      if (!label) return null;
      // Search in parent container for the largest number nearby
      const root = label.parentElement || label;
      let maxNum = null;
      const considerText = (txt) => {
        if (!txt) return;
        const matches = String(txt).match(/\d[\d\s]{2,}/g);
        if (matches) {
          for (const m of matches) {
            const n = parseInt(m.replace(/\s+/g, ''), 10);
            if (!isNaN(n) && (maxNum === null || n > maxNum)) maxNum = n;
          }
        }
      };
      // Nearby candidates: siblings and within parent subtree
      if (root.previousElementSibling) considerText(root.previousElementSibling.textContent);
      if (root.nextElementSibling) considerText(root.nextElementSibling.textContent);
      considerText(root.textContent);
      // Also walk a bit up to grandparent to catch numbers placed adjacent
      const up = root.parentElement || root;
      considerText(up.textContent);
      return maxNum;
    });
    if (typeof fromLabel === 'number' && isFinite(fromLabel)) return fromLabel;
  } catch (_) {}
  return null;
}

async function scrapeTable(page) {
  return await page.evaluate(() => {
    const container = document.querySelector('div.squadrons-members__table');
    if (!container) return { headers: [], rows: [] };

    // First attempt: semantic table
    const table = container.querySelector('table');
    if (table) {
      let headers = [];
      const ths = table.querySelectorAll('thead th');
      if (ths && ths.length) headers = Array.from(ths).map(th => th.textContent.trim());
      const rows = [];
      const trs = table.querySelectorAll('tbody tr');
      Array.from(trs).forEach(tr => {
        const cells = Array.from(tr.children).map(td => td.textContent.trim());
        if (!cells.length) return;
        const obj = {};
        cells.forEach((v, i) => {
          const key = headers[i] || `col_${i}`;
          obj[key] = v;
        });
        rows.push(obj);
      });
      if (rows.length) return { headers, rows };
    }

    // Fallback: tokenization of innerText with 6-column repeating groups
    const text = container.innerText || '';
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // Remove known header labels if present
    const headerLabels = new Set(['num.', 'Player', 'Personal clan rating', 'Activity', 'Role', 'Date of entry']);
    const filtered = lines.filter(l => !headerLabels.has(l));
    const isDate = (s) => /^\d{2}\.\d{2}\.\d{4}$/.test(s);
    const headers = ['num.', 'Player', 'Personal clan rating', 'Activity', 'Role', 'Date of entry'];
    const rows = [];
    // Group by finding date tokens and collecting preceding 5 tokens
    const buf = [];
    for (const token of filtered) {
      buf.push(token);
      // When the latest token looks like a date and we have at least 6 tokens in the current slice, flush a row
      if (isDate(token) && buf.length >= 6) {
        const chunk = buf.slice(-6);
        buf.length = 0; // reset buffer to allow next rows; leftover tokens ignored
        const [num, player, rating, activity, role, date] = chunk;
        // Basic sanity checks: num/rating/activity numeric-like
        const looksNumeric = (x) => /^\d+[\d\s]*$/.test(x);
        if (looksNumeric(num) && looksNumeric(rating) && looksNumeric(activity)) {
          rows.push({
            'num.': num.replace(/\s+/g, ''),
            'Player': player,
            'Personal clan rating': rating.replace(/\s+/g, ''),
            'Activity': activity.replace(/\s+/g, ''),
            'Role': role,
            'Date of entry': date,
          });
        }
      }
    }
    return { headers, rows };
  });
}

function simplifyForComparison(snapshot) {
  // Consider headers, rows, and totalPoints for change detection
  const { headers, rows } = snapshot.data || {};
  const norm = (rows || []).map(r => {
    const obj = {};
    for (const k of Object.keys(r)) obj[k] = r[k];
    return obj;
  });
  const totalPoints = typeof snapshot.totalPoints === 'number' ? snapshot.totalPoints : null;
  return JSON.stringify({ headers, rows: norm, totalPoints });
}

async function startSquadronTracker() {
  const { squadronPageUrl } = loadSettings();
  // Initialize season schedule on startup (best-effort)
  try { await initSeasonSchedule(); } catch (_) {}
  // If the data file belongs to a previous UTC date, archive it immediately
  try { archiveIfStale(); } catch (_) {}
  // Then schedule daily archive of squadron_data.json at UTC midnight
  try { scheduleDailyArchive(); } catch (_) {}
  if (!squadronPageUrl) {
    console.log('ℹ️ Squadron tracker disabled: no SQUADRON_PAGE_URL configured.');
    return { enabled: false };
  }

  const dataFile = ensureParsedDataFile();
  // Rebuild in-memory session from existing events (if any)
  try { rebuildSessionFromEvents(); } catch (_) {}
  let lastKey = null;
  let lastSnapshot = null;
  let didInitialMembersFetch = false;

  async function captureOnce() {
    // Determine primary squadron tag (from settings or fallback parsing if needed)
    let primaryTag = '';
    try {
      const settings = loadSettings();
      const keys = Object.keys(settings.squadrons || {});
      primaryTag = keys.length ? keys[0] : '';
    } catch (_) {}

    // Initialize leaderboard context (API only for context; HTML is primary for totals)
    let squadronPlace = null;
    let totalPointsAbove = null;
    let totalPointsBelow = null;

    // Prepare snapshot and fetch HTML first (for members list only; totals from API)
    let snapshot = {
      ts: Date.now(),
      data: { headers: [], rows: [] },
      totalPoints: null,
      squadronPlace: null,
      totalPointsAbove: null,
      totalPointsBelow: null,
    };

    try {
      const raw = await fetchText(squadronPageUrl);
      if (raw) {
        const parsed = parseSquadronWithCheerio(raw);
        if (parsed && Array.isArray(parsed.rows)) {
          snapshot.data = parsed;
          snapshot.membersCaptured = true;
          // Note: we no longer compute manual totals; totalPoints will be set from API below
        }
      }
    } catch (_) {}

    // Fetch leaderboard context and total points from API
    try {
      if (primaryTag) {
        const api = await findOnLeaderboardViaApi(primaryTag);
        if (api) {
          squadronPlace = api.squadronPlace;
          totalPointsAbove = api.totalPointsAbove;
          totalPointsBelow = api.totalPointsBelow;
          snapshot.squadronPlace = squadronPlace;
          snapshot.totalPointsAbove = totalPointsAbove;
          snapshot.totalPointsBelow = totalPointsBelow;
          // Set snapshot totalPoints from API-derived points
          const apiPts = api.found && typeof api.found.points === 'number' ? api.found.points : null;
          if (Number.isFinite(apiPts)) {
            snapshot.totalPoints = apiPts;
          }
        }
      }
    } catch (_) {}

    const key = simplifyForComparison(snapshot);
    if (lastKey === null) {
      // Initialize from existing file
      const last = readLastSnapshot(dataFile);
      if (last) {
        lastKey = simplifyForComparison(last);
        lastSnapshot = last;
      }
    }
    if (key !== lastKey) {
      // Compute diff versus previous snapshot, if available
      try {
        const prev = lastSnapshot || readLastSnapshot(dataFile);
        // On first invocation, always fetch members so we can compare against the previous record at startup
        if (!didInitialMembersFetch) {
          try {
            const raw0 = await fetchText(squadronPageUrl);
            if (raw0) {
              console.log(`ℹ️ Startup members HTML length=${raw0.length}`);
              const parsed0 = parseSquadronWithCheerio(raw0);
              if (parsed0 && Array.isArray(parsed0.rows)) {
                snapshot.data = parsed0;
                snapshot.membersCaptured = true;
                didInitialMembersFetch = true;
                console.log(`ℹ️ Startup parsed member rows=${parsed0.rows.length}`);
                if (!parsed0.rows.length) {
                  try { fs.writeFileSync(path.join(process.cwd(), 'debug_squadron_raw.html'), raw0, 'utf8'); console.log('🧪 Saved debug_squadron_raw.html (startup)'); } catch (_) {}
                }
              }
            }
          } catch (_) {}
        }
        const prevTotal = prev && typeof prev.totalPoints === 'number' ? prev.totalPoints : null;
        const newTotal = typeof snapshot.totalPoints === 'number' ? snapshot.totalPoints : null;

        // We already fetched members above for HTML-first; if empty, attempt a retry once
        if ((!snapshot.data || !Array.isArray(snapshot.data.rows) || !snapshot.data.rows.length)) {
          try {
            const raw = await fetchText(squadronPageUrl);
            if (raw) {
              const parsed = parseSquadronWithCheerio(raw);
              if (parsed && Array.isArray(parsed.rows)) {
                snapshot.data = parsed;
                snapshot.membersCaptured = true;
              }
            }
          } catch (_) {}
        }

        const msgLines = [];
        msgLines.push(`• Squadron tracker update (${new Date().toLocaleString()})`);

        // Squadron ponts change (site-reported and calculated)
        const pointsDelta = (prevTotal != null && newTotal != null) ? (newTotal - prevTotal) : null;
        //if (pointsDelta != null && pointsDelta !== 0) {
          //msgLines.push(`• Squadron ponts: ${prevTotal} → ${newTotal} (${pointsDelta >= 0 ? '+' : ''}${pointsDelta})`);
          // Defer emitting event until after W/L inference so we can unify into one event
        //}

        // Prepare interval stats for persistence
        let gainedPoints = 0;
        let lostPoints = 0;
        let matchesWon = 0;
        let matchesLost = 0;

        // Row-level changes: added/removed players and W/L inference
        if (snapshot.membersCaptured && prev) {
          const prevRows = (prev && prev.data && Array.isArray(prev.data.rows)) ? prev.data.rows : [];
          const currRows = (snapshot.data && Array.isArray(snapshot.data.rows)) ? snapshot.data.rows : [];
          const keyName = (r) => String(r['Player'] || r['player'] || '').trim();
          const mkIndex = (rows) => {
            const m = new Map();
            rows.forEach(r => { const k = keyName(r); if (k) m.set(k, r); });
            return m;
          };
          const prevMap = mkIndex(prevRows);
          const currMap = mkIndex(currRows);
          const removed = [];
          const added = [];
          prevMap.forEach((r, k) => { if (!currMap.has(k)) removed.push(r); });
          currMap.forEach((r, k) => { if (!prevMap.has(k)) added.push(r); });

          // Compute gained/lost counts across common members by comparing Personal clan rating
          try {
            // Track detailed per-player rating changes
            const increasedMembers = [];
            const decreasedMembers = [];
            prevMap.forEach((prevMember, name) => {
              const currMember = currMap.get(name);
              if (!currMember) return;
              const prevRatingRaw = (prevMember['Personal clan rating'] || prevMember['rating'] || prevMember['Points'] || '').toString();
              const currRatingRaw = (currMember['Personal clan rating'] || currMember['rating'] || currMember['Points'] || '').toString();
              const prevRating = toNum(prevRatingRaw);
              const currRating = toNum(currRatingRaw);
              if (Number.isFinite(prevRating) && Number.isFinite(currRating)) {
                const delta = currRating - prevRating;
                if (delta > 0) {
                  gainedPoints += 1;
                  increasedMembers.push({
                    player: name,
                    from: prevRating,
                    to: currRating,
                    delta,
                  });
                } else if (delta < 0) {
                  lostPoints += 1;
                  decreasedMembers.push({
                    player: name,
                    from: prevRating,
                    to: currRating,
                    delta,
                  });
                }
              }
            });
            // Expose in outer scope for later event logging
            captureOnce.__lastIncreasedMembers = increasedMembers;
            captureOnce.__lastDecreasedMembers = decreasedMembers;
          } catch (_) {}

          // Improved inference of matches won/lost based on per-player point-change bands
          //  - Uses known/derived deltas by player rating band (from shared table)
          //  - Infers (wins, losses) per player from their rating delta, then aggregates across players
          //  - Approximates team matches by dividing by 8 (typical team size)
          //  - Falls back to legacy count-based heuristic if uncertain

          // Helper: map player's rating to expected per-game win/loss deltas
          const bandFor = (pts) => {
            const p = Number(pts);
            if (!Number.isFinite(p)) return { win: null, loss: null };
            if (p <= 800) return { win: 32, loss: -1 };
            if (p < 1100) return { win: 30, loss: -2 };
            if (p < 1200) return { win: 28, loss: -4 };
            if (p < 1300) return { win: 26, loss: -6 };
            if (p < 1400) return { win: 24, loss: -8 };
            if (p < 1450) return { win: 22, loss: -10 };
            if (p < 1500) return { win: 20, loss: -16 }; // heuristic gap fill
            if (p < 1550) return { win: 18, loss: -17 };
            if (p < 1600) return { win: 16, loss: -18 };
            if (p < 1650) return { win: 14, loss: -20 };
            if (p < 1700) return { win: 12, loss: -24 }; // ratio ~2:1
            if (p < 1800) return { win: 8,  loss: -28 }; // ratio ~3.5:1
            if (p < 1850) return { win: 5,  loss: -30 }; // ratio ~6:1
            if (p < 1865) return { win: 4,  loss: -28 };
            if (p < 2000) return { win: 3,  loss: -29 };
            return { win: 1, loss: -32 }; // 2000+
          };

          // Helper: find a small (w,l) explaining delta with given per-game deltas
          const inferWL = (delta, win, loss) => {
            const tol = 1; // allow small variance ±1
            if (!Number.isFinite(delta) || !win || !loss) return null;
            let best = null;
            for (let w = 0; w <= 5; w++) {
              for (let l = 0; l <= 5; l++) {
                const v = w * win + l * loss;
                const err = Math.abs(v - delta);
                if (err <= tol) {
                  const total = w + l;
                  if (!best || err < best.err || (err === best.err && (total < best.total || (total === best.total && w > best.w)))) {
                    best = { w, l, err, total };
                  }
                }
              }
            }
            return best ? { wins: best.w, losses: best.l, err: best.err } : null;
          };

          // Use detailed per-player deltas if available
          let aggWins = 0;
          let aggLosses = 0;
          let inferredPlayers = 0;
          try {
            const changed = [];
            for (const [name, prevMember] of prevMap.entries()) {
              const currMember = currMap.get(name);
              if (!currMember) continue;
              const from = toNum((prevMember['Personal clan rating'] || prevMember['rating'] || prevMember['Points'] || '').toString());
              const to = toNum((currMember['Personal clan rating'] || currMember['rating'] || currMember['Points'] || '').toString());
              const delta = to - from;
              if (!delta) continue;
              const { win, loss } = bandFor(Math.min(from, to));
              const est = inferWL(delta, win, loss);
              if (est) {
                aggWins += est.wins;
                aggLosses += est.losses;
                inferredPlayers++;
              }
            }
          } catch (_) {}

          if (inferredPlayers > 0) {
            // Approximate team matches by dividing by 8 and rounding
            matchesWon = Math.max(0, Math.round(aggWins / 8));
            matchesLost = Math.max(0, Math.round(aggLosses / 8));
          }

          // Fallback heuristic (legacy) if nothing inferred
          if ((matchesWon | matchesLost) === 0) {
            if (gainedPoints > 4 && gainedPoints < 9) matchesWon = 1;
            else if (gainedPoints > 12 && gainedPoints < 17) matchesWon = 2;
            else if (gainedPoints > 20) matchesWon = 3;

            if (lostPoints > 4 && lostPoints < 9) matchesLost = 1;
            else if (lostPoints > 12 && lostPoints < 17) matchesLost = 2;
            else if (lostPoints > 20) matchesLost = 3;
          }

          // Initialize/advance session state with window awareness
          const now = new Date();
          const y = now.getUTCFullYear();
          const m = String(now.getUTCMonth() + 1).padStart(2, '0');
          const d = String(now.getUTCDate()).padStart(2, '0');
          const todayKey = `${y}-${m}-${d}`;
          const activeWindow = getCurrentWindow(now);
          // Handle window end (we had a windowKey but are now outside any window)
          if (!activeWindow && __session.windowKey) {
            try {
              const { clearByKey } = getDiscordWinLossUpdater();
              if (typeof clearByKey === 'function') clearByKey(__session.windowKey);
            } catch (_) {}
            try { appendEvent({ type: 'session_reset', reason: 'window_end', windowKey: __session.windowKey, dateKey: __session.dateKey }); } catch (_) {}
            __session.startedAt = null;
            __session.dateKey = todayKey;
            __session.startingPoints = null;
            __session.wins = 0;
            __session.losses = 0;
            __session.windowKey = null;
          }
          // Handle new window start or first init inside a window
          if (activeWindow && __session.windowKey !== activeWindow.key) {
            __session.startedAt = now;
            __session.dateKey = todayKey;
            __session.startingPoints = (prevTotal != null ? prevTotal : (newTotal != null ? newTotal : null));
            __session.wins = 0;
            __session.losses = 0;
            __session.windowKey = activeWindow.key;
            // Persist and post initial summary for this window
            try {
              if (__session.startingPoints != null) {
                appendEvent({ type: 'session_start', startingPoints: __session.startingPoints, dateKey: __session.dateKey, windowKey: __session.windowKey });
              }
            } catch (_) {}
            try {
              const { updateByKey } = getDiscordWinLossUpdater();
              let posted = null;
              if (typeof updateByKey === 'function') {
                try { posted = await updateByKey(activeWindow.key, buildWindowSummaryContent(activeWindow)); } catch (_) { posted = null; }
              }
              if (!posted) {
                const content = buildWindowSummaryContent(activeWindow);
                const sendWL = getDiscordWinLossSend();
                if (typeof sendWL === 'function') {
                  try { await sendWL(content); posted = true; } catch (_) { posted = null; }
                }
                if (!posted) {
                  const send = getDiscordSend();
                  if (typeof send === 'function') {
                    try { await send(content); } catch (_) {}
                  }
                }
              }
            } catch (_) {}
          }
          // If in a window but session fields missing, ensure they are initialized
          if (activeWindow && (__session.startingPoints == null || __session.startedAt == null)) {
            __session.startedAt = now;
            __session.dateKey = todayKey;
            __session.startingPoints = (prevTotal != null ? prevTotal : (newTotal != null ? newTotal : null));
            __session.wins = __session.wins | 0;
            __session.losses = __session.losses | 0;
          }
          __session.wins += matchesWon;
          __session.losses += matchesLost;

          // Emit a single unified points_change event enriched with W/L and interval info
          try {
            if (pointsDelta != null && pointsDelta !== 0) {
              // Cap per-player arrays to avoid oversized entries
              const inc = Array.isArray(captureOnce.__lastIncreasedMembers) ? captureOnce.__lastIncreasedMembers.slice(0, 50) : [];
              const dec = Array.isArray(captureOnce.__lastDecreasedMembers) ? captureOnce.__lastDecreasedMembers.slice(0, 50) : [];
              appendEvent({
                type: 'points_change',
                delta: pointsDelta,
                from: prevTotal,
                  to: newTotal,
                place: squadronPlace ?? null,
                totalPointsAbove: totalPointsAbove ?? null,
                totalPointsBelow: totalPointsBelow ?? null,
                matchesWon,
                matchesLost,
                gainedPlayers: gainedPoints,
                lostPlayers: lostPoints,
                membersIncreased: inc,
                membersDecreased: dec,
                dateKey: __session.dateKey,
                windowKey: __session.windowKey || null,
              });
              // Live-update the session summary message for the active window
              try {
                if (activeWindow && __session.windowKey === activeWindow.key) {
                  const { updateByKey } = getDiscordWinLossUpdater();
                  if (typeof updateByKey === 'function') await updateByKey(activeWindow.key, buildWindowSummaryContent(activeWindow));
                }
              } catch (_) {}
            }
          } catch (_) {}
          
          // Compose a session summary line akin to Python's tracker output
          const hh = String(now.getUTCHours()).padStart(2, '0');
          const mm = String(now.getUTCMinutes()).padStart(2, '0');
          const timeSummary = `${hh}:${mm}`.padEnd(5, ' ');
          const deltaFromStart = (newTotal != null && __session.startingPoints != null) ? (Number(newTotal) - Number(__session.startingPoints)) : null;
          const wlSummary = `${__session.wins}/${__session.losses}`;
          const intervalSummary = matchesWon === 0 && matchesLost === 0
            ? 'no matches'
            : (matchesWon && matchesLost ? `${matchesWon} won, ${matchesLost} lost` : (matchesWon ? `${matchesWon} match${matchesWon>1?'es':''} won` : `${matchesLost} match${matchesLost>1?'es':''} lost`));
          const pointsChangeStr = (pointsDelta != null)
            ? (pointsDelta < 0 ? `- ${Math.abs(pointsDelta)} points` : `+ ${pointsDelta} points`)
            : '± 0 points';
          const startStr = (__session.startingPoints != null && newTotal != null) ? `${__session.startingPoints} → ${newTotal}` : 'n/a';
          const sessionDeltaStr = (deltaFromStart != null) ? `${deltaFromStart >= 0 ? '+' : ''}${deltaFromStart}` : 'n/a';
          msgLines.push(`• Points  change: ${prevTotal} → ${newTotal} (${pointsDelta >= 0 ? '+' : ''}${pointsDelta}); interval: ${intervalSummary}`);
          msgLines.push(`• Session change: ${startStr} (Δ ${sessionDeltaStr}) W/L ${wlSummary}`);

          // Helpers for monospace alignment
          const safeName = (r) => (r['Player'] || r['player'] || 'Unknown').toString();
          const safeRole = (r) => (r['Role'] || r['role'] || '').toString();
          const safeRating = (r) => (String((r['Personal clan rating'] || r['rating'] || '')).replace(/\s+/g, ''));
          const padRight = (s, n) => s.length >= n ? s.slice(0, n) : (s + ' '.repeat(n - s.length));
          const padLeft = (s, n) => s.length >= n ? s.slice(-n) : (' '.repeat(n - s.length) + s);

          const buildLines = (list, symbol) => {
            const shown = list.slice(0, 10);
            const maxNameLen = Math.max(0, ...shown.map(r => safeName(r).length));
            const maxRatingLen = Math.max(0, ...shown.map(r => safeRating(r).length));
            return shown.map(r => {
              const nameP = padRight(safeName(r), Math.min(maxNameLen, 30));
              const ratingP = padLeft(safeRating(r) || '0', Math.min(Math.max(maxRatingLen, 1), 5));
              const role = safeRole(r) || 'Member';
              return `   ${symbol} ${nameP} (${ratingP}, ${role})`;
            });
          };

          if (removed.length) {
            msgLines.push('• Departures:');
            msgLines.push(...buildLines(removed, '-'));
            // Events: member leave (delta reflects squadron Squadron ponts change)
            for (const r of removed) {
              const member = {
                'Player': safeName(r),
                'Personal clan rating': safeRating(r) || '0',
                'Role': safeRole(r) || 'Member',
                'Date of entry': (r['Date of entry'] || r['date of entry'] || r['Date'] || '').toString(),
              };
              appendEvent({
                type: 'member_leave',
                delta: pointsDelta ?? null,
                member,
              });
            }
          }
          if (added.length) {
            msgLines.push('• New members:');
            msgLines.push(...buildLines(added, '+'));
            // Events: member join (delta reflects squadron Squadron ponts change)
            for (const r of added) {
              const member = {
                'Player': safeName(r),
                'Personal clan rating': safeRating(r) || '0',
                'Role': safeRole(r) || 'Member',
                'Date of entry': (r['Date of entry'] || r['date of entry'] || r['Date'] || '').toString(),
              };
              appendEvent({
                type: 'member_join',
                delta: pointsDelta ?? null,
                member,
              });
            }
          }
        }

        const composed = msgLines.join('\n');
        console.log(composed);
        // Prefer dedicated win/loss channel if configured; fallback to default channel
        const sendWL = getDiscordWinLossSend();
        if (sendWL) {
          try { await sendWL(composed); } catch (_) { /* ignore */ }
        } else {
          const send = getDiscordSend();
          if (send) {
            try { await send(composed); } catch (_) { /* do not mirror message to events log */ }
          }
        }
      } catch (e) {
        console.warn('⚠️ Squadron tracker: diff/notify failed:', e && e.message ? e.message : e);
      }

      // Persist session state with snapshot
      try {
        snapshot.session = {
          dateKey: __session.dateKey,
          startedAt: __session.startedAt ? __session.startedAt.toISOString() : null,
          startingPoints: __session.startingPoints,
          wins: __session.wins,
          losses: __session.losses,
          lastInterval: {
            gainedPlayers: gainedPoints,
            lostPlayers: lostPoints,
            matchesWon,
            matchesLost,
            pointsDelta: (typeof pointsDelta === 'number') ? pointsDelta : null,
          },
        };
      } catch (_) {}
      appendSnapshot(dataFile, snapshot);
      lastKey = key;
      lastSnapshot = pruneSnapshot(snapshot);
      console.log('📈 Squadron tracker: change detected and recorded.');
    } else {
      // Even if no change, ensure one final snapshot at/after 23:30 UTC
      try {
        const cutoffMin = DAILY_CUTOFF_MIN;
        const now = new Date();
        const curMin = now.getUTCHours() * 60 + now.getUTCMinutes();
        const last = readLastSnapshot(dataFile);
        const sameDay = (d1, d2) => d1 && d2 && d1.getUTCFullYear() === d2.getUTCFullYear() && d1.getUTCMonth() === d2.getUTCMonth() && d1.getUTCDate() === d2.getUTCDate();
        if (last && sameDay(new Date(last.ts), now)) {
          const lastDate = new Date(last.ts);
          const lastMin = lastDate.getUTCHours() * 60 + lastDate.getUTCMinutes();
          // If it's past cutoff, and we haven't saved a post-cutoff snapshot today, do it now
          if (curMin >= cutoffMin && (isNaN(lastMin) || lastMin < cutoffMin)) {
            // Safeguard: if current snapshot has no member rows, reuse last known rows
            try {
              const hasRows = snapshot && snapshot.data && Array.isArray(snapshot.data.rows) && snapshot.data.rows.length > 0;
              const lastHasRows = lastSnapshot && lastSnapshot.data && Array.isArray(lastSnapshot.data.rows) && lastSnapshot.data.rows.length > 0;
              if (!hasRows && lastHasRows) {
                snapshot.data = { ...lastSnapshot.data };
                snapshot.membersCaptured = true;
                console.log('ℹ️ Daily cutoff: reused last known member rows for snapshot.');
              }
            } catch (_) {}
            // Attach session at cutoff as well
            try {
              snapshot.session = {
                dateKey: __session.dateKey,
                startedAt: __session.startedAt ? __session.startedAt.toISOString() : null,
                startingPoints: __session.startingPoints,
                wins: __session.wins,
                losses: __session.losses,
              };
            } catch (_) {}
            appendSnapshot(dataFile, snapshot);
            lastKey = simplifyForComparison(snapshot);
            lastSnapshot = pruneSnapshot(snapshot);
            console.log('🕧 Squadron tracker: daily cutoff snapshot saved.');
            // Reset session at cutoff for the new day
            try {
              const resetNow = new Date();
              const yy = resetNow.getUTCFullYear();
              const mm2 = String(resetNow.getUTCMonth() + 1).padStart(2, '0');
              const dd2 = String(resetNow.getUTCDate()).padStart(2, '0');
              const newStarting = (typeof snapshot.totalPoints === 'number') ? snapshot.totalPoints : (__session.startingPoints ?? null);
              // Persist a session_reset event with new starting points
              try { if (newStarting != null) appendEvent({ type: 'session_reset', startingPoints: newStarting, dateKey: `${yy}-${mm2}-${dd2}` }); } catch (_) {}
              __session.startedAt = resetNow;
              __session.dateKey = `${yy}-${mm2}-${dd2}`;
              __session.startingPoints = newStarting;
              __session.wins = 0;
              __session.losses = 0;
            } catch (_) {}
          }
        }
      } catch (_) {}
      console.log('ℹ️ Squadron tracker: no change.');
    }
  }

  await captureOnce();
  const interval = setInterval(captureOnce, POLL_INTERVAL_MS);

  // Expose a stop handle
  return {
    enabled: true,
    stop: async () => { try { clearInterval(interval); } catch (_) {} }
  };
}

module.exports = { startSquadronTracker };
