// src/squadron/snapshotManager.js
// Handles snapshot reading, writing, and archiving for squadron data

const fs = require('fs');
const path = require('path');
const { dateKeyUTC, msUntilNextUtcMidnight } = require('./windowManager');

/**
 * Ensure logs directory exists
 * @returns {string} Path to logs directory
 */
function ensureLogsDir() {
  const dir = path.join(process.cwd(), 'logs');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

/**
 * Ensure parsed data file exists
 * @returns {string} Path to parsed data file
 */
function ensureParsedDataFile() {
  const file = path.join(process.cwd(), 'squadron_data.json');
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, JSON.stringify({ data: { headers: [], rows: [] } }, null, 2), 'utf8'); } catch (_) {}
  }
  return file;
}

/**
 * Read last snapshot from file
 * @param {string} dataFile - Path to data file
 * @returns {Object|null} Last snapshot or null
 */
function readLastSnapshot(dataFile) {
  try {
    if (!fs.existsSync(dataFile)) return null;
    const content = fs.readFileSync(dataFile, 'utf8');
    if (!content) return null;
    const obj = JSON.parse(content);
    // Handle both new format and legacy array format
    if (obj && obj.data) {
      // Include playerSession if present
      if (obj.playerSession) {
        obj.playerSession = {
          windowKey: obj.playerSession.windowKey,
          dateKey: obj.playerSession.dateKey,
          startingPointsByPlayer: new Map(Object.entries(obj.playerSession.startingPointsByPlayer || {})),
          playerJoinTimestamps: new Map(Object.entries(obj.playerSession.playerJoinTimestamps || {})),
          windowResetDone: obj.playerSession.windowResetDone || false,
          lastWritten: obj.playerSession.lastWritten || null,
        };
      }
      return obj;
    }
    if (obj && Array.isArray(obj.squadronSnapshots) && obj.squadronSnapshots.length) {
      return obj.squadronSnapshots[obj.squadronSnapshots.length - 1];
    }
    return obj;
  } catch (_) { return null; }
}

/**
 * Append snapshot to file
 * @param {string} dataFile - Path to data file
 * @param {Object} snapshot - Snapshot to append
 * @param {Object|null} playerSession - Optional player session data to persist
 */
