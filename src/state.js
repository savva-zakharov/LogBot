// src/state.js
const fs = require('fs');
const path = require('path');
const { classifyVehicleLenient } = require('./classifier');
const { OUTPUT_ORDER, CATEGORY_TO_OUTPUT } = require('./config');

// Writable base directory for runtime files
const WRITE_BASE_DIR = process.env.LOGBOT_DATA_DIR || process.cwd();
try { fs.mkdirSync(WRITE_BASE_DIR, { recursive: true }); } catch (_) {}

// Reset in-memory data and file while preserving telemetry cursors
function resetData() {
  try {
    const preservedTelemetry = { lastEvtId: state.telemetry.lastEvtId || 0, lastDmgId: state.telemetry.lastDmgId || 0 };
    // Build fresh structure
    const initialData = {
      _gameState: { currentGame: 0, lastGameIncrementTime: 0 },
      _telemetry: { lastEvtId: preservedTelemetry.lastEvtId, lastDmgId: preservedTelemetry.lastDmgId },
      _meta: {}
    };
    state.data = initialData;
    state.currentGame = 0;
    state.lastGameIncrementTime = 0;
    state.telemetry = { ...preservedTelemetry };
    // Persist
    fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(state.data, null, 2), 'utf8');
    console.log('🧹 State reset: cleared games/results/meta, preserved telemetry cursors');
    return { ok: true, currentGame: state.currentGame, telemetry: { ...state.telemetry } };
  } catch (e) {
    console.error('Failed to reset state:', e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function getResultsMap() {
  try {
    const m = state.data._results || {};
    // Return a shallow copy to avoid external mutation
    return Object.assign({}, m);
  } catch (_) { return {}; }
}

// Build merged summary lines across ALL games, grouped by squadron.
// Returns array of objects: { squadron, line, counts, win, loss }
function getMergedSquadronSummaryLines() {
  const results = [];
  try {
    const games = getGamesList();
    // Aggregate per-squadron counts across all games
    const agg = new Map(); // squadron -> { counts }
    for (const gid of games) {
      const perGame = getSquadronSummaries(gid) || [];
      for (const row of perGame) {
        const key = row.squadron;
        if (!agg.has(key)) {
          const init = {};
          OUTPUT_ORDER.forEach(label => { init[label] = 0; });
          agg.set(key, { counts: init });
        }
        const ref = agg.get(key);
        for (const label of OUTPUT_ORDER) {
          ref.counts[label] = (ref.counts[label] || 0) + (row.counts[label] || 0);
        }
      }
    }
    // Compute overall W/L across all games
    let winTotal = 0, lossTotal = 0;
    try {
      const resultsMap = state.data._results || {};
      Object.keys(resultsMap).forEach(k => {
        if (resultsMap[k] === true) winTotal++;
        else if (resultsMap[k] === false) lossTotal++;
      });
    } catch (_) {}

    // Build lines for each squadron
    for (const [squadron, data] of agg.entries()) {
      const cleaned = String(squadron || '').replace(/[^A-Za-z0-9]/g, '') || '';
      const fixedName = cleaned.padEnd(8, ' ').slice(0, 8);
      const parts = OUTPUT_ORDER.map(label => String(data.counts[label] || 0).padStart(3, ' '));
      const line = `${fixedName} | ${parts.join(' | ')} | ${winTotal}/${lossTotal} |`;
      results.push({ squadron: cleaned, line, counts: data.counts, win: winTotal, loss: lossTotal });
    }

    results.sort((a, b) => a.squadron.localeCompare(b.squadron));
  } catch (e) {
    console.warn('Merged summary build failed:', e && e.message ? e.message : e);
  }
  return results;
}
const JSON_FILE_PATH = path.join(WRITE_BASE_DIR, 'parsed_data.json');

let state = {
  currentGame: 0,
  lastGameIncrementTime: 0,
  vehicleToCategory: {}, // Loaded from classifier
  vehicleClassifications: {}, // Loaded from classifier
  data: {}, // In-memory representation of parsed_data.json
  telemetry: { lastEvtId: 0, lastDmgId: 0 },
};

function loadAndPrepareInitialState() {
  // If existing file is fresh (<= 1 hour), load and continue; else rotate and create new
  const ONE_HOUR_MS = 60 * 60 * 1000;
  let loaded = false;
  try {
    if (fs.existsSync(JSON_FILE_PATH)) {
      const stat = fs.statSync(JSON_FILE_PATH);
      const age = Date.now() - stat.mtimeMs;
      if (age <= ONE_HOUR_MS) {
        // Load
        const txt = fs.readFileSync(JSON_FILE_PATH, 'utf8');
        const obj = JSON.parse(txt || '{}');
        state.data = obj || {};
        state.currentGame = obj?._gameState?.currentGame || 0;
        state.lastGameIncrementTime = obj?._gameState?.lastGameIncrementTime || 0;
        state.telemetry.lastEvtId = obj?._telemetry?.lastEvtId || 0;
        state.telemetry.lastDmgId = obj?._telemetry?.lastDmgId || 0;
        console.log('💾 Loaded existing parsed_data.json (<=1h old). Resuming session.');
        loaded = true;
      } else {
        // Rotate
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveDir = path.join(WRITE_BASE_DIR, 'old_logs');
        try { fs.mkdirSync(archiveDir, { recursive: true }); } catch (_) {}
        const backupName = `parsed_data_${timestamp}.json`;
        const backupPath = path.join(archiveDir, backupName);
        fs.renameSync(JSON_FILE_PATH, backupPath);
        console.log(`💾 Previous JSON moved to old_logs: ${path.basename(backupPath)}`);
      }
    }
  } catch (error) {
    console.warn('⚠️ Could not process existing JSON, resetting:', error.message);
    try { fs.unlinkSync(JSON_FILE_PATH); } catch (_) {}
  }

  if (!loaded) {
    // Create a fresh file with a reset state
    const initialData = {
      _gameState: {
        currentGame: 0,
        lastGameIncrementTime: 0
      },
      _telemetry: {
        lastEvtId: 0,
        lastDmgId: 0,
      },
      _meta: {}
    };
    fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(initialData, null, 2), 'utf8');
    state.data = initialData;
    state.currentGame = 0;
    state.lastGameIncrementTime = 0;
    state.telemetry = { lastEvtId: 0, lastDmgId: 0 };
    console.log('🔄 JSON file reset - starting fresh session');
  }
}

function persistState() {
  try {
    state.data._gameState = {
      currentGame: state.currentGame,
      lastGameIncrementTime: state.lastGameIncrementTime,
    };
    state.data._telemetry = {
      lastEvtId: state.telemetry.lastEvtId || 0,
      lastDmgId: state.telemetry.lastDmgId || 0,
    };
    fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(state.data, null, 2), 'utf8');
  } catch (error) {
    console.error('❌ Error persisting state to JSON:', error);
  }
}

