// src/squadron/sessionManager.js
// Manages session state for squadron and individual player tracking

const { getCurrentWindow, dateKeyUTC, isWithinWindow } = require('./windowManager');

// Squadron session state (W/L and starting points)
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

// Player session tracking - stores individual player points at session start
const __playerSession = {
  windowKey: null,
  dateKey: null,
  startingPointsByPlayer: new Map(),
  // Track when players joined the session to avoid resetting points for players who were already in the session
  playerJoinTimestamps: new Map(),
  // Track whether we've already reset points for this window to avoid multiple resets
  windowResetDone: false,
};

/**
 * Get the current squadron session
 * @returns {Object} Session object
 */
function getSession() {
  return __session;
}

/**
 * Get the current player session
 * @returns {Object} Player session object
 */
function getPlayerSession() {
  return __playerSession;
}

/**
 * Get player starting points for the current session
 * @param {string} playerName - Player name
 * @returns {number|null} Starting points or null
 */
function getPlayerStartingPoints(playerName) {
  if (__playerSession.windowKey && __playerSession.windowKey === __session.windowKey) {
    return __playerSession.startingPointsByPlayer.get(playerName) || null;
  }
  return null;
}

/**
 * Set player starting points for the current session
 * @param {string} playerName - Player name
 * @param {number} points - Starting points
 */
function setPlayerStartingPoints(playerName, points) {
  if (__playerSession.windowKey && __playerSession.windowKey === __session.windowKey) {
    __playerSession.startingPointsByPlayer.set(playerName, points);
  }
}

/**
 * Reset squadron session for new window
 * @param {Object} window - Window object
 * @param {number|null} startingPoints - Starting squadron points
 * @param {number|null} startingPos - Starting squadron position
 */
function resetSquadronSession(window, startingPoints, startingPos) {
  const now = new Date();
  const todayKey = dateKeyUTC(now);
  
  __session.startedAt = now;
  __session.dateKey = todayKey;
  __session.startingPoints = startingPoints;
  __session.startingPos = startingPos;
  __session.wins = 0;
  __session.losses = 0;
  __session.windowKey = window.key;
  
  // Reset player session tracking for new window
  __playerSession.windowKey = window.key;
  __playerSession.dateKey = todayKey;
  __playerSession.startingPointsByPlayer.clear();
  __playerSession.playerJoinTimestamps.clear();
  __playerSession.windowResetDone = false;
}

/**
 * Clear session when window ends
 */
function clearSessionAtWindowEnd() {
  __session.startedAt = null;
  __session.dateKey = dateKeyUTC();
  __session.startingPoints = null;
  __session.wins = 0;
  __session.losses = 0;
  __session.windowKey = null;
  
  // Reset player session tracking when window ends
  __playerSession.windowKey = null;
  __playerSession.dateKey = null;
  __playerSession.startingPointsByPlayer.clear();
  __playerSession.playerJoinTimestamps.clear();
  __playerSession.windowResetDone = false;
}

/**
 * Update session win/loss counts
 * @param {number} matchesWon - Matches won
 * @param {number} matchesLost - Matches lost
 */
function updateSessionWinsLosses(matchesWon, matchesLost) {
  __session.wins += matchesWon;
  __session.losses += matchesLost;
}

/**
 * Initialize session from events if missing fields
 * @param {Object} window - Current window
 * @param {number|null} prevTotal - Previous total points
 * @param {Object|null} prev - Previous snapshot
 * @param {Object|null} snapshot - Current snapshot
 */
function ensureSessionInitialized(window, prevTotal, prev, snapshot) {
  const now = new Date();
  const todayKey = dateKeyUTC(now);
  
  if (__session.startingPoints == null || __session.startedAt == null) {
    __session.startedAt = now;
    __session.dateKey = todayKey;
    __session.startingPoints = (prevTotal != null ? prevTotal : (snapshot?.totalPoints != null ? snapshot.totalPoints : null));
    __session.startingPos = (prev?.squadronPlace != null ? prev.squadronPlace : (snapshot?.squadronPlace != null ? snapshot.squadronPlace : null));
    __session.wins = __session.wins | 0;
    __session.losses = __session.losses | 0;
    __session.windowKey = window.key;
  }
}

