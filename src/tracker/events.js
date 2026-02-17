// src/tracker/events.js
const fs = require('fs');
const path = require('path');
const { logError, isWithinWindow } = require('./utils');

const EVENTS_FILE = 'squadron_events.json';

function getEventsFilePath() {
  return path.join(process.cwd(), EVENTS_FILE);
}

// Ensure events file exists with valid structure
function ensureEventsFile() {
  const file = getEventsFilePath();
  if (!fs.existsSync(file)) {
    try { 
      fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8'); 
    } catch (e) {
      logError('ensureEventsFile.write', e);
    }
  } else {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
        fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8');
      }
    } catch (e) {
      logError('ensureEventsFile.parse', e);
      try { 
        fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8'); 
      } catch (e2) {
        logError('ensureEventsFile.writeFallback', e2);
      }
    }
  }
  return file;
}

// Read events array from squadron_events.json
function readEventsFile() {
  try {
    const file = ensureEventsFile();
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(obj.events) ? obj.events : [];
  } catch (e) {
    logError('readEventsFile', e);
    return [];
  }
}

// Append an event to the events file
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
  } catch (e) {
    logError('appendEvent', e);
  }
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
    let delta = Number(ev.delta || 0);
    sessionDelta += delta;
    cumWins += Number(ev.matchesWon || 0);
    cumLosses += Number(ev.matchesLost || 0);
    const ptsStr = (delta >= 0 ? `+ ${delta} points` : `- ${Math.abs(delta)} points`).padEnd(13, ' ');
    const wlStr = `${cumWins}/${cumLosses}`.padEnd(6, ' ');
    const timeStr = hhmm.padEnd(7, ' ');
    let sessStr = String(sessionDelta).padStart(9, ' ');
    if (sessionDelta > 0) sessStr = `+${sessionDelta}`;
    let matchText = 'no matches';
    const won = Number(ev.matchesWon || 0);
    const lost = Number(ev.matchesLost || 0);
    if (won > 0) matchText = `${won} match${won > 1 ? 'es' : ''} won`;
    else if (lost > 0) matchText = `${lost} match${lost > 1 ? 'es' : ''} lost`;
    lines.push(`${ptsStr} ${wlStr} ${timeStr} ${sessStr} ${matchText}`);
  }
  return lines;
}

// Build full summary content string for a window
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

module.exports = {
  ensureEventsFile,
  readEventsFile,
  appendEvent,
  buildWindowSummaryLines,
  buildWindowSummaryContent,
};
