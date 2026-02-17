// src/tracker/index.js
// Main entry point for the squadron tracker module

const path = require('path');
const { loadSettings } = require('../config');
const { logError, getCurrentWindow, dateKeyUTC } = require('./utils');
const { getSession, rebuildSessionFromEvents } = require('./session');
const { appendEvent, buildWindowSummaryContent } = require('./events');
const { archiveIfStale, scheduleDailyArchive, appendSnapshot, readLastSnapshot } = require('./snapshot');
const { fetchText } = require('./scraper');
const { initSeasonSchedule } = require('./schedule');
const { resetLeaderboardPointsStart, resetPlayerPointsStart } = require('./api');
const capture = require('./capture');

const discordBot = require('../discordBot');
const { sendMessage, sendWinLossMessage, postOrEditWinLossByKey, clearWinLossByKey, setWinLossChannel } = discordBot;

// Lazy accessor functions for Discord (mimics original behavior)
let __discordSendChecked = false;
let __discordSendFn = null;
let __discordWinLossChecked = false;
let __discordWinLossFn = null;
let __discordWLUpdateChecked = false;
let __discordWLUpdateFn = null;
let __discordWLClearFn = null;

function getDiscordSend() {
  if (!__discordSendChecked) {
    __discordSendChecked = true;
    try {
      __discordSendFn = typeof sendMessage === 'function' ? sendMessage : null;
    } catch (e) { 
      __discordSendFn = null; 
      logError('getDiscordSend', e);
    }
  }
  return __discordSendFn;
}

function getDiscordWinLossSend() {
  if (!__discordWinLossChecked) {
    __discordWinLossChecked = true;
    try {
      // Configure win/loss channel from settings.json if present
      try {
        const s = loadSettings();
        if (s && typeof s.discordWinLossChannell === 'string' && s.discordWinLossChannell.trim()) {
          try { 
            if (typeof setWinLossChannel === 'function') setWinLossChannel(s.discordWinLossChannell); 
          } catch (e) {
            logError('getDiscordWinLossSend.setWinLossChannel', e);
          }
        }
      } catch (e) {
        logError('getDiscordWinLossSend.loadSettings', e);
      }
      __discordWinLossFn = (typeof sendWinLossMessage === 'function') ? sendWinLossMessage : null;
    } catch (e) { 
      __discordWinLossFn = null;
      logError('getDiscordWinLossSend', e);
    }
  }
  return __discordWinLossFn;
}

function getDiscordWinLossUpdater() {
  if (!__discordWLUpdateChecked) {
    __discordWLUpdateChecked = true;
    try {
      __discordWLUpdateFn = (typeof postOrEditWinLossByKey === 'function') ? postOrEditWinLossByKey : null;
      __discordWLClearFn = (typeof clearWinLossByKey === 'function') ? clearWinLossByKey : null;
    } catch (e) { 
      __discordWLUpdateFn = null; 
      __discordWLClearFn = null;
      logError('getDiscordWinLossUpdater', e);
    }
  }
  return { updateByKey: __discordWLUpdateFn, clearByKey: __discordWLClearFn };
}

const DAILY_CUTOFF_MIN = 23 * 60 + 30; // 23:30 UTC
const POLL_INTERVAL_MS = 60_000;

async function startSquadronTracker() {
  const { squadronPageUrl } = loadSettings();
  
  // Initialize season schedule on startup (best-effort)
  try { await initSeasonSchedule(); } catch (e) {
    logError('startSquadronTracker.initSeasonSchedule', e);
  }
  
  // If the data file belongs to a previous UTC date, archive it immediately
  try { archiveIfStale(); } catch (e) {
    logError('startSquadronTracker.archiveIfStale', e);
  }
  
  // Then schedule daily archive of squadron_data.json at UTC midnight
  try { scheduleDailyArchive(); } catch (e) {
    logError('startSquadronTracker.scheduleDailyArchive', e);
  }
  
  if (!squadronPageUrl) {
    console.log('ℹ️ Squadron tracker disabled: no SQUADRON_PAGE_URL configured.');
    return { enabled: false };
  }

  // Rebuild in-memory session from existing events (if any)
  try { rebuildSessionFromEvents(); } catch (e) {
    logError('startSquadronTracker.rebuildSessionFromEvents', e);
  }
  
  let didInitialMembersFetch = false;

  // --- Jittered polling loop ---
  const jitterPct = (() => {
    try {
      const s = loadSettings();
      const v = Number(process.env.SQUADRON_POLL_JITTER_PCT ?? (s && s.squadronPollJitterPct));
      if (!Number.isFinite(v)) return 0.15; // default ±15%
      return Math.max(0, Math.min(0.9, v));
    } catch (e) {
      logError('jitterPct', e);
      return 0.15;
    }
  })();
  
  function nextDelayMs() {
    const base = POLL_INTERVAL_MS;
    const min = Math.max(1_000, Math.floor(base * (1 - jitterPct)));
    const max = Math.floor(base * (1 + jitterPct));
    return Math.floor(min + Math.random() * (max - min + 1));
  }
  
  let __pollTimer = null;
  let __pollStopped = false;
  
  async function pollLoop() {
    if (__pollStopped) return;
    try { 
      await capture.captureOnce(squadronPageUrl, getDiscordWinLossSend, getDiscordSend, getDiscordWinLossUpdater); 
    } catch (e) {
      logError('pollLoop.captureOnce', e);
    }
    if (__pollStopped) return;
    const delay = nextDelayMs();
    try { __pollTimer = setTimeout(pollLoop, delay); } catch (e) {
      logError('pollLoop.setTimeout', e);
    }
  }
  
  // Initial run and schedule next with jitter
  console.log('ℹ️ Performing forced leaderboard fetch at startup...');
  try { 
    await capture.captureOnce(squadronPageUrl, getDiscordWinLossSend, getDiscordSend, getDiscordWinLossUpdater, true); 
  } catch (e) {
    logError('startup.captureOnce', e);
  }
  
  const firstDelay = nextDelayMs();
  try { __pollTimer = setTimeout(pollLoop, firstDelay); } catch (e) {
    logError('startup.setTimeout', e);
  }

  // Expose a stop handle
  return {
    enabled: true,
    stop: async () => {
      __pollStopped = true;
      try { clearTimeout(__pollTimer); } catch (e) {
        logError('stop.clearTimeout', e);
      }
    }
  };
}

// Handle daily cutoff snapshot
async function handleDailyCutoff() {
  try {
    const cutoffMin = DAILY_CUTOFF_MIN;
    const now = new Date();
    const curMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    
    const dataFile = path.join(process.cwd(), 'squadron_data.json');
    const last = readLastSnapshot(dataFile);
    
    const sameDay = (d1, d2) => d1 && d2 && 
      d1.getUTCFullYear() === d2.getUTCFullYear() && 
      d1.getUTCMonth() === d2.getUTCMonth() && 
      d1.getUTCDate() === d2.getUTCDate();
    
    if (last && sameDay(new Date(last.ts), now)) {
      const lastDate = new Date(last.ts);
      const lastMin = lastDate.getUTCHours() * 60 + lastDate.getUTCMinutes();
      
      // If it's past cutoff, and we haven't saved a post-cutoff snapshot today, do it now
      if (curMin >= cutoffMin && (isNaN(lastMin) || lastMin < cutoffMin)) {
        console.log('ℹ️ Daily cutoff reached, saving snapshot.');
        // Snapshot will be saved by the next captureOnce call
      }
    }
  } catch (e) {
    logError('handleDailyCutoff', e);
  }
}

module.exports = {
  startSquadronTracker,
  getSession,
  handleDailyCutoff,
};
