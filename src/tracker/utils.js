// src/tracker/utils.js
const fs = require('fs');
const path = require('path');

// --- Module constants ---
const HTML_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
};

// --- Helper: log errors consistently ---
function logError(context, err) {
  const msg = err && err.message ? err.message : String(err);
  console.warn(`⚠️ [${context}] ${msg}`);
}

// --- Time utilities ---
function utcMinutes(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

// Helper: get UTC date key YYYY-MM-DD
function dateKeyUTC(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function msUntilNextUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.getTime() - now.getTime();
}

// --- Session window helpers (US: 02:00–10:00 UTC, EU: 14:00–22:00 UTC) ---
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

// --- Data utilities ---
function toNum(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}

function simplifyForComparison(snapshot) {
  // Consider headers, rows, totalPoints, and leaderboard for change detection
  const { headers, rows, leaderboard } = snapshot.data || {};
  const norm = (rows || []).map(r => {
    const obj = {};
    for (const k of Object.keys(r)) obj[k] = r[k];
    return obj;
  });
  const totalPoints = typeof snapshot.totalPoints === 'number' ? snapshot.totalPoints : null;
  return JSON.stringify({ headers, rows: norm, totalPoints, leaderboard });
}

// --- Directory helpers ---
function ensureLogsDir() {
  const dir = path.join(process.cwd(), 'logs');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    logError('ensureLogsDir', e);
  }
  return dir;
}

function ensureTmpDir() {
  const dir = path.join(process.cwd(), '.tmp');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    logError('ensureTmpDir', e);
  }
  return dir;
}

module.exports = {
  HTML_REQUEST_HEADERS,
  logError,
  utcMinutes,
  dateKeyUTC,
  msUntilNextUtcMidnight,
  getCurrentWindow,
  parseWindowKey,
  isWithinWindow,
  toNum,
  simplifyForComparison,
  ensureLogsDir,
  ensureTmpDir,
};
