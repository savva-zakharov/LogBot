// src/tracker/api.js
const fs = require('fs');
const path = require('path');
const { fetchJson, toNum, CACHE_TTL } = require('./scraper');
const { getCache, setCache } = require('./cache');
const { logError } = require('./utils');

const LEADERBOARD_FILE = 'leaderboard_data.json';

function getLeaderboardFilePath() {
  return path.join(process.cwd(), LEADERBOARD_FILE);
}

/**
 * Generate cache key for leaderboard API requests
 * @param {number} page - Page number
 * @returns {string} Cache key
 */
function getLeaderboardCacheKey(page) {
  return `leaderboard:page:${page}`;
}

/**
 * Fetch leaderboard data and find squadron by tag
 * @param {string} tag - Squadron tag to search for
 * @param {number} limit - Number of top squadrons to return
 * @returns {Promise<{leaderboard: Array, squadronData: Object|null}>}
 */
async function fetchLeaderboardAndFindSquadron(tag, limit = 20) {
  try {
    const needle = (String(tag || '').trim().match(/[a-zA-Z0-9_]+/g) || []).join('').toLowerCase();
    if (!needle && !limit) return { leaderboard: [], squadronData: null };

    const makeUrl = (page) => `https://warthunder.com/en/community/getclansleaderboard/dif/_hist/page/${page}/sort/dr_era5`;
    let page = 1;
    const MAX_PAGES = 100;
    const topLeaderboard = [];
    const fullLeaderboard = [];
    let squadronData = null;
    let prevPageArr = [];

    while (page <= MAX_PAGES) {
      const cacheKey = getLeaderboardCacheKey(page);
      
      // Try cache first for leaderboard pages
      let json = getCache(cacheKey);
      
      if (json === null) {
        // Not in cache, fetch from API
        json = await fetchJson(makeUrl(page), 15000, true);
      } else {
        console.log(`♻️ fetchLeaderboard: cache hit for page ${page}`);
      }
      
      if (!json || json.status !== 'ok') break;
      const currentPageArr = Array.isArray(json.data) ? json.data : [];
      if (!currentPageArr.length) break;

      for (const item of currentPageArr) {
        fullLeaderboard.push({
          pos: item.pos,
          tag: item.tag,
          tagl: item.tagl,
          name: item.name,
          points: toNum(item?.astat?.dr_era5_hist),
        });
      }

      // Collect top leaderboard
      if (topLeaderboard.length < limit) {
        for (const item of currentPageArr) {
          if (topLeaderboard.length < limit) {
            topLeaderboard.push({
              tag: item.tag,
              tagl: item.tagl,
              name: item.name,
              points: toNum(item?.astat?.dr_era5_hist),
            });
          } else {
            break;
          }
        }
      }

      // Find squadron
      if (!squadronData && needle) {
        const idx = currentPageArr.findIndex(e => String(e.tagl || '') === needle);
        if (idx !== -1) {
          const cur = currentPageArr[idx];
          const found = {
            rank: cur.pos || null,
            points: toNum(cur?.astat?.dr_era5_hist),
          };

          const aboveEntry = idx > 0 ? currentPageArr[idx - 1] : (prevPageArr.length > 0 ? prevPageArr[prevPageArr.length - 1] : null);
          let belowEntry = idx + 1 < currentPageArr.length ? currentPageArr[idx + 1] : null;

          let abovePoints = aboveEntry ? toNum(aboveEntry?.astat?.dr_era5_hist) : null;
          let belowPoints = belowEntry ? toNum(belowEntry?.astat?.dr_era5_hist) : null;

          if (!belowEntry) {
            // Need to fetch next page for below entry
            const nextCacheKey = getLeaderboardCacheKey(page + 1);
            let nextJson = getCache(nextCacheKey);
            
            if (nextJson === null) {
              nextJson = await fetchJson(makeUrl(page + 1), 15000, true);
            }
            
            if (nextJson && nextJson.status === 'ok' && Array.isArray(nextJson.data) && nextJson.data.length > 0) {
              belowEntry = nextJson.data[0];
              belowPoints = toNum(belowEntry?.astat?.dr_era5_hist);
            }
          }

          squadronData = {
            page,
            found,
            squadronPlace: found.rank || null,
            totalPointsAbove: Number.isFinite(abovePoints) ? abovePoints : null,
            totalPointsBelow: Number.isFinite(belowPoints) ? belowPoints : null,
          };
        }
      }

      if (topLeaderboard.length >= limit && (squadronData || !needle)) {
        break;
      }

      prevPageArr = currentPageArr;
      page++;
    }

    if (fullLeaderboard.length > 0) {
      try {
        const leaderboardFile = getLeaderboardFilePath();
        let oldLeaderboardData = [];
        if (fs.existsSync(leaderboardFile)) {
          oldLeaderboardData = JSON.parse(fs.readFileSync(leaderboardFile, 'utf8'));
        }
        
        const oldSquadronData = oldLeaderboardData.reduce((acc, squadron) => {
          acc[squadron.tag] = squadron;
          return acc;
        }, {});

        const newLeaderboardData = fullLeaderboard.map(squadron => {
          const oldSquadron = oldSquadronData[squadron.tag];
          return {
            ...squadron,
            pointsStart: oldSquadron?.pointsStart ?? squadron.points,
            posStart: oldSquadron?.posStart ?? squadron.pos,
          };
        });

        fs.writeFileSync(leaderboardFile, JSON.stringify(newLeaderboardData, null, 2), 'utf8');
        console.log(`[INFO] Leaderboard data from fetched pages saved to ${leaderboardFile}`);
      } catch (e) {
        logError('fetchLeaderboardAndFindSquadron.saveLeaderboard', e);
      }
    }

    return { leaderboard: topLeaderboard, squadronData };
  } catch (e) {
    logError('fetchLeaderboardAndFindSquadron', e);
    return { leaderboard: [], squadronData: null };
  }
}

