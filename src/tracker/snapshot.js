// src/tracker/snapshot.js
const fs = require('fs');
const path = require('path');
const { logError, dateKeyUTC } = require('./utils');
const { ensureLogsDir } = require('./utils');

const DATA_FILE = 'squadron_data.json';

function getDataFilePath() {
  return path.join(process.cwd(), DATA_FILE);
}

// Remove noisy columns from rows and headers
function pruneSnapshot(snapshot) {
  const dropCols = new Set(['num.', 'Activity']);
  const safe = JSON.parse(JSON.stringify(snapshot || {}));
  if (safe && safe.data) {
    if (Array.isArray(safe.data.headers)) {
      safe.data.headers = safe.data.headers.filter(h => !dropCols.has(h));
    }
    if (Array.isArray(safe.data.rows)) {
      safe.data.rows = safe.data.rows.map(r => {
        const obj = {};
        Object.keys(r || {}).forEach(k => {
          if (!dropCols.has(k)) obj[k] = r[k];
        });
        return obj;
      });
    }
  }
  return safe;
}

// Determine if a snapshot has useful signal to persist
function snapshotHasSignal(snap) {
  try {
    const rows = snap && snap.data && Array.isArray(snap.data.rows) ? snap.data.rows : [];
    const headers = snap && snap.data && Array.isArray(snap.data.headers) ? snap.data.headers : [];
    const total = snap && typeof snap.totalPoints === 'number' ? snap.totalPoints : null;
    if (rows.length > 0) return true;
    if (headers.length > 0 && rows.length > 0) return true;
    if (Number.isFinite(total)) return true;
  } catch (e) {
    logError('snapshotHasSignal', e);
  }
  return false;
}

function ensureParsedDataFile() {
  const file = getDataFilePath();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({}, null, 2), 'utf8');
  } else {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        fs.writeFileSync(file, JSON.stringify({}, null, 2), 'utf8');
      }
    } catch (e) {
      logError('ensureParsedDataFile', e);
      fs.writeFileSync(file, JSON.stringify({}, null, 2), 'utf8');
    }
  }
  return file;
}

function readLastSnapshot(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Legacy array support
    if (obj && Array.isArray(obj.squadronSnapshots)) {
      return obj.squadronSnapshots.length ? obj.squadronSnapshots[obj.squadronSnapshots.length - 1] : null;
    }
    // New single snapshot
    return obj && typeof obj === 'object' && Object.keys(obj).length ? obj : null;
  } catch (e) {
    logError('readLastSnapshot', e);
    return null;
  }
}

function appendSnapshot(file, snapshot) {
  try {
    const pruned = pruneSnapshot(snapshot);
    if (!snapshotHasSignal(pruned)) {
      console.warn('⚠️ Skipping snapshot write: no useful data (empty rows and no totalPoints).');
      return;
    }
    fs.writeFileSync(file, JSON.stringify(pruned, null, 2), 'utf8');
  } catch (e) {
    logError('appendSnapshot', e);
    try {
      const pruned = pruneSnapshot(snapshot);
      if (!snapshotHasSignal(pruned)) {
        console.warn('⚠️ Skipping snapshot write (retry path): no useful data.');
        return;
      }
      fs.writeFileSync(file, JSON.stringify(pruned, null, 2), 'utf8');
    } catch (e2) {
      logError('appendSnapshot.retry', e2);
    }
  }
}

// --- Daily archive of squadron_data.json at UTC midnight ---
function archiveSquadronData(dateKeyOverride = null) {
  try {
    const src = getDataFilePath();
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
    try { fs.copyFileSync(src, dest); } catch (e) {
      logError('archiveSquadronData.copyFileSync', e);
    }
    console.log(`[SEASON] Archived (copied) squadron_data.json to ${dest}`);
  } catch (e) {
    logError('archiveSquadronData', e);
  }
}

function scheduleDailyArchive() {
  let __archiveTimer = null;
  
  function msUntilNextUtcMidnight() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
    return next.getTime() - now.getTime();
  }
  
  function schedule() {
    try { if (__archiveTimer) clearTimeout(__archiveTimer); } catch (e) {
      logError('scheduleDailyArchive.clearTimeout', e);
    }
    const delay = Math.max(1000, msUntilNextUtcMidnight());
    __archiveTimer = setTimeout(() => {
      try { archiveSquadronData(); } catch (e) {
        logError('scheduleDailyArchive.archiveSquadronData', e);
      }
      schedule();
    }, delay);
    console.log(`[SEASON] Daily archive scheduled in ${(delay / 1000 / 60).toFixed(1)} minutes`);
  }
  
  schedule();
}

// Determine the UTC date key of the data inside squadron_data.json.
function getSquadronDataDateKeyOrNull() {
  try {
    const file = getDataFilePath();
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
    } catch (e) {
      logError('getSquadronDataDateKeyOrNull.parse', e);
    }
    // Fallback: file mtime
    try {
      const st = fs.statSync(file);
      const d = st && st.mtime ? new Date(st.mtime) : null;
      if (d && !isNaN(d.getTime())) return dateKeyUTC(d);
    } catch (e) {
      logError('getSquadronDataDateKeyOrNull.stat', e);
    }
  } catch (e) {
    logError('getSquadronDataDateKeyOrNull', e);
  }
  return null;
}

// Archive immediately if the current data file belongs to a previous UTC date.
function archiveIfStale() {
  try {
    const curKey = dateKeyUTC();
    const fileKey = getSquadronDataDateKeyOrNull();
    if (fileKey && fileKey < curKey) {
      archiveSquadronData(fileKey);
    }
  } catch (e) {
    logError('archiveIfStale', e);
  }
}

module.exports = {
  pruneSnapshot,
  snapshotHasSignal,
  ensureParsedDataFile,
  readLastSnapshot,
  appendSnapshot,
  archiveSquadronData,
  scheduleDailyArchive,
  getSquadronDataDateKeyOrNull,
  archiveIfStale,
};
