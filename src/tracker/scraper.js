// src/tracker/scraper.js
const cheerio = require('cheerio');
const https = require('https');
const { logError, HTML_REQUEST_HEADERS, toNum } = require('./utils');

const DEFAULT_TIMEOUT_MS = 15_000;

// Fetch JSON from URL
function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  console.log(`ℹ️ fetchJson: fetching ${url}`);
  return new Promise((resolve) => {
    const req = https.get(url, res => {
      if (res.statusCode !== 200) {
        console.warn(`⚠️ fetchJson: non-200 status code (${res.statusCode}) for ${url}`);
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
          logError('fetchJson.parse', e);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      logError('fetchJson.request', e);
      resolve(null);
    });
    req.setTimeout(timeoutMs, () => {
      console.warn(`⚠️ fetchJson: request timed out after ${timeoutMs}ms for ${url}`);
      try { req.destroy(); } catch (e) {
        logError('fetchJson.destroy', e);
      }
      resolve(null);
    });
  });
}

// Simple text fetcher (for HTML)
function fetchText(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const options = new URL(url);
    options.method = 'GET';
    options.headers = HTML_REQUEST_HEADERS;
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
    req.on('error', (e) => { 
      logError('fetchText.request', e); 
      resolve(null); 
    });
    req.setTimeout(timeoutMs, () => { 
      try { req.destroy(); } catch (e) {
        logError('fetchText.destroy', e);
      }
      resolve(null); 
    });
  });
}

async function fetchTextWithFallback(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return await fetchText(url, timeoutMs);
}

// Try to extract squadron total points (and optionally place) from the HTML
function parseTotalPointsFromHtml(html) {
  try {
    const $ = cheerio.load(html);
    let totalPoints = null;
    let place = null;

    // Preferred: exact selector provided by user
    try {
      const selText = $('div.squadrons-counter__item:nth-child(1) > div:nth-child(2)').first().text().trim();
      if (selText) {
        const num = Number((selText || '').replace(/[^\d]/g, ''));
        if (Number.isFinite(num) && num > 0) totalPoints = num;
      }
    } catch (e) {
      logError('parseTotalPointsFromHtml.selector', e);
    }

    // 1) Look for obvious labels like "Total points" (English UI)
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
        // Try siblings for the numeric value
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

    // 2) Heuristic: find a large number near words like "points" in any element
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

    // 3) Attempt to read place if present (e.g., "Place: 23")
    const placeText = $('*:contains("Place")').filter(function() { return /place/i.test($(this).text()); }).first().text();
    if (placeText) {
      const pm = placeText.match(/place[^\d]*(\d+)/i);
      if (pm && pm[1]) {
        const n = Number(pm[1]);
        if (Number.isFinite(n)) place = n;
      }
    }

    return { totalPoints, place };
  } catch (e) {
    logError('parseTotalPointsFromHtml', e);
    return { totalPoints: null, place: null };
  }
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
          'Points': rating,
          'Activity': activity,
          'Role': role,
          'Date of entry': date,
        });
      }
    }
    console.log(`ℹ️ Cheerio: parsed member rows=${rows.length}`);
    return { headers: ['num.', 'Player', 'Points', 'Activity', 'Role', 'Date of entry'], rows };
  } catch (e) {
    logError('parseSquadronWithCheerio', e);
    return { headers: [], rows: [] };
  }
}

module.exports = {
  fetchJson,
  fetchText,
  fetchTextWithFallback,
  parseTotalPointsFromHtml,
  parseSquadronWithCheerio,
  toNum,
};
