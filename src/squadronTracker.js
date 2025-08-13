// src/squadronTracker.js
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const { loadSettings } = require('./config');
const squadAPI = require('./squadronAPI');
const squadHTML = require('./squadronHTML');
const squadPup = require('./squadronPuppeteer');
const squadPupCore = require('./squadronPuppeteerCore');
const { normalizeTag, toNum } = require('./squadronUtils');

// Lazy accessor to avoid circular dependency at module load
function getDiscordSend() {
  try {
    const mod = require('./discordBot');
    return typeof mod.sendMessage === 'function' ? mod.sendMessage : null;
  } catch (_) { return null; }
}

// Unified squadron members parsing using HTML -> Puppeteer -> Puppeteer-core
async function parseSquadronMembersUnified(url) {
  const parseOptions = {
    tableSelector: 'div.squadrons-members__table table',
    headerSelector: 'thead th',
    rowSelector: 'tbody tr',
    cellSelector: 'td',
  };
  // Normalize parsed objects to ensure standard keys: 'Player' and 'Personal clan rating'
  const normalizeMembers = (tableObj) => {
    try {
      const headers = Array.isArray(tableObj.headers) ? tableObj.headers : [];
      const rows = Array.isArray(tableObj.rows) ? tableObj.rows : [];
      const hdrLower = headers.map(h => String(h || '').trim().toLowerCase());
      // Heuristics to find rating column
      const isMostlyNumeric = (arr) => {
        if (!arr.length) return false;
        const numish = arr.filter(v => /\d/.test(String(v || ''))).length;
        return numish / arr.length >= 0.7;
      };
      let ratingKey = null;
      // 1) Exact/loose matches
      const candidates = ['personal clan rating', 'rating', 'личный рейтинг клана', 'личный рейтинг'];
      for (const c of candidates) {
        const idx = hdrLower.indexOf(c);
        if (idx !== -1) { ratingKey = headers[idx]; break; }
      }
      // 2) Any header containing 'rating'
      if (!ratingKey) {
        const idx = hdrLower.findIndex(h => h.includes('rating'));
        if (idx !== -1) ratingKey = headers[idx];
      }
      // 3) Fallback: pick the column index that is mostly numeric across rows
      if (!ratingKey && headers.length) {
        const colCount = headers.length;
        let bestIdx = -1, bestScore = -1;
        for (let i = 0; i < colCount; i++) {
          const colVals = rows.map(r => (r[headers[i]] ?? r[`col_${i}`] ?? '')).map(x => String(x));
          const score = colVals.length ? colVals.filter(v => /\d/.test(v)).length / colVals.length : 0;
          if (score > bestScore) { bestScore = score; bestIdx = i; }
        }
        if (bestIdx !== -1 && bestScore >= 0.6) ratingKey = headers[bestIdx];
      }

      // Find Player column
      let playerKey = null;
      const playerCandidates = ['player', 'игрок', 'name', 'nickname'];
      for (const c of playerCandidates) {
        const idx = hdrLower.indexOf(c);
        if (idx !== -1) { playerKey = headers[idx]; break; }
      }
      if (!playerKey && headers.length) {
        // Choose the column with the least digits occurrence as "name" heuristic
        let bestIdx = -1, bestScore = Infinity;
        for (let i = 0; i < headers.length; i++) {
          const colVals = rows.map(r => (r[headers[i]] ?? r[`col_${i}`] ?? '')).map(x => String(x));
          const digitCount = colVals.reduce((acc, v) => acc + (/[0-9]/.test(v) ? 1 : 0), 0);
          if (digitCount < bestScore) { bestScore = digitCount; bestIdx = i; }
        }
        if (bestIdx !== -1) playerKey = headers[bestIdx];
      }

      const normalizedRows = rows.map((r) => {
        const obj = { ...r };
        if (ratingKey && obj['Personal clan rating'] == null) obj['Personal clan rating'] = String(r[ratingKey] ?? '').replace(/\s+/g, '');
        if (playerKey && obj['Player'] == null) obj['Player'] = String(r[playerKey] ?? '').trim();
        return obj;
      });

      const haveRatings = normalizedRows.filter(r => /\d/.test(String(r['Personal clan rating'] || ''))).length;
      if (ratingKey) {
        console.log(`ℹ️ Members normalize: rating column='${ratingKey}' mapped to 'Personal clan rating' (${haveRatings}/${normalizedRows.length} numeric).`);
      } else {
        console.warn('⚠️ Members normalize: rating column not detected. Manual points may be unavailable.');
      }
      if (playerKey) {
        console.log(`ℹ️ Members normalize: player column='${playerKey}' mapped to 'Player'.`);
      }

      // Ensure headers include canonical names
      const newHeadersSet = new Set(headers);
      if (!newHeadersSet.has('Personal clan rating')) newHeadersSet.add('Personal clan rating');
      if (!newHeadersSet.has('Player')) newHeadersSet.add('Player');
      const newHeaders = Array.from(newHeadersSet);
      return { headers: newHeaders, rows: normalizedRows };
    } catch (_) {
      return tableObj;
    }
  };
  const toObjects = (headers, rows) => {
    const hdrs = Array.isArray(headers) ? headers.map(h => String(h || '').trim()) : [];
    const objs = [];
    for (const r of rows || []) {
      const cells = Array.isArray(r.cells) ? r.cells : [];
      const obj = {};
      for (let i = 0; i < cells.length; i++) {
        const key = hdrs[i] || `col_${i}`;
        obj[key] = String(cells[i] ?? '').trim();
      }
      if (Object.keys(obj).length) objs.push(obj);
    }
    return { headers: hdrs, rows: objs };
  };

  // 1) HTML
  try {
    console.log('🔎 Members unified: trying HTML parsing...');
    const h = await squadHTML.parseSquadronPage(url, parseOptions);
    if (h && h.ok && h.rows && h.rows.length) {
      console.log(`✅ Members unified: HTML succeeded with ${h.rows.length} rows.`);
      const out = toObjects(h.headers, h.rows);
      const norm = normalizeMembers(out);
      norm.source = 'html';
      return norm;
    }
    if (h && h.blocked) { console.warn('⛔ Members unified: HTML indicates 403/blocked, escalating to Puppeteer.'); }
  } catch (e) { try { console.warn('⚠️ Unified: HTML members parse failed:', e.message || e); } catch (_) {} }

  // 2) Puppeteer
  try {
    console.log('🔎 Members unified: trying Puppeteer parsing...');
    const p = await squadPup.parseSquadronPage(url, parseOptions);
    if (p && p.ok && p.rows && p.rows.length) {
      console.log(`✅ Members unified: Puppeteer succeeded with ${p.rows.length} rows.`);
      const out = toObjects(p.headers, p.rows);
      const norm = normalizeMembers(out);
      norm.source = 'puppeteer';
      return norm;
    }
  } catch (e) { try { console.warn('⚠️ Unified: Puppeteer members parse failed:', e.message || e); } catch (_) {} }

  // 3) Puppeteer-core
  try {
    console.log('🔎 Members unified: trying Puppeteer-core parsing...');
    const pc = await squadPupCore.parseSquadronPage(url, parseOptions);
    if (pc && pc.ok && pc.rows && pc.rows.length) {
      console.log(`✅ Members unified: Puppeteer-core succeeded with ${pc.rows.length} rows.`);
      const out = toObjects(pc.headers, pc.rows);
      const norm = normalizeMembers(out);
      norm.source = 'puppeteer-core';
      return norm;
    }
  } catch (e) { try { console.warn('⚠️ Unified: Puppeteer-core members parse failed:', e.message || e); } catch (_) {} }
  console.warn('❌ Members unified: all methods failed to produce rows.');
  return { headers: [], rows: [], source: 'none' };
}

