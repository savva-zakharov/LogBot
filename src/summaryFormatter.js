// src/summaryFormatter.js
// Builds the merged summary lines and meta once, to be used by both Discord and Web UI

const state = require('./state');
const { loadSettings, OUTPUT_ORDER } = require('./config');

function isExcludedSquad(sqName, settings) {
  try {
    const h = (settings.squadrons || {})[sqName];
    return !!(h && typeof h === 'object' && h.exclude === true);
  } catch (_) { return false; }
}

function buildMergedSummary() {
  const settings = loadSettings();

  // Meta from current game
  let meta = { squadNo: '', gc: '', ac: '' };
  try {
    const current = state.getCurrentGame && state.getCurrentGame();
    meta = state.getGameMeta(current) || meta;
  } catch (_) {}

  // Group per-game totals
  const grouped = new Map(); // game -> { totals, squads }
  const all = state.getSquadronSummaries ? (state.getSquadronSummaries(null) || []) : [];
  for (const item of all) {
    if (!item || !item.counts || item.game == null) continue;
    const game = Number(item.game);
    const sq = item.squadron;
    if (!sq || isExcludedSquad(sq, settings)) continue;
    if (!grouped.has(game)) {
      const totals = {}; OUTPUT_ORDER.forEach(k => { totals[k] = 0; });
      grouped.set(game, { totals, squads: new Set() });
    }
    const g = grouped.get(game);
    g.squads.add(sq);
    OUTPUT_ORDER.forEach(label => {
      g.totals[label] = (g.totals[label] || 0) + (item.counts[label] || 0);
    });
  }

  // Compute W/L totals and per-game indicators
  let winTotal = 0, lossTotal = 0;
  const resultsMap = state.getResultsMap ? state.getResultsMap() : {};
  try {
    Object.keys(resultsMap || {}).forEach(k => {
      if (resultsMap[k] === true) winTotal++; else if (resultsMap[k] === false) lossTotal++;
    });
  } catch (_) {}

  const games = Array.from(grouped.keys()).sort((a,b) => a - b);
  const lines = [];
  for (const gm of games) {
    const g = grouped.get(gm);
    const sqName = (g.squads.size <= 1) ? (Array.from(g.squads)[0] || '') : 'MULT.';
    const parts = OUTPUT_ORDER.map(label => `${g.totals[label] || 0} ${label}`);
    const namePad = String(sqName).replace(/[^A-Za-z0-9]/g,'').padEnd(6,' ').slice(0,6);
    let indicator = '';
    try {
      const v = resultsMap[String(gm)];
      indicator = (String(v) === 'true' || v === true) ? 'W' : ((String(v) === 'false' || v === false) ? 'L' : '');
    } catch (_) {}
    const line = `${namePad} | ${parts.join(' | ')} | ${indicator ? (indicator + ' | ') : ''}${winTotal}/${lossTotal} |`;
    lines.push(line);
  }

  return { meta: { squadNo: meta.squadNo || '', ac: meta.ac || '', gc: meta.gc || '' }, lines };
}

module.exports = { buildMergedSummary };