function setVehicleClassifications(v2c, cats) {
    state.vehicleToCategory = v2c || {};
    state.vehicleClassifications = cats || {};
}

function getCurrentGame() {
  return state.currentGame;
}

function incrementGame() {
  state.currentGame++;
  state.lastGameIncrementTime = Date.now();
  // Copy per-game metadata forward from previous game if not set yet
  try {
    const toKey = String(state.currentGame);
    const fromKey = String(Math.max(0, state.currentGame - 1));
    state.data._meta = state.data._meta || {};
    if (state.data._meta[fromKey] && !state.data._meta[toKey]) {
      state.data._meta[toKey] = { ...state.data._meta[fromKey] };
    }
  } catch (_) {}
  persistState();
  console.log(`🎮 Game incremented to ${state.currentGame}`);
  return true;
  
}

function recordEntry(entry) {
  const { game, squadron, player, vehicle, status, gotKill } = entry;
  const gameKey = String(game);

  try {
    if (!state.data[gameKey]) state.data[gameKey] = {};
    if (!state.data[gameKey][squadron]) state.data[gameKey][squadron] = {};
    if (!state.data[gameKey][squadron][player]) state.data[gameKey][squadron][player] = {};

    let created = false;
    if (!state.data[gameKey][squadron][player][vehicle]) {
      state.data[gameKey][squadron][player][vehicle] = {
        status: 'active',
        firstSeen: new Date().toISOString(),
        kills: 0,
        classification: classifyVehicleLenient(vehicle, state.vehicleToCategory, { minScore: 4 })
      };
      console.log(`💾 New unique entry saved - Game: ${game}, Squadron: ${squadron}, Player: ${player}, Vehicle: ${vehicle}`);
      created = true;
    }

    const vehicleRef = state.data[gameKey][squadron][player][vehicle];
    if (!vehicleRef.classification) {
        vehicleRef.classification = classifyVehicleLenient(vehicle, state.vehicleToCategory, { minScore: 4 });
    }
    let statusChanged = false;
    let killsChanged = false;
    if (status === 'destroyed' && vehicleRef.status !== 'destroyed') {
        vehicleRef.status = 'destroyed';
        vehicleRef.destroyedAt = new Date().toISOString();
        console.log(`💥 Vehicle destroyed - Game: ${game}, Squadron: ${squadron}, Player: ${player}, Vehicle: ${vehicle}`);
        statusChanged = true;
    }
    // Increment kills if provided by parser (entity appeared BEFORE kill keywords)
    if (gotKill === true) {
        const before = vehicleRef.kills || 0;
        vehicleRef.kills = before + 1;
        if (vehicleRef.kills !== before) {
            killsChanged = true;
            console.log(`🔫 Kill recorded - Game: ${game}, Squadron: ${squadron}, Player: ${player}, Vehicle: ${vehicle}, Total Kills: ${vehicleRef.kills}`);
        }
    }

    if (created || statusChanged || killsChanged) {
      persistState();
      return vehicleRef;
    }
    // No material change; avoid duplicate notifications
    return null;
  } catch (error) {
    console.error(`❌ Error recording entry:`, error);
  }
}