// Unified leaderboard search orchestration: API -> HTML -> Puppeteer -> Puppeteer-core
async function findOnLeaderboardUnified(tag) {
  const parseOptions = {
    tableSelector: 'table.leaderboards',
    headerSelector: 'thead th',
    rowSelector: 'tbody tr',
    cellSelector: 'td',
  };
  // 1) API
  try {
    console.log('🔎 Unified leaderboard: trying API...');
    const api = await squadAPI.searchLeaderboard(tag, {});
    if (api && api.ok && typeof api.matchIndex === 'number') {
      const r = api.rows[api.matchIndex] || {};
      const cells = r.cells || [];
      const place = Number.parseInt((cells[0] || '').replace(/[^0-9]/g, ''), 10) || null;
      const points = Number.parseInt((cells[2] || '').replace(/[^0-9]/g, ''), 10) || null;
      // Neighbors on the same page (best-effort)
      const rows = api.rows || [];
      const above = rows.slice(0, api.matchIndex).reduce((acc, x) => acc + (Number.parseInt(((x.cells||[])[2]||'').replace(/[^0-9]/g,''),10)||0), 0);
      const below = rows.slice(api.matchIndex+1).reduce((acc, x) => acc + (Number.parseInt(((x.cells||[])[2]||'').replace(/[^0-9]/g,''),10)||0), 0);
      console.log(`✅ Unified leaderboard: API matched. place=${place}, points=${points}`);
      return { source: 'api', squadronPlace: place, totalPointsAbove: above, totalPointsBelow: below, found: { points } };
    }
    console.log('➡️ Unified leaderboard: API did not match. Falling back to HTML...');
  } catch (e) { try { console.warn('⚠️ Unified: API step failed:', e.message || e); } catch (_) {} }
  // 2) HTML
  try {
    console.log('🔎 Unified leaderboard: trying HTML...');
    const html = await squadHTML.searchLeaderboard(tag, { parseOptions });
    if (html && html.ok && typeof html.matchIndex === 'number') {
      const r = html.rows[html.matchIndex] || {};
      const cells = r.cells || [];
      const place = Number.parseInt((cells[0] || '').replace(/[^0-9]/g, ''), 10) || null;
      const points = Number.parseInt((cells[2] || '').replace(/[^0-9]/g, ''), 10) || null;
      const rows = html.rows || [];
      const above = rows.slice(0, html.matchIndex).reduce((acc, x) => acc + (Number.parseInt(((x.cells||[])[2]||'').replace(/[^0-9]/g,''),10)||0), 0);
      const below = rows.slice(html.matchIndex+1).reduce((acc, x) => acc + (Number.parseInt(((x.cells||[])[2]||'').replace(/[^0-9]/g,''),10)||0), 0);
      console.log(`✅ Unified leaderboard: HTML matched. place=${place}, points=${points}`);
      return { source: 'html', squadronPlace: place, totalPointsAbove: above, totalPointsBelow: below, found: { points } };
    }
    if (html && html.blocked) console.warn('⛔ Unified leaderboard: HTML indicates 403/blocked. Escalating to Puppeteer.');
    else console.log('➡️ Unified leaderboard: HTML did not match. Falling back to Puppeteer...');
  } catch (e) { try { console.warn('⚠️ Unified: HTML step failed:', e.message || e); } catch (_) {} }
  // 3) Puppeteer
  try {
    console.log('🔎 Unified leaderboard: trying Puppeteer...');
    const pup = await squadPup.searchLeaderboard(tag, { parseOptions });
    if (pup && pup.ok && typeof pup.matchIndex === 'number') {
      const r = pup.rows[pup.matchIndex] || {};
      const cells = r.cells || [];
      const place = Number.parseInt((cells[0] || '').replace(/[^0-9]/g, ''), 10) || null;
      const points = Number.parseInt((cells[2] || '').replace(/[^0-9]/g, ''), 10) || null;
      const rows = pup.rows || [];
      const above = rows.slice(0, pup.matchIndex).reduce((acc, x) => acc + (Number.parseInt(((x.cells||[])[2]||'').replace(/[^0-9]/g,''),10)||0), 0);
      const below = rows.slice(pup.matchIndex+1).reduce((acc, x) => acc + (Number.parseInt(((x.cells||[])[2]||'').replace(/[^0-9]/g,''),10)||0), 0);
      console.log(`✅ Unified leaderboard: Puppeteer matched. place=${place}, points=${points}`);
      return { source: 'puppeteer', squadronPlace: place, totalPointsAbove: above, totalPointsBelow: below, found: { points } };
    }
    console.log('➡️ Unified leaderboard: Puppeteer did not match. Falling back to Puppeteer-core...');
  } catch (e) { try { console.warn('⚠️ Unified: Puppeteer step failed:', e.message || e); } catch (_) {} }
  // 4) Puppeteer-core
  try {
    console.log('🔎 Unified leaderboard: trying Puppeteer-core...');
    const pupc = await squadPupCore.searchLeaderboard(tag, { parseOptions });
    if (pupc && pupc.ok && typeof pupc.matchIndex === 'number') {
      const r = pupc.rows[pupc.matchIndex] || {};
      const cells = r.cells || [];
      const place = Number.parseInt((cells[0] || '').replace(/[^0-9]/g, ''), 10) || null;
      const points = Number.parseInt((cells[2] || '').replace(/[^0-9]/g, ''), 10) || null;
      const rows = pupc.rows || [];
      const above = rows.slice(0, pupc.matchIndex).reduce((acc, x) => acc + (Number.parseInt(((x.cells||[])[2]||'').replace(/[^0-9]/g,''),10)||0), 0);
      const below = rows.slice(pupc.matchIndex+1).reduce((acc, x) => acc + (Number.parseInt(((x.cells||[])[2]||'').replace(/[^0-9]/g,''),10)||0), 0);
      console.log(`✅ Unified leaderboard: Puppeteer-core matched. place=${place}, points=${points}`);
      return { source: 'puppeteer-core', squadronPlace: place, totalPointsAbove: above, totalPointsBelow: below, found: { points } };
    }
  } catch (e) { try { console.warn('⚠️ Unified: Puppeteer-core step failed:', e.message || e); } catch (_) {} }
  return null;
}

