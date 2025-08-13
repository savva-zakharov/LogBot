// src/squadronUtils.js
const https = require('https');
const cheerio = require('cheerio');

// Normalizers
function normalizeText(s, { trimWhitespace = true, collapseSpaces = true } = {}) {
  let t = String(s ?? '');
  if (trimWhitespace) t = t.trim();
  if (collapseSpaces) t = t.replace(/\s+/g, ' ');
  return t;
}
function normalizeTag(s) {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}
function toNum(val) {
  const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
}

// Networking
function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} resolve(null); });
  });
}
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
      if (status !== 200) { res.resume(); return resolve({ status, body: null }); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: null }); });
  });
}

// HTML table parsing with Cheerio
function parseTableFromHtml(html, opts = {}) {
  const {
    tableSelector = 'table.leaderboards',
    headerSelector = 'thead th',
    rowSelector = 'tbody tr',
    cellSelector = 'td',
    trimWhitespace = true,
    collapseSpaces = true,
  } = opts;

  try {
    const $ = cheerio.load(html);
    const table = $(tableSelector).first();
    const headers = [];
    if (table.length) {
      table.find(headerSelector).each((_, th) => headers.push(normalizeText($(th).text(), { trimWhitespace, collapseSpaces })));
      const rows = [];
      table.find(rowSelector).each((_, tr) => {
        const cells = [];
        const links = [];
        $(tr).find(cellSelector).each((__, td) => {
          const cellText = normalizeText($(td).text(), { trimWhitespace, collapseSpaces });
          const a = $(td).find('a[href]').first();
          const href = a.length ? a.attr('href') : null;
          cells.push(cellText);
          links.push(href || null);
        });
        if (cells.length) rows.push({ cells, links });
      });
      return { ok: true, source: 'html', headers, rows };
    }
  } catch (e) {
    try { console.warn('⚠️ parseTableFromHtml error:', e && e.message ? e.message : e); } catch (_) {}
  }
  return { ok: false, source: 'html', headers: [], rows: [] };
}

module.exports = {
  normalizeText,
  normalizeTag,
  toNum,
  fetchJson,
  fetchTextWithStatus,
  parseTableFromHtml,
};
