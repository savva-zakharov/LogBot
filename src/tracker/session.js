// src/tracker/session.js
const { dateKeyUTC, getCurrentWindow, isWithinWindow } = require('./utils');
const { readEventsFile, appendEvent } = require('./events');

// --- Session state (W/L and starting points) ---
// Resets at daily cutoff. In-memory only.
const __session = {
  startedAt: null,           // Date
  dateKey: null,             // YYYY-MM-DD
  startingPoints: null,      // number
  startingPos: null,         // number
  wins: 0,
  losses: 0,
  windowKey: null,           // e.g., 2025-08-17|EU or 2025-08-17|US
};

const __playerSession = {
  windowKey: null,
  dateKey: null,
  startingPointsByPlayer: new Map(),
};

function getSession() {
  return __session;
}

function resetSession() {
  __session.startedAt = null;
  __session.dateKey = null;
  __session.startingPoints = null;
  __session.startingPos = null;
  __session.wins = 0;
  __session.losses = 0;
  __session.windowKey = null;
}

function initializeSession(startingPoints, startingPos, window) {
  const now = new Date();
  __session.startedAt = now;
  __session.dateKey = dateKeyUTC(window.start);
  __session.startingPoints = startingPoints;
  __session.startingPos = startingPos;
  __session.wins = 0;
  __session.losses = 0;
  __session.windowKey = window.key;
}

function updateSessionWinsLosses(matchesWon, matchesLost) {
  __session.wins += matchesWon;
  __session.losses += matchesLost;
}

function getSessionStats() {
  return {
    dateKey: __session.dateKey,
    startedAt: __session.startedAt ? __session.startedAt.toISOString() : null,
    startingPoints: __session.startingPoints,
    startingPos: __session.startingPos,
    wins: __session.wins,
    losses: __session.losses,
    windowKey: __session.windowKey,
  };
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
    let startingPos = null;
    let startedAt = window.start;
    let wins = 0, losses = 0;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const ets = ev.ts ? new Date(ev.ts) : null;
      if (!ets || !isWithinWindow(ets, window)) continue;
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
      __session.dateKey = dateKeyUTC(window.start);
      __session.startedAt = startedAt || window.start;
      __session.startingPoints = startingPoints;
      __session.startingPos = startingPos;
      __session.wins = wins;
      __session.losses = losses;
      __session.windowKey = window.key;
    }
  } catch (e) {
    console.warn(`⚠️ [rebuildSessionFromEvents] ${e && e.message ? e.message : e}`);
  }
}

// Handle window end - reset session state
function handleWindowEnd() {
  if (!__session.windowKey) return;
  
  try {
    appendEvent({ 
      type: 'session_reset', 
      reason: 'window_end', 
      windowKey: __session.windowKey, 
      dateKey: __session.dateKey 
    });
  } catch (e) {
    console.warn(`⚠️ [handleWindowEnd.appendEvent] ${e.message}`);
  }
  
  __session.startedAt = null;
  __session.dateKey = dateKeyUTC();
  __session.startingPoints = null;
  __session.wins = 0;
  __session.losses = 0;
  __session.windowKey = null;
}

// Handle new window start
function handleWindowStart(window, prevTotal, snapshot) {
  const now = new Date();
  const startingPoints = prevTotal != null ? prevTotal : (snapshot.totalPoints != null ? snapshot.totalPoints : null);
  const startingPos = snapshot?.squadronPlace ?? null;
  
  initializeSession(startingPoints, startingPos, window);
  
  try {
    if (startingPoints != null) {
      appendEvent({ 
        type: 'session_start', 
        startingPoints, 
        startingPos, 
        dateKey: __session.dateKey, 
        windowKey: __session.windowKey 
      });
    }
  } catch (e) {
    console.warn(`⚠️ [handleWindowStart.appendEvent] ${e.message}`);
  }
}

// Ensure session is initialized if in a window but fields are missing
function ensureSessionInitialized(window, prevTotal, snapshot) {
  if (__session.startingPoints == null || __session.startedAt == null) {
    const now = new Date();
    __session.startedAt = now;
    __session.dateKey = dateKeyUTC();
    __session.startingPoints = prevTotal != null ? prevTotal : (snapshot.totalPoints != null ? snapshot.totalPoints : null);
    __session.startingPos = snapshot?.squadronPlace ?? null;
    __session.wins = __session.wins | 0;
    __session.losses = __session.losses | 0;
  }
}

module.exports = {
  getSession,
  resetSession,
  initializeSession,
  updateSessionWinsLosses,
  getSessionStats,
  rebuildSessionFromEvents,
  handleWindowEnd,
  handleWindowStart,
  ensureSessionInitialized,
};