// --- JSON API based leaderboard fetching (faster and more robust than HTML scraping) ---
function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} resolve(null); });
  });
}

// Variant that returns both status and body to allow 403 handling
function fetchTextWithStatus(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const options = new URL(url);
    options.method = 'GET';
    options.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
    };
    const req = https.get(options, res => {
      const status = res.statusCode || 0;
      if (status !== 200) {
        // Drain body and return status without content
        res.resume();
        return resolve({ status, body: null });
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: null }); });
  });
}

// Simple text fetcher (for HTML)
function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const options = new URL(url);
    options.method = 'GET';
    options.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
    };
    const req = https.get(options, res => {
      if (res.statusCode !== 200) {
        console.warn(`⚠️ fetchText: non-200 (${res.statusCode}) for ${url}`);
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
    req.on('error', (e) => { console.warn(`⚠️ fetchText error for ${url}:`, e && e.message ? e.message : e); resolve(null); });
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} resolve(null); });
  });
}

// Parse squadron page HTML using cheerio (no JS execution)
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

    // Fallback: parse grid items in the profile body using 6-item grouping per member
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
          'Personal clan rating': rating,
          'Activity': activity,
          'Role': role,
          'Date of entry': date,
        });
      }
    }
    console.log(`ℹ️ Cheerio: parsed member rows=${rows.length}`);
    return { headers: ['num.', 'Player', 'Personal clan rating', 'Activity', 'Role', 'Date of entry'], rows };
  } catch (_) {
    console.warn('⚠️ Cheerio: parse error');
    return { headers: [], rows: [] };
  }
}

// use toNum from squadronUtils

// --- HTML-based leaderboard scraping (fallback when JSON API breaks) ---

function parseLeaderboardListing(html) {
  try {
    const $ = cheerio.load(html);
    let rows = [];
    const table = $('table.leaderboards');
    if (table && table.length) {
      table.find('tbody tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length >= 2) {
          const rankStr = $(tds[0]).text().trim();
          const r = parseInt(rankStr.replace(/[^0-9]/g, ''), 10);
          const nameCell = $(tds[1]);
          const text = nameCell.text().trim();
          const a = nameCell.find('a[href]').first();
          const href = a.length ? a.attr('href') : null;
          if (Number.isFinite(r) && text) rows.push({ rank: r, text, href });
        }
      });
    }
    if (!rows.length) {
      $('tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length >= 2) {
          const rankStr = $(tds[0]).text().trim();
          const r = parseInt(rankStr.replace(/[^0-9]/g, ''), 10);
          const nameCell = $(tds[1]);
          const text = nameCell.text().trim();
          const a = nameCell.find('a[href]').first();
          const href = a.length ? a.attr('href') : null;
          if (Number.isFinite(r) && text) rows.push({ rank: r, text, href });
        }
      });
    }
    rows.sort((a, b) => a.rank - b.rank);
    return rows;
  } catch (_) {
    return [];
  }
}

async function findOnLeaderboardViaHtml(tag) {
  const base = 'https://warthunder.com/en/community/clansleaderboard';
  const needle = normalizeTag(tag);
  if (!needle) return null;
  console.log(`🔎 HTML fallback: start search for tag='${tag}' (needle='${needle}')`);
  const maxPages = 50;
  for (let p = 1; p <= maxPages; p++) {
    const candidates = [];
    if (p === 1) {
      candidates.push(base);
    } else {
      candidates.push(`${base}/page/${p}/`);
    }
    for (const url of candidates) {
      console.log(`🌐 HTML fetch: GET ${url}`);
      const { status, body } = await fetchTextWithStatus(url, 15000);
      if (status === 403) {
        console.warn(`⚠️ leaderboard(HTML): received 403 for ${url}, stopping further HTML requests and switching to Puppeteer fallback.`);
        const puppeted = await findOnLeaderboardViaPuppeteer(tag);
        return puppeted; // may be null if puppeteer not available
      }
      if (status !== 200 || !body) {
        console.warn(`⚠️ HTML fetch: non-200 (${status}) or empty body for ${url}`);
        continue;
      }
      const rows = parseLeaderboardListing(body);
      console.log(`ℹ️ HTML parse: page=${p} rows=${rows.length}`);
      if (!rows.length) continue;
      const idx = rows.findIndex(r => normalizeTag(r.text).includes(needle));
      if (idx !== -1) {
        const found = rows[idx];
        const above = idx > 0 ? rows[idx - 1] : null;
        const below = idx + 1 < rows.length ? rows[idx + 1] : null;
        console.log(`✅ HTML match: tag='${tag}' found at rank=${found.rank} on page=${p}`);
        return {
          page: p,
          url,
          found,
          above,
          below,
          squadronPlace: found.rank,
          totalPointsAbove: null,
          totalPointsBelow: null,
        };
      }
      console.log(`↩️ HTML page ${p}: not found, continue`);
    }
  }
  console.log(`❌ HTML fallback: tag='${tag}' not found within ${maxPages} pages`);
  return null;
}

