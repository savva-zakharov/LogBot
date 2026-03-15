// src/squadron/squadronSessionStore.js
// Handles persistent storage of squadron session data (W/L, starting points, etc.)

const fs = require('fs');
const path = require('path');
const { withFileLock } = require('./fileLock');

const SESSION_FILE = path.join(process.cwd(), 'squadron_session.json');

/**
 * Load squadron session from persistent storage
 * @returns {Object|null} Session object or null if not found
 */
function loadSquadronSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      return null;
    }
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    
    // Convert ISO string back to Date
    if (data && data.startedAt) {
      data.startedAt = new Date(data.startedAt);
    }
    
    return data;
  } catch (e) {
    console.warn('[WARN] Failed to load squadron session:', e.message);
    return null;
  }
}

/**
 * Save squadron session to persistent storage
 * @param {Object} session - Session object to save
 * @returns {Promise<boolean>} True if saved successfully
 */
async function saveSquadronSession(session) {
  try {
    if (!session) {
      console.warn('[WARN] No squadron session to save');
      return false;
    }

    await withFileLock(SESSION_FILE, async () => {
      // Convert Date to ISO string for JSON serialization
      const dataToSave = {
        ...session,
        startedAt: session.startedAt ? session.startedAt.toISOString() : null,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(SESSION_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
    });
    return true;
  } catch (e) {
    console.error('[ERROR] Failed to save squadron session:', e.message);
    return false;
  }
}

/**
 * Clear squadron session from persistent storage
 * @returns {Promise<boolean>} True if cleared successfully
 */
async function clearSquadronSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      await withFileLock(SESSION_FILE, async () => {
        fs.unlinkSync(SESSION_FILE);
      });
    }
    return true;
  } catch (e) {
    console.error('[ERROR] Failed to clear squadron session:', e.message);
    return false;
  }
}

/**
 * Restore squadron session to in-memory state
 * @param {Object} sessionObj - In-memory session object to restore
 * @returns {Object} Result with restored flag and reason
 */
function restoreSquadronSession(sessionObj) {
  try {
    const persisted = loadSquadronSession();
    
    if (!persisted) {
      return { restored: false, reason: 'no_session' };
    }
    
    // Check if session is from a valid window
    const { getCurrentWindow, parseWindowKey } = require('./windowManager');
    const currentWindow = getCurrentWindow();
    
    if (persisted.windowKey) {
      const persistedWindow = parseWindowKey(persisted.windowKey);
      if (persistedWindow) {
        const windowAge = Date.now() - persistedWindow.start.getTime();
        const maxWindowAge = 12 * 60 * 60 * 1000; // 12 hours
        
        if (windowAge > maxWindowAge) {
          console.log(`[INFO] Squadron session too old (${Math.round(windowAge/1000/60/60)}h), not restoring`);
          clearSquadronSession();
          return { restored: false, reason: 'too_old' };
        }
        
        // Check if window matches current window
        if (currentWindow && persisted.windowKey !== currentWindow.key) {
          console.log(`[INFO] Squadron session from different window (${persisted.windowKey} vs ${currentWindow.key})`);
          // Don't clear - may be from previous window today
          return { restored: false, reason: 'wrong_window' };
        }
      }
    }
    
    // Restore to in-memory object
    sessionObj.startedAt = persisted.startedAt;
    sessionObj.dateKey = persisted.dateKey;
    sessionObj.startingPoints = persisted.startingPoints;
    sessionObj.startingPos = persisted.startingPos;
    sessionObj.wins = persisted.wins || 0;
    sessionObj.losses = persisted.losses || 0;
    sessionObj.windowKey = persisted.windowKey;
    
    console.log(`[INFO] Restored squadron session: ${persisted.wins || 0}W/${persisted.losses || 0}L, ${persisted.startingPoints ?? 'n/a'} pts`);
    return { restored: true, reason: 'ok' };
  } catch (e) {
    console.error('[ERROR] Failed to restore squadron session:', e.message);
    return { restored: false, reason: 'error', error: e.message };
  }
}

/**
 * Get squadron session statistics
 * @returns {Object} Session statistics
 */
function getSquadronSessionStats() {
  const session = loadSquadronSession();
  
  if (!session) {
    return {
      hasSession: false,
      wins: 0,
      losses: 0,
      startingPoints: null,
      windowKey: null,
    };
  }
  
  return {
    hasSession: true,
    wins: session.wins || 0,
    losses: session.losses || 0,
    startingPoints: session.startingPoints,
    startingPos: session.startingPos,
    windowKey: session.windowKey,
    dateKey: session.dateKey,
    startedAt: session.startedAt,
  };
}

module.exports = {
  loadSquadronSession,
  saveSquadronSession,
  clearSquadronSession,
  restoreSquadronSession,
  getSquadronSessionStats,
};
