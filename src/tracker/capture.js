// src/tracker/capture.js
const fs = require('fs');
const path = require('path');
const { logError, getCurrentWindow, dateKeyUTC, simplifyForComparison, toNum } = require('./utils');
const { getSession, updateSessionWinsLosses, handleWindowEnd, handleWindowStart, ensureSessionInitialized } = require('./session');
const { appendEvent, buildWindowSummaryContent, buildWindowSummaryLines } = require('./events');
const { appendSnapshot, readLastSnapshot } = require('./snapshot');
const { parseSquadronWithCheerio, parseTotalPointsFromHtml, fetchText, fetchTextWithFallback } = require('./scraper');
const { fetchLeaderboardAndFindSquadron, resetLeaderboardPointsStart, resetPlayerPointsStart } = require('./api');
const { loadSettings } = require('../config');
const { autoIssueAfterSnapshot } = require('../lowPointsIssuer');

const DATA_FILE = 'squadron_data.json';

function getDataFilePath() {
  return path.join(process.cwd(), DATA_FILE);
}

// Track last-seen values to determine which source (API vs Web) changed first
const __lastApiData = { points: null, ts: null };
const __lastWebData = { points: null, ts: null };
let __lastReportedPoints = null;

// Merge PointsStart from previous snapshot for existing players
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
        r['PointsStart'] = r['Points'] || r['points'] || '0';
      }
    }
  });
}

// Get primary squadron tag from settings
function getPrimarySquadronTag() {
  try {
    const settings = loadSettings();
    const keys = Object.keys(settings.squadrons || {});
    return keys.length ? keys[0] : '';
  } catch (e) {
    logError('getPrimarySquadronTag', e);
    return '';
  }
}

// Fetch all squadron data (HTML + API) concurrently
async function fetchSquadronData(squadronPageUrl, primaryTag) {
  let rawHtml = null;
  let apiLeaderboard = null;
  let apiSquadronData = null;
  
  try {
    const htmlPromise = (async () => { 
      try { 
        return await fetchText(squadronPageUrl); 
      } catch (e) {
        logError('fetchSquadronData.fetchText', e);
        return null; 
      } 
    })();
    const apiPromise = fetchLeaderboardAndFindSquadron(primaryTag, 20);

    const [htmlRes, apiRes] = await Promise.all([htmlPromise, apiPromise]);

    rawHtml = htmlRes;
    if (apiRes) {
      apiLeaderboard = apiRes.leaderboard;
      apiSquadronData = apiRes.squadronData;
    }
  } catch (e) {
    logError('fetchSquadronData', e);
  }
  
  return { rawHtml, apiLeaderboard, apiSquadronData };
}

// Parse HTML and extract squadron data
function parseHtmlData(rawHtml, prevRows) {
  const htmlErrorRe = /(cloudflare|just a moment|error code|404 not found|checking your browser)/i;
  const htmlLooksLikeError = rawHtml ? htmlErrorRe.test(rawHtml) : false;
  
  let parsed = null;
  let webTotal = null;
  let place = null;
  let membersCaptured = false;
  
  if (rawHtml && !htmlLooksLikeError) {
    parsed = parseSquadronWithCheerio(rawHtml);
    if (parsed && Array.isArray(parsed.rows)) {
      mergePointsStart(parsed.rows, prevRows);
      membersCaptured = true;
    }
    try {
      const result = parseTotalPointsFromHtml(rawHtml);
      if (Number.isFinite(result.totalPoints)) webTotal = result.totalPoints;
      if (Number.isFinite(result.place)) place = result.place;
    } catch (e) {
      logError('parseHtmlData.parseTotalPoints', e);
    }
  } else if (htmlLooksLikeError) {
    console.warn('⚠️ HTML content looks like an error page, skipping member parse.');
  }
  
  return { parsed, webTotal, place, membersCaptured, isHtmlError: htmlLooksLikeError };
}

// Extract API totals and context
function extractApiData(apiLeaderboard, apiSquadronData) {
  let apiTotal = null;
  let squadronPlace = null;
  let totalPointsAbove = null;
  let totalPointsBelow = null;
  
  if (apiSquadronData && apiSquadronData.found) {
    apiTotal = apiSquadronData.found.points;
    squadronPlace = apiSquadronData.squadronPlace;
    totalPointsAbove = apiSquadronData.totalPointsAbove;
    totalPointsBelow = apiSquadronData.totalPointsBelow;
  }
  
  return { apiTotal, squadronPlace, totalPointsAbove, totalPointsBelow, leaderboard: apiLeaderboard };
}