// Last-resort fallback using Puppeteer to render and scrape when blocked by 403
async function findOnLeaderboardViaPuppeteer(tag) {
  const base = 'https://warthunder.com/en/community/clansleaderboard';
  const needle = normalizeTag(tag);
  if (!needle) return null;
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (_) {
    console.warn('⚠️ Puppeteer not installed; cannot perform last-resort scraping.');
    return null;
  }
  let browser;
  try {
    console.log(`🧪 Puppeteer fallback: start search for tag='${tag}' (needle='${needle}')`);
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    const maxPages = 25;
    for (let p = 1; p <= maxPages; p++) {
      const url = p === 1 ? base : `${base}/page/${p}/`;
      try {
        console.log(`🧭 Puppeteer: goto ${url}`);
        const resp = await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });
        try {
          const status = resp ? resp.status() : 'n/a';
          const ct = resp ? (resp.headers()['content-type'] || '') : '';
          console.log(`ℹ️ Puppeteer: response status=${status} content-type='${ct}' for ${url}`);
          if (status === 403) {
            console.warn(`⚠️ Puppeteer: received 403 for ${url}. Aborting further Puppeteer requests.`);
            return null;
          }
        } catch (_) {}
        try { await page.waitForSelector('table.leaderboards', { timeout: 3000 }); } catch (_) {}
      } catch (navErr) { console.warn(`⚠️ Puppeteer: navigation failed for ${url}:`, navErr && navErr.message ? navErr.message : navErr); continue; }
      try {
        const rows = await parseLeaderboardPage(page);
        const norm = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
        console.log(`ℹ️ Puppeteer parse: page=${p} rows=${rows.length}`);
        if (!rows.length) {
          // Collect diagnostics to understand why rows are missing
          try {
            const diag = await page.evaluate(() => {
              const q = (sel) => Array.from(document.querySelectorAll(sel)).length;
              const first = (sel) => {
                const el = document.querySelector(sel);
                return el ? (el.outerHTML || el.innerHTML || '').slice(0, 500) : '';
              };
              const title = document.title;
              const href = location.href;
              const ready = document.readyState;
              const cf = !!document.querySelector('[id*="challenge"], [class*="challenge"], #cf-challenge, .cf-challenge') || !!document.querySelector('form[action*="/cdn-cgi/challenge-platform"]');
              const captcha = !!document.querySelector('iframe[title*="captcha" i], [id*="captcha" i], [class*="captcha" i]');
              const tblCnt = q('table.leaderboards');
              const trCnt = q('table.leaderboards tbody tr');
              const anyTr = q('tr');
              return {
                href, title, ready, cf, captcha,
                counts: { tblCnt, trCnt, anyTr },
                snippet: first('table.leaderboards') || first('body')
              };
            });
            console.log(`🔍 Puppeteer diag page=${p}:`, JSON.stringify(diag));
          } catch (e) { console.warn('⚠️ Puppeteer diag failed:', e && e.message ? e.message : e); }
        }
        rows.sort((a, b) => a.rank - b.rank);
        const idx = rows.findIndex(r => norm(r.text).includes(needle));
        if (idx !== -1) {
          const found = rows[idx];
          const above = idx > 0 ? rows[idx - 1] : null;
          const below = idx + 1 < rows.length ? rows[idx + 1] : null;
          console.log(`✅ Puppeteer match: tag='${tag}' found at rank=${found.rank} on page=${p}`);
          return { page: p, url, found, above, below, squadronPlace: found.rank, totalPointsAbove: null, totalPointsBelow: null };
        }
      } catch (evalErr) { console.warn(`⚠️ Puppeteer: parse/eval failed on ${url}:`, evalErr && evalErr.message ? evalErr.message : evalErr); }
    }
    console.log(`❌ Puppeteer fallback: tag='${tag}' not found within ${maxPages} pages`);
  } catch (e) {
    console.warn('⚠️ Puppeteer fallback failed:', e && e.message ? e.message : e);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
  }
  return null;
}