function recordResult(gameId, resultType) {
    const gid = String(gameId);
    if (!state.data._results) state.data._results = {};
    state.data._results[gid] = (resultType === 'win');
    persistState();
    console.log(`🏁 Result set: Game ${gid} -> ${resultType.toUpperCase()}`);
    return { game: gameId, result: state.data._results[gid] };
}

// --- Data Query Functions ---

function getGamesList() {
    return Object.keys(state.data)
        .filter(k => k !== '_gameState' && k !== '_results' && /^\d+$/.test(k))
        .map(k => parseInt(k, 10))
        .sort((a,b) => a - b);
}

function getActiveVehicles(targetGameId) {
    const gameIdNum = (targetGameId === null || targetGameId === undefined) ? state.currentGame : parseInt(targetGameId, 10);
    const gameId = String(gameIdNum);
    const allVehicles = [];
    if (state.data[gameId]) {
        Object.keys(state.data[gameId]).forEach(squadron => {
            Object.keys(state.data[gameId][squadron]).forEach(player => {
                Object.keys(state.data[gameId][squadron][player]).forEach(vehicle => {
                    const vehicleData = state.data[gameId][squadron][player][vehicle];
                    allVehicles.push({
                        game: gameId,
                        squadron,
                        player,
                        vehicle,
                        status: vehicleData.status,
                        classification: (vehicleData.classification || classifyVehicleLenient(vehicle, state.vehicleToCategory, { minScore: 4 })),
                        firstSeen: vehicleData.firstSeen,
                        destroyedAt: vehicleData.destroyedAt || null,
                        kills: vehicleData.kills || 0
                    });
                });
            });
        });
    }
    return allVehicles;
}