// Decide which source to trust for totalPoints based on timestamps
function chooseTotalSource() {
  const apiTs = __lastApiData.ts || 0;
  const webTs = __lastWebData.ts || 0;
  
  if (apiTs > 0 && apiTs >= webTs) {
    return { source: 'api', total: __lastApiData.points };
  } else if (webTs > 0) {
    return { source: 'web', total: __lastWebData.points };
  }
  return { source: null, total: null };
}

// Compute member changes (added/removed players, rating changes)
function computeMemberChanges(prev, curr) {
  const prevRows = (prev && prev.data && Array.isArray(prev.data.rows)) ? prev.data.rows : [];
  const currRows = (curr && Array.isArray(curr.rows)) ? curr.rows : [];
  const keyName = (r) => String(r['Player'] || r['player'] || '').trim();
  
  const mkIndex = (rows) => {
    const m = new Map();
    rows.forEach(r => { const k = keyName(r); if (k) m.set(k, r); });
    return m;
  };
  
  const prevMap = mkIndex(prevRows);
  const currMap = mkIndex(currRows);
  
  const added = [];
  const removed = [];
  prevMap.forEach((r, k) => { if (!currMap.has(k)) removed.push(r); });
  currMap.forEach((r, k) => { if (!prevMap.has(k)) added.push(r); });
  
  // Compute gained/lost counts across common members
  const increasedMembers = [];
  const decreasedMembers = [];
  let gainedPoints = 0;
  let lostPoints = 0;
  
  prevMap.forEach((prevMember, name) => {
    const currMember = currMap.get(name);
    if (!currMember) return;
    const prevRating = toNum(prevMember['Points'] || prevMember['rating'] || '');
    const currRating = toNum(currMember['Points'] || currMember['rating'] || '');
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
  
  return { added, removed, gainedPoints, lostPoints, increasedMembers, decreasedMembers };
}

// Derive wins/losses from points delta
function deriveWinsLosses(pointsDelta) {
  let matchesWon = 0;
  let matchesLost = 0;
  if (typeof pointsDelta === 'number') {
    if (pointsDelta > 0) { matchesWon = 1; }
    else if (pointsDelta < 0) { matchesLost = 1; }
  }
  return { matchesWon, matchesLost };
}

// Build notification message lines
function buildNotificationMessage(prevTotal, newTotal, pointsDelta, added, removed, session, matchesWon, matchesLost) {
  const msgLines = [];
  msgLines.push(`• Squadron tracker update (${new Date().toLocaleString()})`);
  
  const safeName = (r) => String(r['Player'] || r['player'] || 'Unknown').slice(0, 30);
  const safeRating = (r) => String(r['Points'] || r['rating'] || '0').slice(0, 5);
  const safeRole = (r) => String(r['Role'] || 'Member').slice(0, 20);
  const padRight = (s, n) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
  const padLeft = (s, n) => s.length >= n ? s.slice(-n) : ' '.repeat(n - s.length) + s;
  
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
  }
  if (added.length) {
    msgLines.push('• New members:');
    msgLines.push(...buildLines(added, '+'));
  }
  
  if (typeof pointsDelta === 'number' && pointsDelta !== 0) {
    const intervalSummary = matchesWon === 0 && matchesLost === 0
      ? 'no matches'
      : (matchesWon && matchesLost ? `${matchesWon} won, ${matchesLost} lost` 
        : (matchesWon ? `${matchesWon} match${matchesWon>1?'es':''} won` 
          : `${matchesLost} match${matchesLost>1?'es':''} lost`));
    msgLines.push(`• Points change: ${prevTotal} → ${newTotal} (${pointsDelta >= 0 ? '+' : ''}${pointsDelta}); interval: ${intervalSummary}`);
  }
  
  // Session summary line
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const timeSummary = `${hh}:${mm}`.padEnd(5, ' ');
  const deltaFromStart = (newTotal != null && session.startingPoints != null) 
    ? (Number(newTotal) - Number(session.startingPoints)) : null;
  const wlSummary = `${session.wins}/${session.losses}`;
  const startStr = (session.startingPoints != null && newTotal != null) 
    ? `${session.startingPoints} → ${newTotal}` : 'n/a';
  const sessionDeltaStr = (deltaFromStart != null) 
    ? `${deltaFromStart >= 0 ? '+' : ''}${deltaFromStart}` : 'n/a';
  
  msgLines.push(`• Session change: ${startStr} (Δ ${sessionDeltaStr}) W/L ${wlSummary}`);
  
  return msgLines;
}

// Send notification to Discord
async function sendNotification(msgLines, getDiscordWinLossSend, getDiscordSend) {
  const composed = msgLines.join('\n');
  const sendWL = getDiscordWinLossSend();
  if (sendWL) {
    try {
      await sendWL(composed);
      return;
    } catch (e) {
      logError('sendNotification.sendWL', e);
    }
  }
  const send = getDiscordSend();
  if (send) {
    try {
      await send(composed);
    } catch (e) {
      logError('sendNotification.send', e);
    }
  }
}

// Post or update window summary
async function postWindowSummary(window, getDiscordWinLossUpdater, getDiscordWinLossSend, getDiscordSend) {
  try {
    const { updateByKey } = getDiscordWinLossUpdater();
    let posted = null;
    if (typeof updateByKey === 'function') {
      try { 
        posted = await updateByKey(window.key, buildWindowSummaryContent(window)); 
      } catch (e) {
        logError('postWindowSummary.updateByKey', e);
        posted = null; 
      }
    }
    if (!posted) {
      const content = buildWindowSummaryContent(window);
      const sendWL = getDiscordWinLossSend();
      if (typeof sendWL === 'function') {
        try { await sendWL(content); posted = true; } catch (e) {
          logError('postWindowSummary.sendWL', e);
          posted = null; 
        }
      }
      if (!posted) {
        const send = getDiscordSend();
        if (typeof send === 'function') {
          try { await send(content); } catch (e) {
            logError('postWindowSummary.send', e);
          }
        }
      }
    }
  } catch (e) {
    logError('postWindowSummary', e);
  }
}

// Main capture function - orchestrates all the sub-functions
async function captureOnce(squadronPageUrl, getDiscordWinLossSend, getDiscordSend, getDiscordWinLossUpdater, forceSave = false) {
  const dataFile = getDataFilePath();
  const primaryTag = getPrimarySquadronTag();
  const session = getSession();
  
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

  // Fetch data from both sources
  const { rawHtml, apiLeaderboard, apiSquadronData } = await fetchSquadronData(squadronPageUrl, primaryTag);

  if (!rawHtml && !apiLeaderboard && !apiSquadronData) {
    console.warn('⚠️ Squadron tracker: failed to fetch data from both web and API. Skipping update and using cached data.');
    return;
  }

  // Parse HTML data
  const prevRows = snapshot.data?.rows || [];
  const { parsed, webTotal, place, membersCaptured, isHtmlError } = parseHtmlData(rawHtml, prevRows);
  
  if (parsed) {
    snapshot.data = parsed;
    if (lastSnapshotForInit?.data?.leaderboard !== undefined) {
      snapshot.data.leaderboard = lastSnapshotForInit.data.leaderboard;
    }
    snapshot.membersCaptured = membersCaptured;
  } else if (isHtmlError) {
    snapshot.membersCaptured = false;
  }
  
  if (Number.isFinite(webTotal)) snapshot.totalPoints = webTotal;
  if (Number.isFinite(place)) snapshot.squadronPlace = place;

  // Extract API data
  const { apiTotal, squadronPlace: apiPlace, totalPointsAbove: apiAbove, totalPointsBelow: apiBelow, leaderboard } = extractApiData(apiLeaderboard, apiSquadronData);
  
  if (leaderboard) snapshot.data.leaderboard = leaderboard;
  if (apiPlace !== null) snapshot.squadronPlace = apiPlace;
  if (apiAbove !== null) snapshot.totalPointsAbove = apiAbove;
  if (apiBelow !== null) snapshot.totalPointsBelow = apiBelow;

  // Update tracking timestamps
  const now = Date.now();
  if (Number.isFinite(apiTotal) && __lastApiData.points !== apiTotal) {
    __lastApiData.points = apiTotal;
    __lastApiData.ts = now;
  }
  if (Number.isFinite(webTotal) && __lastWebData.points !== webTotal) {
    __lastWebData.points = webTotal;
    __lastWebData.ts = now;
  }

  // Choose source and detect change
  const { source: chosenSource, total: chosenTotal } = chooseTotalSource();
  
  if (Number.isFinite(chosenTotal) && chosenTotal !== __lastReportedPoints) {
    snapshot.totalPoints = chosenTotal;
    if (__lastApiData.points !== __lastWebData.points) {
      console.log(`ℹ️ Source diff: api=${__lastApiData.points} vs web=${__lastWebData.points} (chosen=${chosenSource})`);
      try {
        appendEvent({
          type: 'source_diff',
          dr_era5_hist: __lastApiData.points,
          squadron_rating: __lastWebData.points,
          chosen: chosenSource,
        });
      } catch (e) {
        logError('captureOnce.appendEvent.source_diff', e);
      }
    }
  } else {
    // No change detected
  }

  // Restore members if capture failed
  const last = readLastSnapshot(dataFile);
  if (!snapshot.membersCaptured && last && last.data) {
    if (last.data.rows) snapshot.data.rows = last.data.rows;
    if (last.data.headers) snapshot.data.headers = last.data.headers;
    if (last.membersCaptured) snapshot.membersCaptured = last.membersCaptured;
  }
  
  const key = simplifyForComparison(snapshot);
  
  // Initialize lastKey on first run
  staticVars.lastKey = staticVars.lastKey ?? (function() {
    if (last) {
      if (typeof last.totalPoints === 'number') {
        __lastReportedPoints = last.totalPoints;
        __lastApiData.points = last.totalPoints;
        __lastWebData.points = last.totalPoints;
      }
      return simplifyForComparison(last);
    }
    return null;
  })();
  
  staticVars.lastSnapshot = staticVars.lastSnapshot ?? last;

  // Check if there's a meaningful change
  if (key !== staticVars.lastKey || forceSave) {
    const prev = staticVars.lastSnapshot || readLastSnapshot(dataFile);
    const prevTotal = prev && typeof prev.totalPoints === 'number' ? prev.totalPoints : null;
    const newTotal = typeof snapshot.totalPoints === 'number' ? snapshot.totalPoints : null;
    const pointsDelta = (prevTotal != null && newTotal != null) ? (newTotal - prevTotal) : null;

    // Compute member changes
    const { added, removed, gainedPoints, lostPoints, increasedMembers, decreasedMembers } = computeMemberChanges(prev, snapshot.data);
    
    // Derive wins/losses
    const { matchesWon, matchesLost } = deriveWinsLosses(pointsDelta);

    // Handle session window transitions
    const activeWindow = getCurrentWindow();
    
    if (!activeWindow && session.windowKey) {
      handleWindowEnd();
    }
    
    if (activeWindow && session.windowKey !== activeWindow.key) {
      handleWindowStart(activeWindow, prevTotal, snapshot);
      try {
        if (session.startingPoints != null) {
          resetLeaderboardPointsStart();
          resetPlayerPointsStart(dataFile);
        }
      } catch (e) {
        logError('captureOnce.resetPoints', e);
      }
      await postWindowSummary(activeWindow, getDiscordWinLossUpdater, getDiscordWinLossSend, getDiscordSend);
    }
    
    if (activeWindow) {
      ensureSessionInitialized(activeWindow, prevTotal, snapshot);
    }
    
    // Update session wins/losses
    updateSessionWinsLosses(matchesWon, matchesLost);

    // Emit points_change event
    try {
      if (pointsDelta != null && pointsDelta !== 0) {
        const inc = Array.isArray(increasedMembers) ? increasedMembers.slice(0, 50) : [];
        const dec = Array.isArray(decreasedMembers) ? decreasedMembers.slice(0, 50) : [];
        appendEvent({
          type: 'points_change',
          delta: pointsDelta,
          from: prevTotal,
          to: newTotal,
          place: snapshot.squadronPlace ?? null,
          totalPointsAbove: snapshot.totalPointsAbove ?? null,
          totalPointsBelow: snapshot.totalPointsBelow ?? null,
          matchesWon,
          matchesLost,
          gainedPlayers: gainedPoints,
          lostPlayers: lostPoints,
          membersIncreased: inc,
          membersDecreased: dec,
          dateKey: session.dateKey,
          windowKey: session.windowKey || null,
          pointsSource: chosenSource,
        });
        if (Number.isFinite(newTotal)) {
          __lastReportedPoints = newTotal;
        }
        // Live-update session summary
        try {
          if (activeWindow && session.windowKey === activeWindow.key) {
            const { updateByKey } = getDiscordWinLossUpdater();
            if (typeof updateByKey === 'function') {
              await updateByKey(activeWindow.key, buildWindowSummaryContent(activeWindow));
            }
          }
        } catch (e) {
          logError('captureOnce.liveUpdateSessionSummary', e);
        }
      }
    } catch (e) {
      logError('captureOnce.emitPointsChange', e);
    }

    // Emit member join/leave events
    for (const r of removed) {
      const member = {
        'Player': String(r['Player'] || r['player'] || 'Unknown').slice(0, 30),
        'Points': String(r['Points'] || r['rating'] || '0').slice(0, 5),
        'Role': String(r['Role'] || 'Member').slice(0, 20),
        'Date of entry': (r['Date of entry'] || r['date of entry'] || r['Date'] || '').toString(),
      };
      appendEvent({ type: 'member_leave', delta: pointsDelta ?? null, member });
    }
    for (const r of added) {
      const member = {
        'Player': String(r['Player'] || r['player'] || 'Unknown').slice(0, 30),
        'Points': String(r['Points'] || r['rating'] || '0').slice(0, 5),
        'Role': String(r['Role'] || 'Member').slice(0, 20),
        'Date of entry': (r['Date of entry'] || r['date of entry'] || r['Date'] || '').toString(),
      };
      appendEvent({ type: 'member_join', delta: pointsDelta ?? null, member });
    }

    // Build and send notification
    const msgLines = buildNotificationMessage(prevTotal, newTotal, pointsDelta, added, removed, session, matchesWon, matchesLost);
    const hasMeaningfulChange = (pointsDelta != null && pointsDelta !== 0) || added.length > 0 || removed.length > 0;
    
    if (hasMeaningfulChange) {
      await sendNotification(msgLines, getDiscordWinLossSend, getDiscordSend);
    } else {
      console.log('ℹ️ Squadron tracker: insignificant change detected, skipping notification.');
    }

    // Persist snapshot
    try {
      snapshot.session = {
        dateKey: session.dateKey,
        startedAt: session.startedAt ? session.startedAt.toISOString() : null,
        startingPoints: session.startingPoints,
        startingPos: session.startingPos,
        wins: session.wins,
        losses: session.losses,
        lastInterval: {
          gainedPlayers: gainedPoints,
          lostPlayers: lostPoints,
          matchesWon,
          matchesLost,
          pointsDelta: (typeof pointsDelta === 'number') ? pointsDelta : null,
        },
      };
    } catch (e) {
      logError('captureOnce.persistSessionState', e);
    }
    
    appendSnapshot(dataFile, snapshot);
    staticVars.lastKey = key;
    staticVars.lastSnapshot = snapshot;
    console.log('📈 Squadron tracker: snapshot recorded.');
  } else {
    console.log('ℹ️ Squadron tracker: no change.');
  }
}

// Static variables to persist across calls
const staticVars = {
  lastKey: null,
  lastSnapshot: null,
};

// Export with initializer
function createCaptureModule() {
  return {
    captureOnce: (squadronPageUrl, getDiscordWinLossSend, getDiscordSend, getDiscordWinLossUpdater, forceSave = false) => 
      captureOnce(squadronPageUrl, getDiscordWinLossSend, getDiscordSend, getDiscordWinLossUpdater, forceSave),
    resetState: () => {
      staticVars.lastKey = null;
      staticVars.lastSnapshot = null;
      __lastApiData.points = null;
      __lastApiData.ts = null;
      __lastWebData.points = null;
      __lastWebData.ts = null;
      __lastReportedPoints = null;
    },
  };
}

module.exports = createCaptureModule();