function appendSnapshot(dataFile, snapshot, playerSession = null) {
  try {
    // New format: single snapshot with data
    const obj = {
      ts: snapshot.ts || Date.now(),
      data: snapshot.data || { headers: [], rows: [] },
      totalPoints: snapshot.totalPoints,
      squadronPlace: snapshot.squadronPlace,
      totalPointsAbove: snapshot.totalPointsAbove,
      totalPointsBelow: snapshot.totalPointsBelow,
      membersCaptured: snapshot.membersCaptured,
    };
    if (snapshot.session) {
      obj.session = snapshot.session;
    }
    // Persist player session data alongside snapshot
    if (playerSession) {
      obj.playerSession = {
        windowKey: playerSession.windowKey,
        dateKey: playerSession.dateKey,
        startingPointsByPlayer: Object.fromEntries(playerSession.startingPointsByPlayer),
        playerJoinTimestamps: Object.fromEntries(playerSession.playerJoinTimestamps),
        windowResetDone: playerSession.windowResetDone,
        // Add timestamp for when this data was written
        lastWritten: Date.now(),
      };
    }
    fs.writeFileSync(dataFile, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[WARN] Failed to append snapshot: ${e.message}`);
  }
}

/**
 * Prune snapshot for comparison (remove noisy fields)
 * @param {Object} snapshot - Snapshot to prune
 * @returns {Object} Pruned snapshot
 */
function pruneSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    totalPoints: snapshot.totalPoints,
    squadronPlace: snapshot.squadronPlace,
    headers: snapshot.data?.headers || [],
    rowCount: snapshot.data?.rows?.length || 0,
  };
}

/**
 * Simplify snapshot for comparison
 * @param {Object} snapshot - Snapshot to simplify
 * @returns {Object} Simplified snapshot
 */
function simplifyForComparison(snapshot) {
  if (!snapshot) return null;
  return {
    totalPoints: snapshot.totalPoints,
    squadronPlace: snapshot.squadronPlace,
    membersCaptured: snapshot.membersCaptured,
    rowCount: snapshot.data?.rows?.length || 0,
  };
}

/**
 * Archive squadron data at UTC midnight
 * @param {string|null} dateKeyOverride - Override date key
 */
function archiveSquadronData(dateKeyOverride = null) {
  try {
    const src = path.join(process.cwd(), 'squadron_data.json');
    if (!fs.existsSync(src)) return;
    
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

/**
 * Schedule daily archive at UTC midnight
 */
function scheduleDailyArchive() {
  let __archiveTimer = null;
  
  function schedule() {
    try { if (__archiveTimer) clearTimeout(__archiveTimer); } catch (_) {}
    const delay = Math.max(1000, msUntilNextUtcMidnight());
    __archiveTimer = setTimeout(() => {
      try { archiveSquadronData(); } catch (_) {}
      // Re-schedule for the next midnight
      schedule();
    }, delay);
    console.log(`[SEASON] Daily archive scheduled in ${(delay / 1000 / 60).toFixed(1)} minutes`);
  }
  
  schedule();
}

/**
 * Get date key from squadron data file
 * @returns {string|null} Date key or null
 */
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

/**
 * Archive if data is stale (from previous UTC date)
 */
function archiveIfStale() {
  try {
    const curKey = dateKeyUTC();
    const fileKey = getSquadronDataDateKeyOrNull();
    if (fileKey && fileKey < curKey) {
      archiveSquadronData(fileKey);
    }
  } catch (_) {}
}

/**
 * Merge PointsStart from previous rows to new rows
 * @param {Array} newRows - New rows
 * @param {Array} prevRows - Previous rows
 */
function mergePointsStart(newRows, prevRows) {
  if (!Array.isArray(newRows)) return;
  const pointsStartMap = new Map();
  if (Array.isArray(prevRows)) {
    prevRows.forEach(r => {
      const name = String(r['Player'] || r['player'] || '').trim();
      if (name && r['PointsStart'] !== undefined) pointsStartMap.set(name, r['PointsStart']);
    });
  }

  newRows.forEach(r => {
    const name = String(r['Player'] || r['player'] || '').trim();
    if (name) {
      if (pointsStartMap.has(name)) {
        r['PointsStart'] = pointsStartMap.get(name);
      } else {
        // New player, default PointsStart to current Points
        r['PointsStart'] = r['Points'] || r['points'] || '0';
      }
    }
  });
}

/**
 * Reset leaderboard pointsStart and posStart
 */
async function resetLeaderboardPointsStart() {
  try {
    const leaderboardFile = path.join(process.cwd(), 'leaderboard.json');
    if (fs.existsSync(leaderboardFile)) {
      const leaderboardData = JSON.parse(fs.readFileSync(leaderboardFile, 'utf8'));
      if (leaderboardData && Array.isArray(leaderboardData.squadrons)) {
        leaderboardData.squadrons.forEach(squadron => {
          squadron.pointsStart = squadron.points;
          squadron.posStart = squadron.pos;
        });
        fs.writeFileSync(leaderboardFile, JSON.stringify(leaderboardData, null, 2), 'utf8');
        console.log('[INFO] Leaderboard pointsStart and posStart have been reset.');
      }
    }
  } catch (e) {
    console.warn(`[WARN] Failed to reset leaderboard pointsStart: ${e.message}`);
  }
}

/**
 * Reset player PointsStart in squadron data
 * @param {boolean} windowResetDone - Whether reset is already done for window
 * @param {Object} playerSession - Player session object
 * @param {Object} session - Squadron session object
 * @returns {Promise<void>}
 */
async function resetPlayerPointsStart(windowResetDone, playerSession, session) {
  try {
    const dataFile = ensureParsedDataFile();
    const snapshot = readLastSnapshot(dataFile);
    if (!snapshot || !snapshot.data || !Array.isArray(snapshot.data.rows)) {
      console.warn('[WARN] No valid snapshot data to reset player PointsStart');
      return;
    }

    const rows = snapshot.data.rows;
    const now = new Date();
    const timestamp = now.getTime();

    // Only reset if we haven't already reset for this window
    if (windowResetDone) {
      console.log('[INFO] Player PointsStart already reset for this window, skipping');
      return;
    }

    // Track player join timestamps
    if (playerSession.windowKey && playerSession.windowKey === session.windowKey) {
      rows.forEach(row => {
        const playerName = String(row['Player'] || row['player'] || '').trim();
        if (playerName) {
          if (!playerSession.playerJoinTimestamps.has(playerName)) {
            playerSession.playerJoinTimestamps.set(playerName, timestamp);
          }
        }
      });
    }

    // Update the PointsStart values for each player
    let updated = false;
    rows.forEach(row => {
      const playerName = String(row['Player'] || row['player'] || '').trim();
      if (playerName) {
        const currentPoints = parseInt(String(row['Points'] || row['points'] || '0').replace(/[^0-9]/g, ''), 10) || 0;
        if (row['PointsStart'] === undefined || row['PointsStart'] === null || row['PointsStart'] === '0') {
          row['PointsStart'] = currentPoints;
          updated = true;
        }
      }
    });

    if (updated) {
      console.log('[INFO] Player PointsStart has been updated in squadron_data.json.');
      // Save snapshot with updated player session data
      appendSnapshot(dataFile, snapshot, playerSession);
      console.log('[INFO] Player session persisted to disk');
    } else {
      console.log('[INFO] No player PointsStart updates needed.');
      // Still persist player session even if no updates (for windowResetDone flag)
      appendSnapshot(dataFile, snapshot, playerSession);
    }
    
    // Mark that we've completed the window reset
    if (playerSession.windowKey === session.windowKey) {
      playerSession.windowResetDone = true;
      // Save again to persist the windowResetDone flag
      appendSnapshot(dataFile, snapshot, playerSession);
    }
  } catch (e) {
    console.warn(`[WARN] Failed to reset player PointsStart: ${e.message}`);
  }
}

module.exports = {
  ensureLogsDir,
  ensureParsedDataFile,
  readLastSnapshot,
  appendSnapshot,
  pruneSnapshot,
  simplifyForComparison,
  archiveSquadronData,
  scheduleDailyArchive,
  getSquadronDataDateKeyOrNull,
  archiveIfStale,
  mergePointsStart,
  resetLeaderboardPointsStart,
  resetPlayerPointsStart,
};