function getSquadronSummaries(targetGameId = null) {
    const gameIds = (targetGameId === null || targetGameId === undefined)
        ? getGamesList()
        : [String(parseInt(targetGameId, 10))];

    const results = [];
    gameIds.forEach(gameId => {
        const gameBlock = state.data[String(gameId)];
        if (!gameBlock) return;

        const squadronTotals = new Map();
        Object.keys(gameBlock).forEach(squadron => {
            if (!squadronTotals.has(squadron)) {
                const init = {};
                OUTPUT_ORDER.forEach(label => { init[label] = 0; });
                squadronTotals.set(squadron, init);
            }
            const acc = squadronTotals.get(squadron);
            Object.keys(gameBlock[squadron]).forEach(player => {
                Object.keys(gameBlock[squadron][player]).forEach(vehicle => {
                    const vehicleData = gameBlock[squadron][player][vehicle] || {};
                    const cat = vehicleData.classification || classifyVehicleLenient(vehicle, state.vehicleToCategory, { minScore: 4 });
                    const label = CATEGORY_TO_OUTPUT[cat];
                    if (label) acc[label] = (acc[label] || 0) + 1;
                });
            });
        });
        
        const gameResults = state.data._results || {};

        squadronTotals.forEach((counts, squadron) => {
            const cleaned = String(squadron).replace(/[^A-Za-z0-9]/g, '');
            const fixedName = cleaned.padEnd(6, ' ').slice(0, 6);
            const parts = OUTPUT_ORDER.map(label => `${counts[label] || 0} ${label}`);
            
            let indicator = '';
            let cum = { win: 0, loss: 0 };
            Object.keys(gameResults)
                .filter(k => /^\d+$/.test(k) && parseInt(k, 10) <= gameId)
                .forEach(k => {
                    if (gameResults[k] === true) cum.win++;
                    else if (gameResults[k] === false) cum.loss++;
                    if (k === String(gameId)) indicator = gameResults[k] ? 'W' : 'L';
                });
            
            const line = `${fixedName} | ${parts.join(' | ')} | ${indicator ? (indicator + ' | ') : ''}${cum.win}/${cum.loss} |`;
            results.push({ game: parseInt(gameId, 10), squadron: cleaned, line, counts });
        });
    });

    results.sort((a, b) => (a.game - b.game) || a.squadron.localeCompare(b.squadron));
    return results;
}

// --- Telemetry cursor helpers ---
function getTelemetryCursors() {
  return { lastEvtId: state.telemetry.lastEvtId || 0, lastDmgId: state.telemetry.lastDmgId || 0 };
}

function setTelemetryCursors({ lastEvtId, lastDmgId }) {
  if (typeof lastEvtId === 'number' && lastEvtId >= 0) state.telemetry.lastEvtId = lastEvtId;
  if (typeof lastDmgId === 'number' && lastDmgId >= 0) state.telemetry.lastDmgId = lastDmgId;
  persistState();
}

 

// --- Per-game metadata (Squad No, GC, AC) ---
function getGameMeta(gameId) {
  try {
    const k = String(parseInt(gameId, 10));
    const meta = (state.data._meta && state.data._meta[k]) || null;
    if (!meta) return { squadNo: '', gc: '', ac: '' };
    return {
      squadNo: String(meta.squadNo || ''),
      gc: String(meta.gc || ''),
      ac: String(meta.ac || ''),
    };
  } catch (_) { return { squadNo: '', gc: '', ac: '' }; }
}

function setGameMeta(gameId, { squadNo, gc, ac }) {
  try {
    const k = String(parseInt(gameId, 10));
    if (!state.data._meta) state.data._meta = {};
    const prev = state.data._meta[k] || {};
    state.data._meta[k] = {
      squadNo: (squadNo != null ? String(squadNo) : prev.squadNo || ''),
      gc: (gc != null ? String(gc) : prev.gc || ''),
      ac: (ac != null ? String(ac) : prev.ac || ''),
    };
    persistState();
    return state.data._meta[k];
  } catch (e) {
    console.error('Failed to set game meta:', e);
    return null;
  }
}


module.exports = {
  loadAndPrepareInitialState,
  setVehicleClassifications,
  getCurrentGame,
  incrementGame,
  recordEntry,
  recordResult,
  getGamesList,
  getActiveVehicles,
  getSquadronSummaries,
  getResultsMap,
  getMergedSquadronSummaryLines,
  getTelemetryCursors,
  setTelemetryCursors,
  getGameMeta,
  setGameMeta,
  resetData,
};
