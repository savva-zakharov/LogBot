// src/tracker/session.js
const { dateKeyUTC, getCurrentWindow, isWithinWindow } = require('./utils');
const { readEventsFile, appendEvent, buildWindowSummaryContent } = require('./events');
const { formatSessionSummary } = require('../utils/formatHelper');

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

// Track last completed session for queries after window ends
const __lastCompletedSession = {
  startedAt: null,
  endedAt: null,
  dateKey: null,
  startingPoints: null,
  startingPos: null,
  endingPoints: null,
  endingPos: null,
  wins: 0,
  losses: 0,
  windowKey: null,
  windowLabel: null,       // 'EU' or 'US'
};

// Timer for delayed session end processing
let __sessionEndTimer = null;
const SESSION_END_DELAY_MS = 60 * 60 * 1000; // 1 hour delay

const __playerSession = {
  windowKey: null,
  dateKey: null,
  startingPointsByPlayer: new Map(),
};

function getSession() {
  // Return current session if active, otherwise return last completed session
  if (__session.windowKey) {
    return { ...__session, isCompleted: false };
  }
  if (__lastCompletedSession.windowKey) {
    return { ...__lastCompletedSession, isCompleted: true };
  }
  return { ...__session, isCompleted: false };
}

function getLastCompletedSession() {
  return { ...__lastCompletedSession };
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
    current: {
      dateKey: __session.dateKey,
      startedAt: __session.startedAt ? __session.startedAt.toISOString() : null,
      startingPoints: __session.startingPoints,
      startingPos: __session.startingPos,
      wins: __session.wins,
      losses: __session.losses,
      windowKey: __session.windowKey,
      isActive: !!__session.windowKey,
    },
    lastCompleted: __lastCompletedSession.windowKey ? {
      dateKey: __lastCompletedSession.dateKey,
      startedAt: __lastCompletedSession.startedAt ? __lastCompletedSession.startedAt.toISOString() : null,
      endedAt: __lastCompletedSession.endedAt ? __lastCompletedSession.endedAt.toISOString() : null,
      startingPoints: __lastCompletedSession.startingPoints,
      endingPoints: __lastCompletedSession.endingPoints,
      startingPos: __lastCompletedSession.startingPos,
      endingPos: __lastCompletedSession.endingPos,
      wins: __lastCompletedSession.wins,
      losses: __lastCompletedSession.losses,
      windowKey: __lastCompletedSession.windowKey,
      windowLabel: __lastCompletedSession.windowLabel,
    } : null,
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

// Cancel any pending session end timer
function cancelPendingSessionEnd() {
  if (__sessionEndTimer) {
    clearTimeout(__sessionEndTimer);
    __sessionEndTimer = null;
    console.log('ℹ️ [Session] Cancelled pending session end timer');
  }
}

// Process session end after delay (archive events, save final stats)
function processDelayedSessionEnd(windowLabel, dateKey, endingPoints, endingPos, archiveEventsFile, getDiscordWinLossSend) {
  try {
    // Save final session stats to last completed session
    // Use fallback values if starting points/pos are null
    const startingPoints = __session.startingPoints ?? endingPoints ?? 0;
    const startingPos = __session.startingPos ?? endingPos ?? 0;
    
    __lastCompletedSession.startedAt = __session.startedAt;
    __lastCompletedSession.endedAt = new Date();
    __lastCompletedSession.dateKey = dateKey;
    __lastCompletedSession.startingPoints = startingPoints;
    __lastCompletedSession.endingPoints = endingPoints;
    __lastCompletedSession.startingPos = startingPos;
    __lastCompletedSession.endingPos = endingPos;
    __lastCompletedSession.wins = __session.wins;
    __lastCompletedSession.losses = __session.losses;
    __lastCompletedSession.windowKey = __session.windowKey;
    __lastCompletedSession.windowLabel = windowLabel;

    console.log(`📊 [Session] ${windowLabel} session finalized: ${__session.wins}W/${__session.losses}L, ` +
      `${startingPoints} → ${endingPoints}`);

    // Build and post session summary to Discord
    postSessionSummaryToDiscord(windowLabel, dateKey, endingPoints, endingPos, getDiscordWinLossSend, startingPoints, startingPos);

    // Clear current session
    __session.startedAt = null;
    __session.dateKey = dateKeyUTC();
    __session.startingPoints = null;
    __session.startingPos = null;
    __session.wins = 0;
    __session.losses = 0;
    __session.windowKey = null;

    __sessionEndTimer = null;
  } catch (e) {
    console.warn(`⚠️ [processDelayedSessionEnd] ${e.message}`);
  }
}

// Build and post session summary to Discord win/loss channel
async function postSessionSummaryToDiscord(windowLabel, dateKey, endingPoints, endingPos, getDiscordWinLossSend, startingPoints, startingPos) {
  try {
    const sendWL = getDiscordWinLossSend();
    if (typeof sendWL !== 'function') {
      console.log('ℹ️ [Session] No Discord win/loss channel configured, skipping summary post');
      return;
    }

    const session = __lastCompletedSession;
    
    // Use passed starting values (more reliable than from session object)
    const effectiveStartingPoints = startingPoints ?? session.startingPoints ?? endingPoints ?? 0;
    const effectiveStartingPos = startingPos ?? session.startingPos ?? endingPos ?? 0;
    
    // Get player data from squadron_data.json
    let playerData = [];
    try {
      const fs = require('fs');
      const path = require('path');
      const dataFile = path.join(process.cwd(), 'squadron_data.json');
      if (fs.existsSync(dataFile)) {
        const content = fs.readFileSync(dataFile, 'utf8');
        const obj = JSON.parse(content);
        if (obj && obj.data && Array.isArray(obj.data.rows)) {
          // Calculate threshold for highlighting (average points change)
          const changes = obj.data.rows.map(r => {
            const cur = toNumber(r['Points'] || r['points'] || '0');
            const start = toNumber(r['PointsStart'] || r['pointsStart'] || cur);
            return cur - start;
          });
          const avgChange = changes.reduce((a, b) => a + Math.abs(b), 0) / changes.length;
          const threshold = Math.max(5, avgChange * 0.5);
          
          playerData = obj.data.rows.map((r, i) => {
            const cur = toNumber(r['Points'] || r['points'] || '0');
            const start = toNumber(r['PointsStart'] || r['pointsStart'] || cur);
            return {
              position: i + 1,
              name: r['Player'] || r['player'] || 'Unknown',
              points: cur,
              pointsDelta: cur - start,
              threshold: threshold,
            };
          });
          
          // Filter to only players with changes and sort by delta
          playerData = playerData
            .filter(p => p.pointsDelta !== 0)
            .sort((a, b) => Math.abs(b.pointsDelta) - Math.abs(a.pointsDelta))
            .slice(0, 20); // Top 20 changes
        }
      }
    } catch (e) {
      console.warn(`⚠️ [postSessionSummaryToDiscord.readPlayerData] ${e.message}`);
    }
    
    // Calculate width based on player data or default
    let width = 50;
    if (playerData.length > 0) {
      // Estimate width from player table
      const maxNameLen = Math.max(...playerData.map(p => p.name.length));
      width = 10 + maxNameLen + 12 + 8; // pos + name + points + delta columns
    }

    // Use formatFullSessionSummary to include player table
    const summary = formatFullSessionSummary(
      session,
      effectiveStartingPoints,
      endingPoints,
      effectiveStartingPos,
      endingPos,
      playerData,
      width,
      true // use ANSI colors
    );

    const content = '```ansi\n' + summary + '\n```';

    await sendWL(content);
    console.log(`📤 [Session] Posted ${windowLabel} session summary to Discord`);
  } catch (e) {
    console.warn(`⚠️ [postSessionSummaryToDiscord] ${e.message}`);
  }
}

// Helper to parse numbers
function toNumber(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}

// Handle window end - schedule delayed processing
function handleWindowEnd(archiveEventsFile, getCurrentPoints, getDiscordWinLossSend) {
  if (!__session.windowKey) return;

  // Extract window label from windowKey (e.g., "2025-02-17|EU" -> "EU")
  const windowLabel = __session.windowKey.split('|')[1] || 'UNKNOWN';
  const dateKey = __session.dateKey || dateKeyUTC();

  // Cancel any existing timer (in case of rapid window changes)
  cancelPendingSessionEnd();

  try {
    appendEvent({
      type: 'session_reset',
      reason: 'window_end',
      windowKey: __session.windowKey,
      dateKey: dateKey
    });
  } catch (e) {
    console.warn(`⚠️ [handleWindowEnd.appendEvent] ${e.message}`);
  }

  // Get current points immediately (before session is cleared)
  let currentPoints = null;
  let currentPos = null;
  if (typeof getCurrentPoints === 'function') {
    try {
      const finalData = getCurrentPoints();
      currentPoints = finalData?.points ?? null;
      currentPos = finalData?.pos ?? null;
    } catch (e) {
      console.warn(`⚠️ [handleWindowEnd.getCurrentPoints] ${e.message}`);
    }
  }

  // Ensure starting values are set (fallback to current values if not set)
  if (__session.startingPoints == null && currentPoints != null) {
    __session.startingPoints = currentPoints;
    console.log(`[Session] Set startingPoints from current: ${currentPoints}`);
  }
  if (__session.startingPos == null && currentPos != null) {
    __session.startingPos = currentPos;
    console.log(`[Session] Set startingPos from current: ${currentPos}`);
  }

  // Schedule delayed processing (1 hour after window end)
  // This allows time for late data updates to be captured
  const now = new Date();
  const delayUntil = new Date(now.getTime() + SESSION_END_DELAY_MS);
  console.log(`⏱️ [Session] ${windowLabel} session ended at ${now.toISOString()}, ` +
    `final processing scheduled for ${delayUntil.toISOString()} (${SESSION_END_DELAY_MS / 60000} min delay)`);
  console.log(`[Session] Starting values: points=${__session.startingPoints}, pos=${__session.startingPos}`);

  __sessionEndTimer = setTimeout(() => {
    console.log(`⏰ [Session] Processing delayed end for ${windowLabel} session`);

    // Get final points if available
    let endingPoints = null;
    let endingPos = null;
    if (typeof getCurrentPoints === 'function') {
      try {
        const finalData = getCurrentPoints();
        endingPoints = finalData?.points ?? null;
        endingPos = finalData?.pos ?? null;
      } catch (e) {
        console.warn(`⚠️ [handleWindowEnd.getCurrentPoints] ${e.message}`);
      }
    }

    // Archive events file before finalizing session
    if (typeof archiveEventsFile === 'function') {
      try {
        archiveEventsFile(windowLabel, dateKey);
      } catch (e) {
        console.warn(`⚠️ [handleWindowEnd.archiveEventsFile] ${e.message}`);
      }
    }

    // Finalize session with ending stats and post to Discord
    processDelayedSessionEnd(windowLabel, dateKey, endingPoints, endingPos, archiveEventsFile, getDiscordWinLossSend);
  }, SESSION_END_DELAY_MS);
}

// Handle new window start
function handleWindowStart(window, prevTotal, snapshot) {
  const now = new Date();
  const startingPoints = prevTotal != null ? prevTotal : (snapshot.totalPoints != null ? snapshot.totalPoints : null);
  const startingPos = snapshot?.squadronPlace ?? null;

  // Cancel any pending session end from previous window
  cancelPendingSessionEnd();

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

// Check if we're within the extended session period (window end + 1 hour)
function isInExtendedSession(window) {
  if (!window) return false;
  if (__session.windowKey) return true; // Active session
  
  // Check if we're within 1 hour after the last window ended
  if (__lastCompletedSession.windowKey) {
    const lastWindowLabel = __lastCompletedSession.windowLabel;
    const now = new Date();
    
    // Calculate when the last window ended
    let windowEndTime;
    if (lastWindowLabel === 'EU') {
      // EU ends at 22:00 UTC
      windowEndTime = new Date(Date.UTC(
        __lastCompletedSession.endedAt?.getUTCFullYear() || now.getUTCFullYear(),
        __lastCompletedSession.endedAt?.getUTCMonth() || now.getUTCMonth(),
        __lastCompletedSession.endedAt?.getUTCDate() || now.getUTCDate(),
        22, 0, 0
      ));
    } else if (lastWindowLabel === 'US') {
      // US ends at 10:00 UTC
      windowEndTime = new Date(Date.UTC(
        __lastCompletedSession.endedAt?.getUTCFullYear() || now.getUTCFullYear(),
        __lastCompletedSession.endedAt?.getUTCMonth() || now.getUTCMonth(),
        __lastCompletedSession.endedAt?.getUTCDate() || now.getUTCDate(),
        10, 0, 0
      ));
    }
    
    if (windowEndTime) {
      const extendedEndTime = new Date(windowEndTime.getTime() + SESSION_END_DELAY_MS);
      return now < extendedEndTime;
    }
  }
  
  return false;
}

// Get session summary content (current or last completed)
function getSessionSummaryContent() {
  if (__session.windowKey) {
    const window = getCurrentWindow();
    if (window) {
      return buildWindowSummaryContent(window);
    }
  }
  // Return last completed session summary if no active window
  if (__lastCompletedSession.windowKey) {
    const pad = (n) => String(n).padStart(2, '0');
    const start = __lastCompletedSession.startedAt ? new Date(__lastCompletedSession.startedAt) : null;
    if (start) {
      const dd = start.getUTCDate();
      const mm = start.getUTCMonth() + 1;
      const yyyy = start.getUTCFullYear();
      const startLine = `${__lastCompletedSession.windowLabel} Session Summary - ${dd}/${mm}/${yyyy}`;
      const endLine = `Ended: ${pad(start.getUTCHours())}:${pad(start.getUTCMinutes())} UTC`;
      const pointsLine = `Points: ${__lastCompletedSession.startingPoints ?? 'N/A'} → ${__lastCompletedSession.endingPoints ?? 'N/A'}`;
      const wlLine = `W/L: ${__lastCompletedSession.wins}/${__lastCompletedSession.losses}`;
      return ['```', startLine, endLine, pointsLine, wlLine, '```'].join('\n');
    }
  }
  return '(no session data available)';
}

module.exports = {
  getSession,
  getLastCompletedSession,
  resetSession,
  initializeSession,
  updateSessionWinsLosses,
  getSessionStats,
  rebuildSessionFromEvents,
  handleWindowEnd,
  handleWindowStart,
  ensureSessionInitialized,
  cancelPendingSessionEnd,
  isInExtendedSession,
  getSessionSummaryContent,
  SESSION_END_DELAY_MS,
};