/**
 * Mark player points reset as done for current window
 */
function markPlayerPointsResetDone() {
  if (__playerSession.windowKey === __session.windowKey) {
    __playerSession.windowResetDone = true;
  }
}

/**
 * Check if player points have been reset for current window
 * @returns {boolean} True if already reset
 */
function isPlayerPointsResetDone() {
  return __playerSession.windowResetDone;
}

/**
 * Track player join timestamp
 * @param {string} playerName - Player name
 * @param {number} timestamp - Join timestamp
 */
function trackPlayerJoin(playerName, timestamp) {
  if (!__playerSession.playerJoinTimestamps.has(playerName)) {
    __playerSession.playerJoinTimestamps.set(playerName, timestamp);
  }
}

/**
 * Get player join timestamp
 * @param {string} playerName - Player name
 * @returns {number|null} Join timestamp or null
 */
function getPlayerJoinTimestamp(playerName) {
  return __playerSession.playerJoinTimestamps.get(playerName) || null;
}

/**
 * Reset session at daily cutoff
 * @param {Object} snapshot - Current snapshot
 */
function resetSessionAtCutoff(snapshot) {
  const resetNow = new Date();
  const yy = resetNow.getUTCFullYear();
  const mm2 = String(resetNow.getUTCMonth() + 1).padStart(2, '0');
  const dd2 = String(resetNow.getUTCDate()).padStart(2, '0');
  const newStarting = (typeof snapshot.totalPoints === 'number') ? snapshot.totalPoints : (__session.startingPoints ?? null);
  const newStartingPos = (typeof snapshot.squadronPlace === 'number') ? snapshot.squadronPlace : (__session.startingPos ?? null);
  
  __session.startedAt = resetNow;
  __session.dateKey = `${yy}-${mm2}-${dd2}`;
  __session.startingPoints = newStarting;
  __session.startingPos = newStartingPos;
  __session.wins = 0;
  __session.losses = 0;
  
  // Also reset player session
  __playerSession.windowKey = null;
  __playerSession.dateKey = `${yy}-${mm2}-${dd2}`;
  __playerSession.startingPointsByPlayer.clear();
  __playerSession.playerJoinTimestamps.clear();
  __playerSession.windowResetDone = false;
}

/**
 * Get session summary for Discord messages
 * @param {number|null} newTotal - Current total points
 * @returns {Object} Session summary object
 */
function getSessionSummary(newTotal) {
  const deltaFromStart = (newTotal != null && __session.startingPoints != null) 
    ? (Number(newTotal) - Number(__session.startingPoints)) 
    : null;
  const wlSummary = `${__session.wins}/${__session.losses}`;
  const startStr = (__session.startingPoints != null && newTotal != null) 
    ? `${__session.startingPoints} → ${newTotal}` 
    : 'n/a';
  const sessionDeltaStr = (deltaFromStart != null) 
    ? `${deltaFromStart >= 0 ? '+' : ''}${deltaFromStart}` 
    : 'n/a';
  
  return {
    wins: __session.wins,
    losses: __session.losses,
    wlSummary,
    startingPoints: __session.startingPoints,
    startingPos: __session.startingPos,
    deltaFromStart,
    startStr,
    sessionDeltaStr,
    startedAt: __session.startedAt,
    dateKey: __session.dateKey,
    windowKey: __session.windowKey,
  };
}

/**
 * Get session object for snapshot persistence
 * @returns {Object} Session object for persistence
 */
function getSessionForSnapshot() {
  return {
    dateKey: __session.dateKey,
    startedAt: __session.startedAt ? __session.startedAt.toISOString() : null,
    startingPoints: __session.startingPoints,
    startingPos: __session.startingPos,
    wins: __session.wins,
    losses: __session.losses,
  };
}

module.exports = {
  getSession,
  getPlayerSession,
  getPlayerStartingPoints,
  setPlayerStartingPoints,
  resetSquadronSession,
  clearSessionAtWindowEnd,
  updateSessionWinsLosses,
  ensureSessionInitialized,
  markPlayerPointsResetDone,
  isPlayerPointsResetDone,
  trackPlayerJoin,
  getPlayerJoinTimestamp,
  resetSessionAtCutoff,
  getSessionSummary,
  getSessionForSnapshot,
};
