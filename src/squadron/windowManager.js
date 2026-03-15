// src/squadron/windowManager.js
// Manages session windows (US: 02:00–10:00 UTC, EU: 14:00–22:00 UTC)

/**
 * Get UTC minutes from a date
 * @param {Date} date - The date to convert
 * @returns {number} Minutes since midnight UTC
 */
function utcMinutes(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/**
 * Get current active window based on current time
 * @param {Date} now - Current date (defaults to new Date())
 * @returns {Object|null} Window object with label, start, end, key or null if outside windows
 */
function getCurrentWindow(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const baseKey = `${y}-${m}-${d}`;
  const mins = utcMinutes(now);
  const mkDate = (h, min) => new Date(Date.UTC(y, now.getUTCMonth(), now.getUTCDate(), h, min, 0, 0));
  
  // US window: 02:00–10:00 UTC
  const usStart = mkDate(2, 0);
  const usEnd = mkDate(10, 0);
  
  // EU window: 14:00–22:00 UTC
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

/**
 * Parse a window key string into a window object
 * @param {string} windowKey - Window key in format "YYYY-MM-DD|LABEL"
 * @returns {Object|null} Window object or null if invalid
 */
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

/**
 * Check if a timestamp is within a window
 * @param {Date|number|string} ts - Timestamp to check
 * @param {Object} window - Window object
 * @returns {boolean} True if within window
 */
function isWithinWindow(ts, window) {
  if (!window) return false;
  const t = ts instanceof Date ? ts : new Date(ts);
  return t >= window.start && t < window.end;
}

/**
 * Get UTC date key in YYYY-MM-DD format
 * @param {Date} d - Date to convert (defaults to new Date())
 * @returns {string} Date key
 */
function dateKeyUTC(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Calculate milliseconds until next UTC midnight
 * @returns {number} Milliseconds until next UTC midnight
 */
function msUntilNextUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.getTime() - now.getTime();
}

module.exports = {
  utcMinutes,
  getCurrentWindow,
  parseWindowKey,
  isWithinWindow,
  dateKeyUTC,
  msUntilNextUtcMidnight,
};