async function findOnLeaderboardViaApi(tag) {
  try {
    const needle = String(tag || '').trim().toLowerCase();
    if (!needle) return null;
    console.log(`🚀 API primary: start search for tag='${tag}' (needle='${needle}')`);
    const makeUrl = (page) => `https://warthunder.com/en/community/getclansleaderboard/dif/_hist/page/${page}/sort/dr_era5`;
    let page = 1;
    const MAX_PAGES = 100; // sensible cap
    while (page <= MAX_PAGES) {
      console.log(`🌐 API fetch: page=${page}`);
      const json = await fetchJson(makeUrl(page));
      if (!json || json.status !== 'ok') {
        console.warn(`⚠️ API error/invalid response on page=${page}. Falling back to HTML, then Puppeteer if needed.`);
        // Fallback: site JSON may be broken; try full HTML fetch instead
        try {
          const htmlRes = await findOnLeaderboardViaHtml(tag);
          if (htmlRes) {
            return {
              page: htmlRes.page,
              found: htmlRes.found,
              squadronPlace: htmlRes.squadronPlace ?? (htmlRes.found ? htmlRes.found.rank : null),
              totalPointsAbove: htmlRes.totalPointsAbove ?? null,
              totalPointsBelow: htmlRes.totalPointsBelow ?? null,
            };
          }
          console.warn('ℹ️ HTML fallback returned null; trying Puppeteer last-resort.');
          const pup = await findOnLeaderboardViaPuppeteer(tag);
          if (pup) return pup;
        } catch (e) { console.warn('⚠️ Fallback error after API failure:', e && e.message ? e.message : e); }
        break;
      }
      const arr = Array.isArray(json.data) ? json.data : [];
      if (!arr.length) {
        console.warn(`⚠️ API empty data on page=${page}. Falling back to HTML, then Puppeteer if needed.`);
        // Fallback: empty data; try HTML scraping
        try {
          const htmlRes = await findOnLeaderboardViaHtml(tag);
          if (htmlRes) {
            return {
              page: htmlRes.page,
              found: htmlRes.found,
              squadronPlace: htmlRes.squadronPlace ?? (htmlRes.found ? htmlRes.found.rank : null),
              totalPointsAbove: htmlRes.totalPointsAbove ?? null,
              totalPointsBelow: htmlRes.totalPointsBelow ?? null,
            };
          }
          console.warn('ℹ️ HTML fallback returned null; trying Puppeteer last-resort.');
          const pup = await findOnLeaderboardViaPuppeteer(tag);
          if (pup) return pup;
        } catch (e) { console.warn('⚠️ Fallback error after empty API data:', e && e.message ? e.message : e); }
        break;
      }
      const idx = arr.findIndex(e => String(e.tagl || '').toLowerCase() === needle);
      if (idx !== -1) {
        const cur = arr[idx];
        const found = {
          rank: cur.pos || null,
          points: toNum(cur?.astat?.dr_era5_hist),
        };
        // neighbors on same page
        const aboveEntry = idx > 0 ? arr[idx - 1] : null;
        const belowEntry = idx + 1 < arr.length ? arr[idx + 1] : null;
        let abovePoints = aboveEntry ? toNum(aboveEntry?.astat?.dr_era5_hist) : null;
        let belowPoints = belowEntry ? toNum(belowEntry?.astat?.dr_era5_hist) : null;
        // cross-page neighbors if needed
        if (!aboveEntry && page > 1) {
          const prev = await fetchJson(makeUrl(page - 1));
          const prevArr = prev && prev.status === 'ok' && Array.isArray(prev.data) ? prev.data : [];
          if (prevArr.length) abovePoints = toNum(prevArr[prevArr.length - 1]?.astat?.dr_era5_hist);
        }
        if (!belowEntry && arr.length > 0) {
          const next = await fetchJson(makeUrl(page + 1));
          const nextArr = next && next.status === 'ok' && Array.isArray(next.data) ? next.data : [];
          if (nextArr.length) belowPoints = toNum(nextArr[0]?.astat?.dr_era5_hist);
        }
        return {
          page,
          found,
          squadronPlace: found.rank || null,
          totalPointsAbove: Number.isFinite(abovePoints) ? abovePoints : null,
          totalPointsBelow: Number.isFinite(belowPoints) ? belowPoints : null,
        };
      }
      page++;
    }
    // Final fallback if loop completes without finding/returning
    try {
      console.log('🔁 API loop finished without match. Trying HTML fallback, then Puppeteer.');
      const htmlRes = await findOnLeaderboardViaHtml(tag);
      if (htmlRes) {
        return {
          page: htmlRes.page,
          found: htmlRes.found,
          squadronPlace: htmlRes.squadronPlace ?? (htmlRes.found ? htmlRes.found.rank : null),
          totalPointsAbove: htmlRes.totalPointsAbove ?? null,
          totalPointsBelow: htmlRes.totalPointsBelow ?? null,
        };
      }
      const pup = await findOnLeaderboardViaPuppeteer(tag);
      if (pup) return pup;
    } catch (e) { console.warn('⚠️ Final fallback sequence failed:', e && e.message ? e.message : e); }
  } catch (_) {}
  return null;
}

// Try to infer squadron tag from the current squadron page (from header/title)
async function extractSquadronTagFromPage(page) {
  try {
    const raw = await page.evaluate(() => {
      const pieces = [];
      const sel = [
        'h1',
        '.squadrons__title',
        '.squadrons-members__title',
        '.squadrons__header',
        'title'
      ];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el && el.textContent) pieces.push(el.textContent.trim());
      }
      return pieces.join(' | ');
    });
    const text = String(raw || '');
    // Look for a tag-like token (letters/numbers) possibly wrapped by symbols
    const tokens = text.split(/\s+/);
    for (const t of tokens) {
      const mid = t.replace(/[^A-Za-z0-9]/g, '');
      if (mid.length >= 2 && mid.length <= 8) {
        return mid; // plausible tag
      }
    }
  } catch (_) {}
  return '';
}

// Read leaderboard rows from the canonical table if present
async function parseLeaderboardPage(page) {
  return await page.evaluate(() => {
    const out = [];
    const push = (rank, text, href) => out.push({ rank, text, href });
    const table = document.querySelector('table.leaderboards');
    if (table) {
      const trs = Array.from(table.querySelectorAll('tbody tr'));
      for (const tr of trs) {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length >= 2) {
          const rankStr = (tds[0].innerText || '').trim();
          const nameCell = tds[1];
          const tagText = (nameCell.innerText || '').trim();
          const a = nameCell.querySelector('a[href]');
          const href = a && a.getAttribute('href');
          const r = parseInt(rankStr.replace(/[^0-9]/g, ''), 10);
          if (Number.isFinite(r) && tagText) push(r, tagText, href || null);
        }
      }
      return out;
    }
    // Minimal generic fallback: any table rows on the page
    const trs = Array.from(document.querySelectorAll('tr'));
    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length >= 2) {
        const rankStr = (tds[0].innerText || '').trim();
        const nameCell = tds[1];
        const tagText = (nameCell.innerText || '').trim();
        const a = nameCell.querySelector('a[href]');
        const href = a && a.getAttribute('href');
        const r = parseInt(rankStr.replace(/[^0-9]/g, ''), 10);
        if (Number.isFinite(r) && tagText) push(r, tagText, href || null);
      }
    }
    return out;
  });
}

// Try to locate our squadron in the War Thunder clans leaderboard and collect rank and neighbor links
async function findOnLeaderboard(browser, tag) {
  const base = 'https://warthunder.com/en/community/clansleaderboard';
  // Try both normal and hist type, multiple pages
  const maxPages = 25;
  let lbPage = null;
  try {
    lbPage = await browser.newPage();
    for (let p = 1; p <= maxPages; p++) {
      // Build candidate URLs for this page index
      const candidates = [];
      if (p === 1) {
        candidates.push(base, `${base}/?type=hist`);
      } else {
        candidates.push(`${base}/page/${p}/`, `${base}/page/${p}/?type=hist`);
      }
      for (const url of candidates) {
        try {
          await lbPage.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });
          // Prefer waiting for the specific leaderboard table if present
          try { await lbPage.waitForSelector('table.leaderboards', { timeout: 3000 }); } catch (_) {}
        } catch (_) { continue; }
        // Extract rows: rank, tag text, optional href
        try {
          const rows = await parseLeaderboardPage(lbPage);
          // Normalize and search for tag
          const norm = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
          const needle = norm(tag);
          if (!needle) continue;
          rows.sort((a, b) => a.rank - b.rank);
          const idx = rows.findIndex(r => norm(r.text).includes(needle));
          if (idx !== -1) {
            const found = rows[idx];
            const above = idx > 0 ? rows[idx - 1] : null;
            const below = idx + 1 < rows.length ? rows[idx + 1] : null;
            return { page: p, url, found, above, below };
          }
        } catch (_) {}
      }
    }
  } catch (_) {
    // ignore
  } finally {
    try { if (lbPage) await lbPage.close(); } catch (_) {}
  }
  return null;
}

