// src/squadron/playerSessionStore.js
// Handles persistent storage of player session data in squadron_data.json

const fs = require('fs');
const path = require('path');
const { ensureParsedDataFile, readLastSnapshot, appendSnapshot } = require('./snapshotManager');

/**
 * Load player session from persistent storage
 * @returns {Object|null} Player session object or null if not found
 */
function loadPlayerSession() {
  try {
    const dataFile = ensureParsedDataFile();
    const snapshot = readLastSnapshot(dataFile);
    if (snapshot && snapshot.playerSession) {
      return {
        windowKey: snapshot.playerSession.windowKey,
        dateKey: snapshot.playerSession.dateKey,
        startingPointsByPlayer: snapshot.playerSession.startingPointsByPlayer,
        playerJoinTimestamps: snapshot.playerSession.playerJoinTimestamps,
        windowResetDone: snapshot.playerSession.windowResetDone || false,
      };
    }
  } catch (e) {
    console.warn('[WARN] Failed to load player session:', e.message);
  }
  return null;
}

/**
 * Save player session to persistent storage
 * @param {Object} playerSession - Player session object to save
 * @returns {boolean} True if saved successfully
 */
function savePlayerSession(playerSession) {
  try {
    if (!playerSession) {
      console.warn('[WARN] No player session to save');
      return false;
    }

    const dataFile = ensureParsedDataFile();
    const snapshot = readLastSnapshot(dataFile);
    
    if (!snapshot) {
      console.warn('[WARN] No snapshot found to attach player session');
      return false;
    }

    // Append snapshot with player session data
    appendSnapshot(dataFile, snapshot, playerSession);
    return true;
  } catch (e) {
    console.error('[ERROR] Failed to save player session:', e.message);
    return false;
  }
}

/**
 * Get player starting points from persistent storage
 * @param {string} windowKey - Window key
 * @param {string} playerName - Player name
 * @returns {number|null} Starting points or null
 */
function getPlayerStartingPoints(windowKey, playerName) {
  try {
    const session = loadPlayerSession();
    if (!session || session.windowKey !== windowKey) {
      return null;
    }
    if (session.startingPointsByPlayer && session.startingPointsByPlayer.has(playerName)) {
      return session.startingPointsByPlayer.get(playerName);
    }
  } catch (e) {
    console.warn('[WARN] Failed to get player starting points:', e.message);
  }
  return null;
}

/**
 * Set player starting points in persistent storage
 * @param {string} windowKey - Window key
 * @param {string} playerName - Player name
 * @param {number} points - Starting points
 * @param {number} timestamp - Join timestamp
 * @returns {boolean} True if saved successfully
 */
function setPlayerStartingPoints(windowKey, playerName, points, timestamp) {
  try {
    const session = loadPlayerSession() || {
      windowKey,
      dateKey: windowKey.split('|')[0],
      startingPointsByPlayer: new Map(),
      playerJoinTimestamps: new Map(),
      windowResetDone: false,
    };

    // Only update if window matches
    if (session.windowKey !== windowKey) {
      console.warn('[WARN] Window key mismatch, not updating player starting points');
      return false;
    }

    session.startingPointsByPlayer.set(playerName, points);
    if (timestamp && !session.playerJoinTimestamps.has(playerName)) {
      session.playerJoinTimestamps.set(playerName, timestamp);
    }

    return savePlayerSession(session);
  } catch (e) {
    console.error('[ERROR] Failed to set player starting points:', e.message);
    return false;
  }
}

/**
 * Clear player session from persistent storage
 * @param {string|null} windowKey - Optional window key to clear (clears all if null)
 * @returns {boolean} True if cleared successfully
 */
function clearPlayerSession(windowKey = null) {
  try {
    const dataFile = ensureParsedDataFile();
    const snapshot = readLastSnapshot(dataFile);
    
    if (!snapshot) {
      return true; // Nothing to clear
    }

    // Clear player session data
    if (windowKey) {
      // Only clear if window matches
      if (snapshot.playerSession && snapshot.playerSession.windowKey === windowKey) {
        snapshot.playerSession = null;
      }
    } else {
      // Clear all
      snapshot.playerSession = null;
    }

    // Re-save without player session
    appendSnapshot(dataFile, snapshot, null);
    return true;
  } catch (e) {
    console.error('[ERROR] Failed to clear player session:', e.message);
    return false;
  }
}

/**
 * Restore player session to in-memory state
 * @param {Object} playerSessionObj - In-memory player session object to restore
 * @returns {boolean} True if restored successfully
 */
function restorePlayerSession(playerSessionObj) {
  try {
    const persisted = loadPlayerSession();
    if (!persisted) {
      return false;
    }

    // Copy persisted data to in-memory object
    playerSessionObj.windowKey = persisted.windowKey;
    playerSessionObj.dateKey = persisted.dateKey;
    playerSessionObj.startingPointsByPlayer = new Map(persisted.startingPointsByPlayer);
    playerSessionObj.playerJoinTimestamps = new Map(persisted.playerJoinTimestamps);
    playerSessionObj.windowResetDone = persisted.windowResetDone;

    console.log(`[INFO] Restored player session for window ${persisted.windowKey} with ${persisted.startingPointsByPlayer.size} players`);
    return true;
  } catch (e) {
    console.error('[ERROR] Failed to restore player session:', e.message);
    return false;
  }
}

/**
 * Get player session statistics
 * @returns {Object} Session statistics
 */
function getSessionStats() {
  try {
    const session = loadPlayerSession();
    if (!session) {
      return {
        hasSession: false,
        windowKey: null,
        playerCount: 0,
        windowResetDone: false,
      };
    }

    return {
      hasSession: true,
      windowKey: session.windowKey,
      dateKey: session.dateKey,
      playerCount: session.startingPointsByPlayer ? session.startingPointsByPlayer.size : 0,
      windowResetDone: session.windowResetDone,
    };
  } catch (e) {
    console.warn('[WARN] Failed to get session stats:', e.message);
    return {
      hasSession: false,
      windowKey: null,
      playerCount: 0,
      windowResetDone: false,
    };
  }
}

/**
 * Validate player session data
 * @param {Object} playerSession - Player session to validate
 * @returns {Object} Validation result
 */
function validatePlayerSession(playerSession) {
  const issues = [];
  
  if (!playerSession) {
    issues.push('Player session is null/undefined');
    return { valid: false, issues };
  }

  if (!playerSession.windowKey) {
    issues.push('Missing windowKey');
  }

  if (!playerSession.dateKey) {
    issues.push('Missing dateKey');
  }

  if (!playerSession.startingPointsByPlayer || !(playerSession.startingPointsByPlayer instanceof Map)) {
    issues.push('startingPointsByPlayer is not a Map');
  } else {
    // Validate individual player entries
    for (const [name, points] of playerSession.startingPointsByPlayer.entries()) {
      if (typeof points !== 'number' || points < 0) {
        issues.push(`Invalid points for player ${name}: ${points}`);
      }
      if (points > 10000000) {
        issues.push(`Suspicious points for player ${name}: ${points} (too high)`);
      }
    }
  }

  if (!playerSession.playerJoinTimestamps || !(playerSession.playerJoinTimestamps instanceof Map)) {
    issues.push('playerJoinTimestamps is not a Map');
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

module.exports = {
  loadPlayerSession,
  savePlayerSession,
  getPlayerStartingPoints,
  setPlayerStartingPoints,
  clearPlayerSession,
  restorePlayerSession,
  getSessionStats,
  validatePlayerSession,
};
