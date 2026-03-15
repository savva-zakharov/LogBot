// src/squadronTracker.js
// Main orchestrator for squadron tracking - refactored into modular structure
// This file coordinates all the sub-modules for squadron data tracking

const fs = require('fs');
const path = require('path');

// Import modular components
const {
  // Window management
  getCurrentWindow,
  dateKeyUTC,
  scheduleDailyArchive,
  archiveIfStale,
  
  // Session management
  getSession,
  resetSquadronSession,
  clearSessionAtWindowEnd,
  updateSessionWinsLosses,
  ensureSessionInitialized,
  getSessionSummary,
  getSessionForSnapshot,
  markPlayerPointsResetDone,
  isPlayerPointsResetDone,
  getPlayerSession,
  resetSessionAtCutoff,
  restorePlayerSessionFromDisk,
  savePlayerSessionToDisk,
  
  // Data fetching
  fetchText,
  parseTotalPointsFromHtml,
  parseSquadronWithCheerio,
  toNum,
  fetchLeaderboardAndFindSquadron,
  
  // Event logging
  appendEvent,
  readEvents,
  buildWindowSummaryContent,
  
  // Snapshot management
  ensureParsedDataFile,
  readLastSnapshot,
  appendSnapshot,
  simplifyForComparison,
  pruneSnapshot,
  mergePointsStart,
  resetLeaderboardPointsStart,
  resetPlayerPointsStart: resetPlayerPointsStartFn,
  
  // Discord integration
  getDiscordSend,
  getDiscordWinLossSend,
  getDiscordWinLossUpdater,
  sendDiscordMessage,
  postOrEditSessionSummary,
} = require('./squadron');

// Import external dependencies
const { loadSettings } = require('./config');
const { autoIssueAfterSnapshot } = require('./lowPointsIssuer');

// Constants
const POLL_INTERVAL_MS = 60_000;

// Squadron page URL (from settings or default)
function getSquadronPageUrl() {
  try {
    const settings = loadSettings();
    if (settings && settings.squadronPageUrl) {
      return settings.squadronPageUrl;
    }
  } catch (_) {}
  // Default URL if not configured
  return 'https://warthunder.com/clans/?clan=YOUR_CLAN_TAG';
}

// Helper functions for safe name/rating/role extraction
function safeName(r) {
  return String(r['Player'] || r['player'] || r['name'] || 'Unknown').trim();
}

function safeRating(r) {
  return String(r['Points'] || r['points'] || r['rating'] || '0').trim();
}

function safeRole(r) {
  return String(r['Role'] || r['role'] || 'Member').trim();
}