async function extractPointsFromSquadLink(browser, href) {
  if (!href) return null;
  try {
    const abs = href.startsWith('http') ? href : ('https://warthunder.com' + (href.startsWith('/') ? '' : '/') + href);
    const p = await browser.newPage();
    try {
      await p.goto(abs, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Use the same extractor as for the main squad page
      const total = await extractTotalPoints(p);
      return (typeof total === 'number' && Number.isFinite(total)) ? total : null;
    } finally {
      try { await p.close(); } catch (_) {}
    }
  } catch (_) { return null; }
}

// --- Events logging (mirror Discord messages) ---
function ensureEventsFile() {
  const file = path.join(process.cwd(), 'squadron_events.json');
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8'); } catch (_) {}
  } else {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
        fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8');
      }
    } catch (_) {
      try { fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8'); } catch (_) {}
    }
  }
  return file;
}

function appendEvent(messageOrEvent, meta = {}) {
  try {
    const file = ensureEventsFile();
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(obj.events)) obj.events = [];
    let entry;
    if (messageOrEvent && typeof messageOrEvent === 'object' && !Array.isArray(messageOrEvent)) {
      entry = { ts: new Date().toISOString(), ...messageOrEvent };
    } else {
      entry = { ts: new Date().toISOString(), message: messageOrEvent, ...meta };
    }
    obj.events.push(entry);
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {}
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

function ensureParsedDataFile() {
  const file = path.join(process.cwd(), 'squadron_data.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ squadronSnapshots: [] }, null, 2), 'utf8');
  } else {
    // If exists but not object, coerce
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.squadronSnapshots)) {
        fs.writeFileSync(file, JSON.stringify({ squadronSnapshots: [] }, null, 2), 'utf8');
      }
    } catch (_) {
      fs.writeFileSync(file, JSON.stringify({ squadronSnapshots: [] }, null, 2), 'utf8');
    }
  }
  return file;
}

function calculateManualPoints(rows) {
  try {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    // Normalize and collect Personal clan rating as integers
    const values = rows.map(r => {
      const raw = r['Personal clan rating'] ?? r['personal clan rating'] ?? r['PersonalClanRating'] ?? r['rating'];
      if (raw == null) return null;
      const cleaned = String(raw).replace(/[^0-9]/g, '');
      if (!cleaned) return null;
      const n = parseInt(cleaned, 10);
      return Number.isFinite(n) ? n : null;
    }).filter(v => v != null);
    if (!values.length) return null;
    values.sort((a, b) => b - a);
    const top20 = values.slice(0, 20);
    const rest = values.slice(20);
    const sum = (arr) => arr.reduce((acc, v) => acc + v, 0);
    const topSum = sum(top20);
    const restSum = sum(rest);
    const contribution = rest.length ? (restSum / 20) : 0;
    const total = topSum + contribution;
    // Round to nearest integer to match site display conventions
    return Math.round(total);
  } catch (_) {
    return null;
  }
}

function readLastSnapshot(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(obj.squadronSnapshots) ? obj.squadronSnapshots : [];
    return arr.length ? arr[arr.length - 1] : null;
  } catch (_) { return null; }
}

function appendSnapshot(file, snapshot) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(obj.squadronSnapshots)) obj.squadronSnapshots = [];
    const pruned = pruneSnapshot(snapshot);
    // Overwrite last snapshot if same calendar day, else append
    const toDateKey = (ts) => {
      try { const d = new Date(ts); return `${d.getUTCFullYear()}-${(d.getUTCMonth()+1).toString().padStart(2,'0')}-${d.getUTCDate().toString().padStart(2,'0')}`; } catch (_) { return null; }
    };
    const toUtcMinutes = (ts) => {
      try { const d = new Date(ts); return d.getUTCHours() * 60 + d.getUTCMinutes(); } catch (_) { return null; }
    };
    const CUTOFF_MIN = 23 * 60 + 30; // 23:30 UTC
    const last = obj.squadronSnapshots.length ? obj.squadronSnapshots[obj.squadronSnapshots.length - 1] : null;
    const lastKey = last ? toDateKey(last.ts) : null;
    const curKey = toDateKey(pruned.ts);
    if (last && lastKey && curKey && lastKey === curKey) {
      const lastMin = toUtcMinutes(last.ts);
      const curMin = toUtcMinutes(pruned.ts);
      // Before cutoff: always overwrite today's snapshot
      if (curMin != null && curMin < CUTOFF_MIN) {
        obj.squadronSnapshots[obj.squadronSnapshots.length - 1] = pruned;
      } else if (curMin != null) {
        // At or after cutoff: only overwrite once if previous was before cutoff; otherwise lock (do nothing)
        if (lastMin == null || lastMin < CUTOFF_MIN) {
          obj.squadronSnapshots[obj.squadronSnapshots.length - 1] = pruned;
        } // else: keep the existing post-cutoff snapshot
      }
    } else {
      obj.squadronSnapshots.push(pruned);
    }
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {
    const pruned = pruneSnapshot(snapshot);
    fs.writeFileSync(file, JSON.stringify({ squadronSnapshots: [pruned] }, null, 2), 'utf8');
  }
}

