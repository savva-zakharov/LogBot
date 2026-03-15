// src/squadron/discordIntegration.js
// Handles Discord bot integration for squadron tracking messages

const { loadSettings } = require('../config');

// Lazy-loaded Discord functions
let __discordSendChecked = false;
let __discordSendFn = null;
let __discordWinLossChecked = false;
let __discordWinLossFn = null;
let __discordWLUpdateChecked = false;
let __discordWLUpdateFn = null;
let __discordWLClearFn = null;

/**
 * Get Discord send function
 * @returns {Function|null} Send function or null
 */
function getDiscordSend() {
  if (!__discordSendChecked) {
    __discordSendChecked = true;
    try {
      const mod = require('../discordBot');
      __discordSendFn = typeof mod.sendMessage === 'function' ? mod.sendMessage : null;
    } catch (_) { __discordSendFn = null; }
  }
  return __discordSendFn;
}

/**
 * Get Discord win/loss send function
 * @returns {Function|null} Win/loss send function or null
 */
function getDiscordWinLossSend() {
  if (!__discordWinLossChecked) {
    __discordWinLossChecked = true;
    try {
      const mod = require('../discordBot');
      // Configure win/loss channel from settings.json if present
      try {
        const s = loadSettings();
        if (s && typeof s.discordWinLossChannell === 'string' && s.discordWinLossChannell.trim()) {
          try { if (typeof mod.setWinLossChannel === 'function') mod.setWinLossChannel(s.discordWinLossChannell); } catch (_) {}
        }
      } catch (_) {}
      __discordWinLossFn = (typeof mod.sendWinLossMessage === 'function') ? mod.sendWinLossMessage : null;
    } catch (_) { __discordWinLossFn = null; }
  }
  return __discordWinLossFn;
}

/**
 * Get Discord win/loss updater functions
 * @returns {Object} Object with updateByKey and clearByKey functions
 */
function getDiscordWinLossUpdater() {
  if (!__discordWLUpdateChecked) {
    __discordWLUpdateChecked = true;
    try {
      const mod = require('../discordBot');
      __discordWLUpdateFn = (typeof mod.postOrEditWinLossByKey === 'function') ? mod.postOrEditWinLossByKey : null;
      __discordWLClearFn = (typeof mod.clearWinLossByKey === 'function') ? mod.clearWinLossByKey : null;
    } catch (_) { __discordWLUpdateFn = null; __discordWLClearFn = null; }
  }
  return { updateByKey: __discordWLUpdateFn, clearByKey: __discordWLClearFn };
}

/**
 * Post window summary to Discord
 * @param {Object} window - Window object
 * @param {Function} buildSummaryFn - Function to build summary content
 * @returns {Promise<void>}
 */
async function postWindowSummary(window, buildSummaryFn) {
  try {
    if (!window) return;
    const content = buildSummaryFn(window);
    const sendWL = getDiscordWinLossSend();
    const send = getDiscordSend();
    if (typeof sendWL === 'function') await sendWL(content);
    else if (typeof send === 'function') await send(content);
  } catch (_) {}
}

/**
 * Update win/loss message for window
 * @param {string} windowKey - Window key
 * @param {string} content - Content to post
 * @returns {Promise<boolean>} True if posted successfully
 */
async function updateWinLossMessage(windowKey, content) {
  try {
    const { updateByKey } = getDiscordWinLossUpdater();
    if (typeof updateByKey === 'function') {
      const posted = await updateByKey(windowKey, content);
      return !!posted;
    }
  } catch (_) {}
  return false;
}

/**
 * Clear win/loss message for window
 * @param {string} windowKey - Window key
 */
function clearWinLossMessage(windowKey) {
  try {
    const { clearByKey } = getDiscordWinLossUpdater();
    if (typeof clearByKey === 'function') clearByKey(windowKey);
  } catch (_) {}
}

/**
 * Send message to Discord (with win/loss channel preference)
 * @param {string} content - Message content
 * @returns {Promise<void>}
 */
async function sendDiscordMessage(content) {
  try {
    const sendWL = getDiscordWinLossSend();
    if (typeof sendWL === 'function') {
      await sendWL(content);
      return;
    }
    const send = getDiscordSend();
    if (typeof send === 'function') {
      await send(content);
    }
  } catch (e) {
    console.error('[DEBUG] Error sending Discord message:', e);
  }
}

/**
 * Post or update session summary for window
 * @param {string} windowKey - Window key
 * @param {string} content - Summary content
 * @param {Object} window - Window object for fallback posting
 * @returns {Promise<void>}
 */
async function postOrEditSessionSummary(windowKey, content, window) {
  try {
    const { updateByKey } = getDiscordWinLossUpdater();
    let posted = null;
    if (typeof updateByKey === 'function') {
      try { posted = await updateByKey(windowKey, content); } catch (_) { posted = null; }
    }
    if (!posted) {
      const sendWL = getDiscordWinLossSend();
      if (typeof sendWL === 'function') {
        try { await sendWL(content); posted = true; } catch (_) { posted = null; }
      }
      if (!posted) {
        const send = getDiscordSend();
        if (typeof send === 'function') {
          try { await send(content); } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

module.exports = {
  getDiscordSend,
  getDiscordWinLossSend,
  getDiscordWinLossUpdater,
  postWindowSummary,
  updateWinLossMessage,
  clearWinLossMessage,
  sendDiscordMessage,
  postOrEditSessionSummary,
};