function padRight(s, n) {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function padLeft(s, n) {
  return s.length >= n ? s.slice(-n) : ' '.repeat(n - s.length) + s;
}

/**
 * Start the squadron tracker
 * @returns {Promise<Object>} Tracker control object with stop function
 */
async function startSquadronTracker() {
  console.log('🚀 Starting Squadron Tracker (modular version)...');

  // Archive stale data on startup
  archiveIfStale();

  // Schedule daily archives
  scheduleDailyArchive();

  // Restore player session from disk (if exists)
  try {
    restorePlayerSessionFromDisk();
  } catch (e) {
    console.warn('[WARN] Failed to restore player session:', e.message);
  }

  const squadronPageUrl = getSquadronPageUrl();
  const dataFile = ensureParsedDataFile();
  
  // State variables
  let lastKey = null;
  let lastSnapshot = null;
  let didInitialMembersFetch = false;
  
  // Track last-seen values to determine which source changed first
  let __lastApiData = { points: null, ts: null };
  let __lastWebData = { points: null, ts: null };
  let __lastReportedPoints = null;
  
  /**
   * Capture squadron data once
   * @param {boolean} forceSave - Force save even if no changes
   */
  async function captureOnce(forceSave = false) {
    // Determine primary squadron tag
    let primaryTag = '';
    try {
      const settings = loadSettings();
      const keys = Object.keys(settings.squadrons || {});
      primaryTag = keys.length ? keys[0] : '';
    } catch (_) {}
    
    // Initialize leaderboard context
    let squadronPlace = null;
    let totalPointsAbove = null;
    let totalPointsBelow = null;
    
    const lastSnapshotForInit = readLastSnapshot(dataFile);
    let snapshot = {
      ts: Date.now(),
      data: lastSnapshotForInit?.data ? JSON.parse(JSON.stringify(lastSnapshotForInit.data)) : { headers: [], rows: [], leaderboard: [] },
      totalPoints: lastSnapshotForInit?.totalPoints ?? null,
      squadronPlace: lastSnapshotForInit?.squadronPlace ?? null,
      totalPointsAbove: lastSnapshotForInit?.totalPointsAbove ?? null,
      totalPointsBelow: lastSnapshotForInit?.totalPointsBelow ?? null,
      membersCaptured: lastSnapshotForInit?.membersCaptured ?? false,
    };
    
    // Concurrently fetch HTML and API data
    let rawHtml = null;
    let apiLeaderboard = null;
    let apiSquadronData = null;
    try {
      const htmlPromise = (async () => { try { return await fetchText(squadronPageUrl); } catch (_) { return null; } })();
      const apiPromise = fetchLeaderboardAndFindSquadron(primaryTag, 20);
      const [htmlRes, apiRes] = await Promise.all([htmlPromise, apiPromise]);
      rawHtml = htmlRes;
      if (apiRes) {
        apiLeaderboard = apiRes.leaderboard;
        apiSquadronData = apiRes.squadronData;
      }
    } catch (_) {}
    
    if (!rawHtml && !apiLeaderboard && !apiSquadronData) {
      console.warn('⚠️ Squadron tracker: failed to fetch data from both web and API. Skipping update.');
      return;
    }
    
    // Parse HTML members + web total
    let webTotal = null;
    try {
      const htmlErrorRe = /(cloudflare|just a moment|error code|404 not found|checking your browser)/i;
      const htmlLooksLikeError = rawHtml ? htmlErrorRe.test(rawHtml) : false;
      
      if (rawHtml && !htmlLooksLikeError) {
        const parsed = parseSquadronWithCheerio(rawHtml);
        if (parsed && Array.isArray(parsed.rows)) {
          const prevRows = snapshot.data?.rows || [];
          mergePointsStart(parsed.rows, prevRows);
          const existingLeaderboard = snapshot.data?.leaderboard;
          snapshot.data = parsed;
          if (existingLeaderboard !== undefined) snapshot.data.leaderboard = existingLeaderboard;
          snapshot.membersCaptured = true;
        }
        try {
          const { totalPoints, place } = parseTotalPointsFromHtml(rawHtml);
          if (Number.isFinite(totalPoints)) webTotal = totalPoints;
          if (Number.isFinite(place)) snapshot.squadronPlace = place;
        } catch (_) {}
      }
    } catch (_) {}
    
    // Extract API totals/context
    let apiTotal = null;
    try {
      if (apiLeaderboard) {
        snapshot.data.leaderboard = apiLeaderboard;
      }
      if (apiSquadronData && apiSquadronData.found) {
        apiTotal = apiSquadronData.found.points;
        snapshot.squadronPlace = apiSquadronData.squadronPlace;
        snapshot.totalPointsAbove = apiSquadronData.totalPointsAbove;
        snapshot.totalPointsBelow = apiSquadronData.totalPointsBelow;
      }
    } catch (_) {}
    
    // Decide which source to trust for totalPoints
    const now = Date.now();
    if (Number.isFinite(apiTotal)) {
      if (__lastApiData.points !== apiTotal) {
        __lastApiData.points = apiTotal;
        __lastApiData.ts = now;
      }
    }
    if (Number.isFinite(webTotal)) {
      if (__lastWebData.points !== webTotal) {
        __lastWebData.points = webTotal;
        __lastWebData.ts = now;
      }
    }
    
    // Decide which source is authoritative based on latest timestamp
    let chosenTotal = null;
    let chosenSource = null;
    const apiTs = __lastApiData.ts || 0;
    const webTs = __lastWebData.ts || 0;
    
    if (apiTs > 0 && apiTs >= webTs) {
      chosenSource = 'api';
      chosenTotal = __lastApiData.points;
    } else if (webTs > 0) {
      chosenSource = 'web';
      chosenTotal = __lastWebData.points;
    }
    
    // Handle changes
    if (Number.isFinite(chosenTotal) && chosenTotal !== __lastReportedPoints) {
      snapshot.totalPoints = chosenTotal;
    } else {
      chosenTotal = __lastReportedPoints;
    }
    
    if (Number.isFinite(chosenTotal)) {
      snapshot.totalPoints = chosenTotal;
    }
    
    // Restore from last snapshot if members not captured
    const last = readLastSnapshot(dataFile);
    if (!snapshot.membersCaptured && last && last.data) {
      if (last.data.rows) snapshot.data.rows = last.data.rows;
      if (last.data.headers) snapshot.data.headers = last.data.headers;
      if (last.membersCaptured) snapshot.membersCaptured = last.membersCaptured;
    }
    
    const key = simplifyForComparison(snapshot);
    
    // Initialize from existing file
    if (lastKey === null) {
      if (last) {
        lastKey = simplifyForComparison(last);
        lastSnapshot = last;
        if (typeof last.totalPoints === 'number') {
          __lastReportedPoints = last.totalPoints;
          __lastApiData.points = last.totalPoints;
          __lastWebData.points = last.totalPoints;
        }
      }
    }
    
    // Process changes
    if (key !== lastKey || forceSave) {
      try {
        const prev = lastSnapshot || readLastSnapshot(dataFile);
        
        // Initial members fetch
        if (!didInitialMembersFetch) {
          try {
            const raw0 = await fetchText(squadronPageUrl);
            if (raw0) {
              console.log(`ℹ️ Startup members HTML length=${raw0.length}`);
              const parsed0 = parseSquadronWithCheerio(raw0);
              if (parsed0 && Array.isArray(parsed0.rows)) {
                mergePointsStart(parsed0.rows, snapshot.data?.rows);
                snapshot.data = parsed0;
                snapshot.membersCaptured = true;
                didInitialMembersFetch = true;
                console.log(`ℹ️ Startup parsed member rows=${parsed0.rows.length}`);
              }
            }
          } catch (_) {}
        }
        
        const prevTotal = prev && typeof prev.totalPoints === 'number' ? prev.totalPoints : null;
        const newTotal = typeof snapshot.totalPoints === 'number' ? snapshot.totalPoints : null;
        
        // Retry fetch if empty
        if ((!snapshot.data || !Array.isArray(snapshot.data.rows) || !snapshot.data.rows.length)) {
          try {
            const raw = await fetchText(squadronPageUrl);
            if (raw) {
              const parsed = parseSquadronWithCheerio(raw);
              if (parsed && Array.isArray(parsed.rows)) {
                mergePointsStart(parsed.rows, snapshot.data?.rows);
                snapshot.data = parsed;
                snapshot.membersCaptured = true;
              }
            }
          } catch (_) {}
        }
        
        const msgLines = [];
        msgLines.push(`• Squadron tracker update (${new Date().toLocaleString()})`);
        
        const pointsDelta = (prevTotal != null && newTotal != null) ? (newTotal - prevTotal) : null;
        
        let gainedPoints = 0;
        let lostPoints = 0;
        let matchesWon = 0;
        let matchesLost = 0;
        let added = [];
        let removed = [];
        
        // Row-level changes
        if (snapshot.membersCaptured && prev) {
          const prevRows = (prev && prev.data && Array.isArray(prev.data.rows)) ? prev.data.rows : [];
          const currRows = (snapshot.data && Array.isArray(snapshot.data.rows)) ? snapshot.data.rows : [];
          const keyName = (r) => String(r['Player'] || r['player'] || '').trim();
          const mkIndex = (rows) => {
            const m = new Map();
            rows.forEach(r => { const k = keyName(r); if (k) m.set(k, r); });
            return m;
          };
          const prevMap = mkIndex(prevRows);
          const currMap = mkIndex(currRows);
          prevMap.forEach((r, k) => { if (!currMap.has(k)) removed.push(r); });
          currMap.forEach((r, k) => { if (!prevMap.has(k)) added.push(r); });
          
          // Compute gained/lost counts
          try {
            const increasedMembers = [];
            const decreasedMembers = [];
            prevMap.forEach((prevMember, name) => {
              const currMember = currMap.get(name);
              if (!currMember) return;
              const prevRating = toNum((prevMember['Points'] || prevMember['rating'] || '').toString());
              const currRating = toNum((currMember['Points'] || currMember['rating'] || '').toString());
              if (Number.isFinite(prevRating) && Number.isFinite(currRating)) {
                const delta = currRating - prevRating;
                if (delta > 0) {
                  gainedPoints += 1;
                  increasedMembers.push({ player: name, from: prevRating, to: currRating, delta });
                } else if (delta < 0) {
                  lostPoints += 1;
                  decreasedMembers.push({ player: name, from: prevRating, to: currRating, delta });
                }
              }
            });
            captureOnce.__lastIncreasedMembers = increasedMembers;
            captureOnce.__lastDecreasedMembers = decreasedMembers;
          } catch (_) {}
          
          // Win/loss derivation
          matchesWon = 0;
          matchesLost = 0;
          if (typeof pointsDelta === 'number') {
            if (pointsDelta > 0) { matchesWon = 1; matchesLost = 0; }
            else if (pointsDelta < 0) { matchesWon = 0; matchesLost = 1; }
          }
          
          // Session state management
          const now = new Date();
          const activeWindow = getCurrentWindow(now);
          
          // Handle window end
          if (!activeWindow && getSession().windowKey) {
            try {
              const { clearByKey } = getDiscordWinLossUpdater();
              if (typeof clearByKey === 'function') clearByKey(getSession().windowKey);
            } catch (_) {}
            try { appendEvent({ type: 'session_reset', reason: 'window_end', windowKey: getSession().windowKey, dateKey: getSession().dateKey }); } catch (_) {}
            clearSessionAtWindowEnd();
          }
          
          // Handle new window start
          if (activeWindow && getSession().windowKey !== activeWindow.key) {
            resetSquadronSession(activeWindow, 
              (prevTotal != null ? prevTotal : (newTotal != null ? newTotal : null)),
              (prev?.squadronPlace != null ? prev.squadronPlace : (snapshot.squadronPlace != null ? snapshot.squadronPlace : null))
            );
            
            try {
              if (getSession().startingPoints != null) {
                appendEvent({ 
                  type: 'session_start', 
                  startingPoints: getSession().startingPoints, 
                  startingPos: getSession().startingPos, 
                  dateKey: getSession().dateKey, 
                  windowKey: getSession().windowKey 
                });
                resetLeaderboardPointsStart();
                await resetPlayerPointsStartFn(isPlayerPointsResetDone(), getPlayerSession(), getSession());
              }
            } catch (_) {}
            
            try {
              await postOrEditSessionSummary(activeWindow.key, buildWindowSummaryContent(activeWindow), activeWindow);
            } catch (_) {}
          }
          
          // Ensure session initialized
          if (activeWindow && (getSession().startingPoints == null || getSession().startedAt == null)) {
            ensureSessionInitialized(activeWindow, prevTotal, prev, snapshot);
          }
          
          updateSessionWinsLosses(matchesWon, matchesLost);
          
          // Emit points_change event
          try {
            if (pointsDelta != null && pointsDelta !== 0) {
              const inc = Array.isArray(captureOnce.__lastIncreasedMembers) ? captureOnce.__lastIncreasedMembers.slice(0, 50) : [];
              const dec = Array.isArray(captureOnce.__lastDecreasedMembers) ? captureOnce.__lastDecreasedMembers.slice(0, 50) : [];
              appendEvent({
                type: 'points_change',
                delta: pointsDelta,
                from: prevTotal,
                to: newTotal,
                place: squadronPlace ?? null,
                totalPointsAbove: totalPointsAbove ?? null,
                totalPointsBelow: totalPointsBelow ?? null,
                matchesWon,
                matchesLost,
                gainedPlayers: gainedPoints,
                lostPlayers: lostPoints,
                membersIncreased: inc,
                membersDecreased: dec,
                dateKey: getSession().dateKey,
                windowKey: getSession().windowKey || null,
                pointsSource: chosenSource,
              });
              if (Number.isFinite(newTotal)) {
                __lastReportedPoints = newTotal;
              }
              // Live-update session summary
              try {
                if (activeWindow && getSession().windowKey === activeWindow.key) {
                  const { updateByKey } = getDiscordWinLossUpdater();
                  if (typeof updateByKey === 'function') await updateByKey(activeWindow.key, buildWindowSummaryContent(activeWindow));
                }
              } catch (_) {}
            }
          } catch (_) {}
          
          // Build member change lines
          const buildLines = (list, symbol) => {
            const shown = list.slice(0, 10);
            const maxNameLen = Math.max(0, ...shown.map(r => safeName(r).length));
            const maxRatingLen = Math.max(0, ...shown.map(r => safeRating(r).length));
            return shown.map(r => {
              const nameP = padRight(safeName(r), Math.min(maxNameLen, 30));
              const ratingP = padLeft(safeRating(r) || '0', Math.min(Math.max(maxRatingLen, 1), 5));
              const role = safeRole(r) || 'Member';
              return `   ${symbol} ${nameP} (${ratingP}, ${role})`;
            });
          };
          
          if (removed.length) {
            msgLines.push('• Departures:');
            msgLines.push(...buildLines(removed, '-'));
            for (const r of removed) {
              const member = {
                'Player': safeName(r),
                'Points': safeRating(r) || '0',
                'Role': safeRole(r) || 'Member',
                'Date of entry': (r['Date of entry'] || '').toString(),
              };
              appendEvent({ type: 'member_leave', delta: pointsDelta ?? null, member });
            }
          }
          if (added.length) {
            msgLines.push('• New members:');
            msgLines.push(...buildLines(added, '+'));
            for (const r of added) {
              const member = {
                'Player': safeName(r),
                'Points': safeRating(r) || '0',
                'Role': safeRole(r) || 'Member',
                'Date of entry': (r['Date of entry'] || '').toString(),
              };
              appendEvent({ type: 'member_join', delta: pointsDelta ?? null, member });
            }
          }
        }
        
        // Points change line
        if (typeof pointsDelta === 'number' && pointsDelta !== 0) {
          const intervalSummary = matchesWon === 0 && matchesLost === 0
            ? 'no matches'
            : (matchesWon && matchesLost ? `${matchesWon} won, ${matchesLost} lost` : (matchesWon ? `${matchesWon} match${matchesWon>1?'es':''} won` : `${matchesLost} match${matchesLost>1?'es':''} lost`));
          msgLines.push(`• Points  change: ${prevTotal} → ${newTotal} (${pointsDelta >= 0 ? '+' : ''}${pointsDelta}); interval: ${intervalSummary}`);
        }
        
        // Session summary line
        const sessionSummary = getSessionSummary(newTotal);
        msgLines.push(`• Session change: ${sessionSummary.startStr} (Δ ${sessionSummary.sessionDeltaStr}) W/L ${sessionSummary.wlSummary}`);
        
        const hasMeaningfulChange = (pointsDelta != null && pointsDelta !== 0) || added.length > 0 || removed.length > 0;
        
        if (hasMeaningfulChange) {
          const composed = msgLines.join('\n');
          console.log(composed);
          await sendDiscordMessage(composed);
        }

        // Save snapshot with player session data
        try {
          snapshot.session = getSessionForSnapshot();
        } catch (_) {}
        try {
          appendSnapshot(dataFile, snapshot, getPlayerSession());
        } catch (e) {
          console.warn('[WARN] Failed to save player session with snapshot:', e.message);
          appendSnapshot(dataFile, snapshot);
        }
        lastKey = simplifyForComparison(snapshot);
        lastSnapshot = pruneSnapshot(snapshot);
        
        // Auto-issue low points after snapshot
        try {
          autoIssueAfterSnapshot(snapshot);
        } catch (_) {}
        
      } catch (e) {
        console.error('[ERROR] Error in captureOnce:', e);
      }
    }
    
    // Check for daily cutoff (23:30 UTC)
    const nowDate = new Date();
    const mins = nowDate.getUTCHours() * 60 + nowDate.getUTCMinutes();
    if (mins >= 23 * 60 + 30) { // 23:30 UTC
      const todayKey = dateKeyUTC(nowDate);
      if (lastSnapshot && lastSnapshot.dateKey !== todayKey) {
        try {
          lastSnapshot.dateKey = todayKey;
          lastSnapshot.session = getSessionForSnapshot();
          
          // Reuse last known member rows if current snapshot has no rows
          const hasRows = snapshot && snapshot.data && Array.isArray(snapshot.data.rows) && snapshot.data.rows.length > 0;
          const lastHasRows = lastSnapshot && lastSnapshot.data && Array.isArray(lastSnapshot.data.rows) && lastSnapshot.data.rows.length > 0;
          if (!hasRows && lastHasRows) {
            snapshot.data = { ...lastSnapshot.data };
            snapshot.membersCaptured = true;
            console.log('ℹ️ Daily cutoff: reused last known member rows for snapshot.');
          }

          appendSnapshot(dataFile, snapshot, getPlayerSession());
          lastKey = simplifyForComparison(snapshot);
          lastSnapshot = pruneSnapshot(snapshot);
          console.log('🕧 Squadron tracker: daily cutoff snapshot saved.');

          // Reset session at cutoff
          resetSessionAtCutoff(snapshot);
          
          // Persist session_reset event
          try {
            const newStarting = (typeof snapshot.totalPoints === 'number') ? snapshot.totalPoints : getSession().startingPoints;
            const newStartingPos = (typeof snapshot.squadronPlace === 'number') ? snapshot.squadronPlace : getSession().startingPos;
            if (newStarting != null) {
              appendEvent({ type: 'session_reset', startingPoints: newStarting, startingPos: newStartingPos, dateKey: todayKey });
            }
          } catch (_) {}
        } catch (_) {}
      }
    }
  }
  
  // Jittered polling loop
  const jitterPct = (() => {
    try {
      const s = loadSettings();
      const v = Number(process.env.SQUADRON_POLL_JITTER_PCT ?? (s && s.squadronPollJitterPct));
      if (!Number.isFinite(v)) return 0.15;
      return Math.max(0, Math.min(0.9, v));
    } catch (_) { return 0.15; }
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
    try { await captureOnce(); } catch (_) {}
    if (__pollStopped) return;
    const delay = nextDelayMs();
    try { __pollTimer = setTimeout(pollLoop, delay); } catch (_) {}
  }
  
  // Initial run
  console.log('ℹ️ Performing forced leaderboard fetch at startup...');
  try { await captureOnce(true); } catch (_) {}
  const firstDelay = nextDelayMs();
  try { __pollTimer = setTimeout(pollLoop, firstDelay); } catch (_) {}
  
  // Return control object
  return {
    enabled: true,
    stop: async () => {
      __pollStopped = true;
      try { clearTimeout(__pollTimer); } catch (_) {}
    }
  };
}

module.exports = {
  startSquadronTracker,
  getSession,
};