async function extractTotalPoints(page) {
  // Find by tooltip bubble label 'Squadron rating' and extract nearest numeric value
  try {
    const fromLabel = await page.evaluate(() => {
      const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const spans = Array.from(document.querySelectorAll('span.new-tooltip__bubble.new-tooltip__bubble_top-center'));
      const label = spans.find(sp => normalize(sp.textContent).includes('squadron rating'));
      if (!label) return null;
      // Search in parent container for the largest number nearby
      const root = label.parentElement || label;
      let maxNum = null;
      const considerText = (txt) => {
        if (!txt) return;
        const matches = String(txt).match(/\d[\d\s]{2,}/g);
        if (matches) {
          for (const m of matches) {
            const n = parseInt(m.replace(/\s+/g, ''), 10);
            if (!isNaN(n) && (maxNum === null || n > maxNum)) maxNum = n;
          }
        }
      };
      // Nearby candidates: siblings and within parent subtree
      if (root.previousElementSibling) considerText(root.previousElementSibling.textContent);
      if (root.nextElementSibling) considerText(root.nextElementSibling.textContent);
      considerText(root.textContent);
      // Also walk a bit up to grandparent to catch numbers placed adjacent
      const up = root.parentElement || root;
      considerText(up.textContent);
      return maxNum;
    });
    if (typeof fromLabel === 'number' && isFinite(fromLabel)) return fromLabel;
  } catch (_) {}
  return null;
}

async function scrapeTable(page) {
  return await page.evaluate(() => {
    const container = document.querySelector('div.squadrons-members__table');
    if (!container) return { headers: [], rows: [] };

    // First attempt: semantic table
    const table = container.querySelector('table');
    if (table) {
      let headers = [];
      const ths = table.querySelectorAll('thead th');
      if (ths && ths.length) headers = Array.from(ths).map(th => th.textContent.trim());
      const rows = [];
      const trs = table.querySelectorAll('tbody tr');
      Array.from(trs).forEach(tr => {
        const cells = Array.from(tr.children).map(td => td.textContent.trim());
        if (!cells.length) return;
        const obj = {};
        cells.forEach((v, i) => {
          const key = headers[i] || `col_${i}`;
          obj[key] = v;
        });
        rows.push(obj);
      });
      if (rows.length) return { headers, rows };
    }

    // Fallback: tokenization of innerText with 6-column repeating groups
    const text = container.innerText || '';
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // Remove known header labels if present
    const headerLabels = new Set(['num.', 'Player', 'Personal clan rating', 'Activity', 'Role', 'Date of entry']);
    const filtered = lines.filter(l => !headerLabels.has(l));
    const isDate = (s) => /^\d{2}\.\d{2}\.\d{4}$/.test(s);
    const headers = ['num.', 'Player', 'Personal clan rating', 'Activity', 'Role', 'Date of entry'];
    const rows = [];
    // Group by finding date tokens and collecting preceding 5 tokens
    const buf = [];
    for (const token of filtered) {
      buf.push(token);
      // When the latest token looks like a date and we have at least 6 tokens in the current slice, flush a row
      if (isDate(token) && buf.length >= 6) {
        const chunk = buf.slice(-6);
        buf.length = 0; // reset buffer to allow next rows; leftover tokens ignored
        const [num, player, rating, activity, role, date] = chunk;
        // Basic sanity checks: num/rating/activity numeric-like
        const looksNumeric = (x) => /^\d+[\d\s]*$/.test(x);
        if (looksNumeric(num) && looksNumeric(rating) && looksNumeric(activity)) {
          rows.push({
            'num.': num.replace(/\s+/g, ''),
            'Player': player,
            'Personal clan rating': rating.replace(/\s+/g, ''),
            'Activity': activity.replace(/\s+/g, ''),
            'Role': role,
            'Date of entry': date,
          });
        }
      }
    }
    return { headers, rows };
  });
}

function simplifyForComparison(snapshot) {
  // Consider headers, rows, and totalPoints for change detection
  const { headers, rows } = snapshot.data || {};
  const norm = (rows || []).map(r => {
    const obj = {};
    for (const k of Object.keys(r)) obj[k] = r[k];
    return obj;
  });
  const totalPoints = typeof snapshot.totalPoints === 'number' ? snapshot.totalPoints : null;
  return JSON.stringify({ headers, rows: norm, totalPoints });
}

