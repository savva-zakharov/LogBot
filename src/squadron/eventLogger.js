// src/squadron/eventLogger.js
// Handles event logging and management for squadron tracking

const fs = require('fs');
const path = require('path');

/**
 * Ensure events file exists
 * @returns {string} Path to events file
 */
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

/**
 * Append event to events file
 * @param {Object|string} messageOrEvent - Event object or message string
 * @param {Object} meta - Additional metadata
 */
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

/**
 * Read events from file
 * @returns {Array} Array of events
 */
function readEvents() {
  try {
    const file = ensureEventsFile();
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(obj.events) ? obj.events : [];
  } catch (_) { return []; }
}

/**
 * Get events within a window
 * @param {Object} window - Window object
 * @param {string} eventType - Optional event type filter
 * @returns {Array} Filtered events
 */
function getEventsInWindow(window, eventType = null) {
  const events = readEvents();
  return events.filter(ev => {
    if (!ev || !ev.ts) return false;
    const ets = new Date(ev.ts);
    const inWindow = ets >= window.start && ets < window.end;
    const typeMatch = eventType ? ev.type === eventType : true;
    return inWindow && typeMatch;
  });
}

/**
 * Rebuild session from events
 * @param {Object} window - Current window
 * @returns {Object|null} Session data or null
 */
function rebuildSessionFromEvents(window) {
  try {
    const events = readEvents();
    if (!events.length) return null;

    let startingPoints = null;
    let startingPos = null;
    let startedAt = window.start;
    let wins = 0, losses = 0;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const ets = ev.ts ? new Date(ev.ts) : null;
      if (!ets || !(ets >= window.start && ets < window.end)) continue;
      
      if (ev.type === 'session_start' || ev.type === 'session_reset') {
        if (typeof ev.startingPoints === 'number') startingPoints = ev.startingPoints;
        if (typeof ev.startingPos === 'number') startingPos = ev.startingPos;
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
        if (startingPos == null && typeof ev.place === 'number') startingPos = ev.place;
      }
    }

    if (startingPoints != null) {
      return {
        startedAt: startedAt || window.start,
        startingPoints,
        startingPos,
        wins,
        losses,
      };
    }
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Build window summary lines from events
 * @param {Array} events - Events to summarize
 * @param {Object} window - Window object
 * @returns {Array} Summary lines
 */
function buildWindowSummaryLines(events, window) {
  const lines = [];
  let cumWins = 0;
  let cumLosses = 0;
  let sessionDelta = 0;
  const pad = (n) => String(n).padStart(2, '0');
  
  for (const ev of events) {
    const d = new Date(ev.ts);
    const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    let delta = Number(ev.delta || 0);
    sessionDelta += delta;
    cumWins += Number(ev.matchesWon || 0);
    cumLosses += Number(ev.matchesLost || 0);
    const ptsStr = (delta >= 0 ? `+ ${delta} points` : `- ${Math.abs(delta)} points`).padEnd(13, ' ');
    const wlStr = `${cumWins}/${cumLosses}`.padEnd(6, ' ');
    const timeStr = hhmm.padEnd(7, ' ');
    let sessStr = String(sessionDelta);
    if (sessionDelta > 0) sessStr = `+${sessionDelta}`;
    sessStr = sessStr.padStart(9, ' ');
    let matchText = 'no matches';
    const won = Number(ev.matchesWon || 0);
    const lost = Number(ev.matchesLost || 0);
    if (won > 0) matchText = `${won} match${won > 1 ? 'es' : ''} won`;
    else if (lost > 0) matchText = `${lost} match${lost > 1 ? 'es' : ''} lost`;
    lines.push(`${ptsStr} ${wlStr} ${timeStr} ${sessStr} ${matchText}`);
  }
  return lines;
}

/**
 * Build full window summary content
 * @param {Object} window - Window object
 * @returns {string} Summary content
 */
function buildWindowSummaryContent(window) {
  if (!window) return '';
  const events = readEvents();
  const within = events.filter(ev => ev && ev.type === 'points_change' && ev.ts >= window.start && ev.ts < window.end);
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

module.exports = {
  ensureEventsFile,
  appendEvent,
  readEvents,
  getEventsInWindow,
  rebuildSessionFromEvents,
  buildWindowSummaryLines,
  buildWindowSummaryContent,
};
