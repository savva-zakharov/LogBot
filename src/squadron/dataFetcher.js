// src/squadron/dataFetcher.js
// Handles fetching and parsing squadron data from HTML and JSON sources

const https = require('https');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const DEFAULT_TIMEOUT_MS = 15_000;

const HTML_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
};

// Lazy-loaded Discord send function
let __discordSendChecked = false;
let __discordSendFn = null;

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
 * Fetch JSON from URL
 * @param {string} url - URL to fetch
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Object|null>} Parsed JSON or null
 */
function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  console.log(`ℹ️ fetchJson: fetching ${url}`);
  return new Promise((resolve) => {
    const req = https.get(url, res => {
      if (res.statusCode !== 200) {
        console.warn(`⚠️ fetchJson: non-200 status code (${res.statusCode}) for ${url}`);
        try {
          const send = getDiscordSend();
          if (typeof send === 'function') send(`fetchJson: non-200 (${res.statusCode}) for ${url}`);
        } catch (_) {}
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error(`⚠️ fetchJson: JSON parse failed for ${url}. Error: ${e.message}.`);
          console.error(`Raw data received: ${data.slice(0, 500)}...`);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      console.error(`⚠️ fetchJson: request error for ${url}:`, e);
      resolve(null);
    });
    req.setTimeout(timeoutMs, () => {
      console.warn(`⚠️ fetchJson: request timed out after ${timeoutMs}ms for ${url}`);
      try { req.destroy(); } catch (_) {}
      resolve(null);
    });
  });
}

/**
 * Fetch text/HTML from URL
 * @param {string} url - URL to fetch
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<string|null>} Text content or null
 */
function fetchText(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const options = new URL(url);
    options.method = 'GET';
    options.headers = HTML_REQUEST_HEADERS;
    const req = https.get(options, res => {
      if (res.statusCode !== 200) {
        console.warn(`⚠️ fetchText: non-200 (${res.statusCode}) for ${url}`);
        try {
          const send = getDiscordSend();
          if (typeof send === 'function') send(`fetchText: non-200 (${res.statusCode}) for ${url}`);
        } catch (_) {}
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log(`ℹ️ fetchText: received ${data.length} chars from ${url}`);
        resolve(data);
      });
    });
    req.on('error', (e) => { 
      console.warn(`⚠️ fetchText error for ${url}:`, e && e.message ? e.message : e); 
      resolve(null); 
    });
    req.setTimeout(timeoutMs, () => { 
      try { req.destroy(); } catch (_) {} 
      resolve(null); 
    });
  });
}

/**
 * Parse total points from HTML
 * @param {string} html - HTML content
 * @returns {Object} Object with totalPoints and place
 */
function parseTotalPointsFromHtml(html) {
  try {
    const $ = cheerio.load(html);
    let totalPoints = null;
    let place = null;

    // Preferred: exact selector
    try {
      const selText = $('div.squadrons-counter__item:nth-child(1) > div:nth-child(2)').first().text().trim();
      if (selText) {
        const num = Number((selText || '').replace(/[^\d]/g, ''));
        if (Number.isFinite(num) && num > 0) totalPoints = num;
      }
    } catch (_) {}

    // Look for "Total points" label
    const labelCandidates = $('*:contains("Total points")').filter(function() {
      return /total\s*points/i.test($(this).text());
    });
    labelCandidates.each((_, el) => {
      if (totalPoints != null) return;
      const txt = $(el).text();
      const m = txt && txt.match(/total\s*points[^\d]*([\d\s,\.]+)/i);
      if (m && m[1]) {
        const num = Number((m[1] || '').replace(/[^\d]/g, ''));
        if (Number.isFinite(num)) totalPoints = num;
      }
      if (totalPoints == null) {
        $(el).children().add($(el).next()).each((__, sib) => {
          if (totalPoints != null) return;
          const t2 = $(sib).text();
          const m2 = t2 && t2.match(/([\d\s,\.]{3,})/);
          if (m2 && m2[1]) {
            const num2 = Number((m2[1] || '').replace(/[^\d]/g, ''));
            if (Number.isFinite(num2)) totalPoints = num2;
          }
        });
      }
    });

    // Heuristic: find large number near "points"
    if (totalPoints == null) {
      const candidates = [];
      $('*').each((_, el) => {
        const t = ($(el).text() || '').trim();
        if (!t) return;
        if (/points?/i.test(t)) candidates.push(t);
      });
      for (const t of candidates) {
        const m = t.match(/([\d\s,\.]{4,})/);
        if (m && m[1]) {
          const num = Number((m[1] || '').replace(/[^\d]/g, ''));
          if (Number.isFinite(num) && num > 0) { totalPoints = num; break; }
        }
      }
    }

    // Extract place
    const placeText = $('*:contains("Place")').filter(function() { return /place/i.test($(this).text()); }).first().text();
    if (placeText) {
      const pm = placeText.match(/place[^\d]*(\d+)/i);
      if (pm && pm[1]) {
        const n = Number(pm[1]);
        if (Number.isFinite(n)) place = n;
      }
    }

    return { totalPoints, place };
  } catch (_) { return { totalPoints: null, place: null }; }
}