async function startSquadronTracker() {
  const { squadronPageUrl } = loadSettings();
  if (!squadronPageUrl) {
    console.log('ℹ️ Squadron tracker disabled: no SQUADRON_PAGE_URL configured.');
    return { enabled: false };
  }

  const dataFile = ensureParsedDataFile();
  let lastKey = null;
  let lastSnapshot = null;
  let didInitialMembersFetch = false;

  async function captureOnce() {
    // Determine primary squadron tag (from settings or fallback parsing if needed)
    let primaryTag = '';
    try {
      const settings = loadSettings();
      const keys = Object.keys(settings.squadrons || {});
      primaryTag = keys.length ? keys[0] : '';
    } catch (_) {}

    // Initialize leaderboard context (API-first)
    let squadronPlace = null;
    let totalPointsAbove = null;
    let totalPointsBelow = null;
    let apiPoints = null;

    if (primaryTag) {
      const uni = await findOnLeaderboardUnified(primaryTag);
      if (uni) {
        squadronPlace = uni.squadronPlace;
        totalPointsAbove = uni.totalPointsAbove;
        totalPointsBelow = uni.totalPointsBelow;
        apiPoints = uni.found && typeof uni.found.points === 'number' ? uni.found.points : null;
        console.log(`ℹ️ Leaderboard: source=${uni.source || 'unknown'}, place=${squadronPlace}, points=${apiPoints}, above=${totalPointsAbove}, below=${totalPointsBelow}`);
      } else {
        console.log(`[leaderboard] Unified lookup failed or tag not found for "${primaryTag}".`);
      }
    }

    const effectiveTotal = (typeof apiPoints === 'number' && Number.isFinite(apiPoints)) ? apiPoints : null;

    // Prepare minimal snapshot (no members yet)
    let snapshot = {
      ts: Date.now(),
      data: { headers: [], rows: [] },
      totalPoints: effectiveTotal,
      squadronPlace,
      totalPointsAbove,
      totalPointsBelow,
    };

    const key = simplifyForComparison(snapshot);
    if (lastKey === null) {
      // Initialize from existing file
      const last = readLastSnapshot(dataFile);
      if (last) {
        lastKey = simplifyForComparison(last);
        lastSnapshot = last;
      }
    }
    if (key !== lastKey) {
      // Compute diff versus previous snapshot, if available
      try {
        const prev = lastSnapshot || readLastSnapshot(dataFile);
        // Fetch squadron members on every poll using the unified parser
        try {
          const parsedMembers = await parseSquadronMembersUnified(squadronPageUrl);
          if (parsedMembers && Array.isArray(parsedMembers.rows)) {
            snapshot.data = parsedMembers;
            snapshot.membersCaptured = true;
            const ratingsParsed = parsedMembers.rows.filter(r => /\d/.test(String((r['Personal clan rating'] || '').toString()))).length;
            snapshot.ratingsParsed = ratingsParsed;
            const manual = calculateManualPoints(parsedMembers.rows);
            snapshot.manualPoints = manual != null ? manual : null;
            if (manual != null && (snapshot.totalPoints == null)) snapshot.totalPoints = manual;
            console.log(`ℹ️ Members (poll) parsed rows=${parsedMembers.rows.length}, source=${parsedMembers.source || 'unknown'}`);
            console.log(`🧮 Manual points from members: ratingsParsed=${ratingsParsed}, manualPoints=${manual != null ? manual : 'n/a'}`);
            appendEvent({ type: 'diagnostic', scope: 'members_points', ratingsParsed, manualPoints: manual, source: parsedMembers.source || 'unknown' });
          }
        } catch (_) {}
        const prevTotal = prev && typeof prev.totalPoints === 'number' ? prev.totalPoints : null;
        const newTotal = typeof snapshot.totalPoints === 'number' ? snapshot.totalPoints : null;

        // Members are fetched every poll above; no additional conditional fetch needed here

        const msgLines = [];
        msgLines.push(`📊 Squadron tracker update (${new Date().toLocaleString()})`);
        if (snapshot && snapshot.data) {
          msgLines.push(`• Members source: ${snapshot.data.source || 'unknown'} | ratings parsed: ${snapshot.ratingsParsed ?? 'n/a'} | manual points: ${snapshot.manualPoints ?? 'n/a'}`);
        }

        // Total points change (site-reported and calculated)
        const pointsDelta = (prevTotal != null && newTotal != null) ? (newTotal - prevTotal) : null;
        if (pointsDelta != null && pointsDelta !== 0) {
          msgLines.push(`• Total points: ${prevTotal} → ${newTotal} (${pointsDelta >= 0 ? '+' : ''}${pointsDelta})`);
          // Event: points change
          appendEvent({
            type: 'points_change',
            delta: pointsDelta,
            from: prevTotal,
            to: newTotal,
            place: squadronPlace ?? null,
            totalPointsAbove: totalPointsAbove ?? null,
            totalPointsBelow: totalPointsBelow ?? null,
          });
        }

        // Row-level changes: added/removed players
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
          const removed = [];
          const added = [];
          prevMap.forEach((r, k) => { if (!currMap.has(k)) removed.push(r); });
          currMap.forEach((r, k) => { if (!prevMap.has(k)) added.push(r); });

          // Helpers for monospace alignment
          const safeName = (r) => (r['Player'] || r['player'] || 'Unknown').toString();
          const safeRole = (r) => (r['Role'] || r['role'] || '').toString();
          const safeRating = (r) => (String((r['Personal clan rating'] || r['rating'] || '')).replace(/\s+/g, ''));
          const padRight = (s, n) => s.length >= n ? s.slice(0, n) : (s + ' '.repeat(n - s.length));
          const padLeft = (s, n) => s.length >= n ? s.slice(-n) : (' '.repeat(n - s.length) + s);

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
            // Events: member leave (delta reflects squadron total points change)
            for (const r of removed) {
              const member = {
                'Player': safeName(r),
                'Personal clan rating': safeRating(r) || '0',
                'Role': safeRole(r) || 'Member',
                'Date of entry': (r['Date of entry'] || r['date of entry'] || r['Date'] || '').toString(),
              };
              appendEvent({
                type: 'member_leave',
                delta: pointsDelta ?? null,
                member,
              });
            }
          }
          if (added.length) {
            msgLines.push('• New members:');
            msgLines.push(...buildLines(added, '+'));
            // Events: member join (delta reflects squadron total points change)
            for (const r of added) {
              const member = {
                'Player': safeName(r),
                'Personal clan rating': safeRating(r) || '0',
                'Role': safeRole(r) || 'Member',
                'Date of entry': (r['Date of entry'] || r['date of entry'] || r['Date'] || '').toString(),
              };
              appendEvent({
                type: 'member_join',
                delta: pointsDelta ?? null,
                member,
              });
            }
          }
        }

        const composed = msgLines.join('\n');
        console.log(composed);
        const send = getDiscordSend();
        if (send) {
          try { await send(composed); } catch (_) { /* do not mirror message to events log */ }
        }
      } catch (e) {
        console.warn('⚠️ Squadron tracker: diff/notify failed:', e && e.message ? e.message : e);
      }

      appendSnapshot(dataFile, snapshot);
      lastKey = key;
      lastSnapshot = pruneSnapshot(snapshot);
      console.log('📈 Squadron tracker: change detected and recorded.');
    } else {
      // Even if no change, ensure one final snapshot at/after 23:30 UTC
      try {
        const cutoffMin = 23 * 60 + 30;
        const now = new Date();
        const curMin = now.getUTCHours() * 60 + now.getUTCMinutes();
        const last = readLastSnapshot(dataFile);
        const sameDay = (d1, d2) => d1 && d2 && d1.getUTCFullYear() === d2.getUTCFullYear() && d1.getUTCMonth() === d2.getUTCMonth() && d1.getUTCDate() === d2.getUTCDate();
        if (last && sameDay(new Date(last.ts), now)) {
          const lastDate = new Date(last.ts);
          const lastMin = lastDate.getUTCHours() * 60 + lastDate.getUTCMinutes();
          // If it's past cutoff, and we haven't saved a post-cutoff snapshot today, do it now
          if (curMin >= cutoffMin && (isNaN(lastMin) || lastMin < cutoffMin)) {
            appendSnapshot(dataFile, snapshot);
            lastKey = simplifyForComparison(snapshot);
            lastSnapshot = pruneSnapshot(snapshot);
            console.log('🕧 Squadron tracker: daily cutoff snapshot saved.');
          }
        }
      } catch (_) {}
      console.log('ℹ️ Squadron tracker: no change.');
    }
  }

  await captureOnce();
  const interval = setInterval(captureOnce, 60_000);

  // Expose a stop handle
  return {
    enabled: true,
    stop: async () => { try { clearInterval(interval); } catch (_) {} }
  };
}

module.exports = { startSquadronTracker };
