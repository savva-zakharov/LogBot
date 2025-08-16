// src/missionEnd.js
// Centralized mission end processing used by both the web server API and the scraper.
// Responsibilities:
// - Resolve target game index
// - Record result in state
// - Return a small payload that callers can broadcast over WS

const state = require('./state');
const discord = require('./discordBot');

/**
 * Process mission outcome.
 * @param {'win'|'loss'} type - Mission result mapped to win/loss.
 * @param {number|string|null} game - Numeric game index, or 'current'/'all'/null to target current game.
 * @returns {{ ok: boolean, game: number, type: 'win'|'loss' }}
 */
function processMissionEnd(type, game) {
  if (!['win', 'loss'].includes(type)) {
    throw new Error('type must be win or loss');
  }
  let targetGame = game;
  if (targetGame == null || targetGame === 'current' || targetGame === 'all') {
    targetGame = state.getCurrentGame();
  }
  const numericGame = parseInt(targetGame, 10);
  const result = state.recordResult(numericGame, type);
  // Do not auto-post to Discord on result record. Posting is now manual via /api/post-logs.
  return { ok: true, game: numericGame, type, result };
}

/**
 * Post logs (game summary) to Discord for a given game.
 * @param {number|string|null} game - Numeric game index or null/current.
 * @returns {{ ok: boolean, game: number }}
 */
function postLogs(game) {
  // Post/edit the merged summary instead of per-game summaries
  try { discord.postMergedSummary(); } catch (_) {}
  // Retain response shape for compatibility; report current game for UI context
  const numericGame = parseInt((game == null || game === 'current' || game === 'all') ? state.getCurrentGame() : game, 10);
  return { ok: true, game: numericGame };
}

module.exports = { processMissionEnd, postLogs };