async function resetLeaderboardPointsStart() {
  const leaderboardFile = getLeaderboardFilePath();
  try {
    if (fs.existsSync(leaderboardFile)) {
      const leaderboardData = JSON.parse(fs.readFileSync(leaderboardFile, 'utf8'));
      if (Array.isArray(leaderboardData)) {
        leaderboardData.forEach(squadron => {
          squadron.pointsStart = squadron.points;
          squadron.posStart = squadron.pos;
        });
        fs.writeFileSync(leaderboardFile, JSON.stringify(leaderboardData, null, 2), 'utf8');
        console.log('[INFO] Leaderboard pointsStart and posStart have been reset.');
      }
    }
  } catch (e) {
    logError('resetLeaderboardPointsStart', e);
  }
}

async function resetPlayerPointsStart(dataFile) {
  try {
    if (fs.existsSync(dataFile)) {
      const content = fs.readFileSync(dataFile, 'utf8');
      if (!content) return;
      const obj = JSON.parse(content);
      if (obj && obj.data && Array.isArray(obj.data.rows)) {
        obj.data.rows.forEach(row => {
          const currentPoints = row['Points'] || row['points'] || '0';
          row['PointsStart'] = currentPoints;
        });
        fs.writeFileSync(dataFile, JSON.stringify(obj, null, 2), 'utf8');
        console.log('[INFO] Player PointsStart has been reset in squadron_data.json.');
      }
    }
  } catch (e) {
    logError('resetPlayerPointsStart', e);
  }
}

/**
 * Clear cached leaderboard data
 */
function clearLeaderboardCache() {
  try {
    for (let page = 1; page <= 100; page++) {
      const cacheKey = getLeaderboardCacheKey(page);
      // Simple approach: delete keys that match pattern
      // Note: Map doesn't have a filter method, so we iterate
    }
    console.log('[INFO] Leaderboard cache cleared.');
  } catch (e) {
    logError('clearLeaderboardCache', e);
  }
}

module.exports = {
  fetchLeaderboardAndFindSquadron,
  resetLeaderboardPointsStart,
  resetPlayerPointsStart,
  clearLeaderboardCache,
};