/**
 * Parse squadron data from HTML using cheerio
 * @param {string} html - HTML content
 * @returns {Object} Object with headers and rows
 */
function parseSquadronWithCheerio(html) {
  try {
    const $ = cheerio.load(html);
    
    // Prefer semantic table if present
    const tableContainer = $('div.squadrons-members__table');
    if (tableContainer.length) {
      const table = tableContainer.find('table');
      if (table.length) {
        const headers = [];
        table.find('thead th').each((_, th) => headers.push($(th).text().trim()));
        const rows = [];
        table.find('tbody tr').each((_, tr) => {
          const obj = {};
          $(tr).children().each((i, td) => {
            const key = headers[i] || `col_${i}`;
            obj[key] = $(td).text().trim();
          });
          if (Object.keys(obj).length) rows.push(obj);
        });
        console.log(`ℹ️ Cheerio: table detected. headers=${headers.length}, rows=${rows.length}`);
        if (rows.length) return { headers, rows };
      }
    }

    // Fallback: parse grid items
    const container = $('div.squadrons-profile__body.squadrons-members');
    const items = container.find('div.squadrons-members__grid-item');
    const nodes = Array.from(items);
    console.log(`ℹ️ Cheerio: grid container found=${container.length > 0}, grid-items=${nodes.length}`);
    const rows = [];
    const take = (el) => ($(el).text() || '').trim();
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    let start = 0;
    if (nodes.length >= 6) {
      const headers = [0,1,2,3,4,5].map(i => norm(take(nodes[i])));
      const expected = ['num.','player','personalclanrating','activity','role','dateofentry'].map(x => norm(x));
      const isHeader = headers.every((v, idx) => v === expected[idx]);
      if (isHeader) {
        start = 6;
        console.log('ℹ️ Cheerio: header row detected and skipped');
      } else {
        console.log('ℹ️ Cheerio: header row NOT detected');
      }
    }
    for (let i = start; i + 5 < nodes.length; i += 6) {
      const numRaw = take(nodes[i]);
      const nameEl = $(nodes[i + 1]);
      const link = nameEl.find('a[href*="userinfo/?nick="]');
      let player = '';
      if (link.length) {
        player = (link.text() || '').trim();
        if (!player) {
          const href = link.attr('href') || '';
          player = href.replace(/.*nick=/, '').trim();
        }
      } else {
        player = take(nodes[i + 1]);
      }
      const ratingRaw = take(nodes[i + 2]);
      const activityRaw = take(nodes[i + 3]);
      const roleRaw = take(nodes[i + 4]);
      const dateRaw = take(nodes[i + 5]);

      const num = numRaw.replace(/\D+/g, '') || String(rows.length + 1);
      const rating = ratingRaw.replace(/\D+/g, '') || '0';
      const activity = activityRaw.replace(/\D+/g, '') || activityRaw || '';
      const role = roleRaw || '';
      const date = dateRaw || '';

      if (player) {
        rows.push({
          'num.': num,
          'Player': player,
          'Points': rating,
          'Activity': activity,
          'Role': role,
          'Date of entry': date,
        });
      }
    }
    console.log(`ℹ️ Cheerio: parsed member rows=${rows.length}`);
    return { headers: ['num.', 'Player', 'Points', 'Activity', 'Role', 'Date of entry'], rows };
  } catch (_) {
    console.warn('⚠️ Cheerio: parse error');
    return { headers: [], rows: [] };
  }
}

/**
 * Convert value to number
 * @param {any} val - Value to convert
 * @returns {number} Numeric value
 */
function toNum(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}

/**
 * Ensure tmp directory exists
 * @returns {string} Path to tmp directory
 */
function ensureTmpDir() {
  const dir = path.join(process.cwd(), '.tmp');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

/**
 * Fetch leaderboard and find squadron
 * @param {string} primaryTag - Squadron tag to find
 * @param {number} pageSize - Page size for API
 * @returns {Promise<Object>} Leaderboard and squadron data
 */
async function fetchLeaderboardAndFindSquadron(primaryTag, pageSize = 20) {
  // This is a placeholder - implementation depends on your API structure
  // You'll need to adapt this based on your actual API endpoints
  const baseUrl = 'https://wtstats.ru/api/v1/squadronBattles/leaderboard';
  const url = `${baseUrl}?pageSize=${pageSize}`;
  
  const data = await fetchJson(url);
  if (!data) return { leaderboard: null, squadronData: null };
  
  const leaderboard = data.leaderboard || [];
  let squadronData = null;
  
  if (primaryTag) {
    squadronData = leaderboard.find(s => s.tag === primaryTag) || null;
  }
  
  return { leaderboard, squadronData };
}

module.exports = {
  fetchJson,
  fetchText,
  parseTotalPointsFromHtml,
  parseSquadronWithCheerio,
  toNum,
  ensureTmpDir,
  fetchLeaderboardAndFindSquadron,
  DEFAULT_TIMEOUT_MS,
  HTML_REQUEST_HEADERS,
};
