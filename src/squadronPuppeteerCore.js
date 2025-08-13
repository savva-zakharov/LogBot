// src/squadronPuppeteerCore.js
const { resolveChromiumExecutable } = require('./config');
let puppeteer;
try { puppeteer = require('puppeteer-core'); } catch (_) { puppeteer = null; }

async function parseTableFromPage(page, opts = {}) {
  const {
    tableSelector = 'table.leaderboards',
    headerSelector = 'thead th',
    rowSelector = 'tbody tr',
    cellSelector = 'td',
  } = opts;
  try {
    const res = await page.evaluate(({ tableSelector, headerSelector, rowSelector, cellSelector }) => {
      const out = { ok: false, source: 'puppeteer-core', headers: [], rows: [] };
      const table = document.querySelector(tableSelector);
      if (!table) return out;
      const headers = Array.from(table.querySelectorAll(headerSelector)).map(th => (th.innerText || '').trim());
      const rows = [];
      const trs = Array.from(table.querySelectorAll(rowSelector));
      for (const tr of trs) {
        const tds = Array.from(tr.querySelectorAll(cellSelector));
        const cells = tds.map(td => (td.innerText || '').trim());
        const links = tds.map(td => { const a = td.querySelector('a[href]'); return a ? a.getAttribute('href') : null; });
        if (cells.length) rows.push({ cells, links });
      }
      return { ok: true, source: 'puppeteer-core', headers, rows };
    }, { tableSelector, headerSelector, rowSelector, cellSelector });
    return res;
  } catch (e) {
    try { console.warn('⚠️ parseTableFromPage(core) error:', e && e.message ? e.message : e); } catch (_) {}
    return { ok: false, source: 'puppeteer-core', headers: [], rows: [] };
  }
}

async function searchLeaderboard(tag, {
  base = 'https://warthunder.com/en/community/clansleaderboard',
  maxPages = 25,
  parseOptions,
} = {}) {
  if (!puppeteer) return { ok: false, source: 'puppeteer-core', headers: [], rows: [] };
  const executablePath = resolveChromiumExecutable && resolveChromiumExecutable();
  if (!executablePath) return { ok: false, source: 'puppeteer-core', headers: [], rows: [] };
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', executablePath, args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    for (let p = 1; p <= maxPages; p++) {
      const url = p === 1 ? base : `${base}/page/${p}/`;
      const resp = await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });
      const status = resp ? resp.status() : 0;
      if (status === 403) {
        return { ok: false, source: 'puppeteer-core', url, blocked: true, headers: [], rows: [] };
      }
      try { await page.waitForSelector((parseOptions && parseOptions.tableSelector) || 'table.leaderboards', { timeout: 3000 }); } catch (_) {}
      const res = await parseTableFromPage(page, parseOptions);
      if (res && res.ok && res.rows && res.rows.length) return { ...res, url };
    }
  } catch (e) {
    try { console.warn('⚠️ squadronPuppeteerCore.searchLeaderboard failed:', e && e.message ? e.message : e); } catch (_) {}
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
  }
  return { ok: false, source: 'puppeteer-core', headers: [], rows: [] };
}

async function parseSquadronPage(url, parseOptions) {
  if (!puppeteer) return { ok: false, source: 'puppeteer-core', headers: [], rows: [] };
  const executablePath = resolveChromiumExecutable && resolveChromiumExecutable();
  if (!executablePath) return { ok: false, source: 'puppeteer-core', headers: [], rows: [] };
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', executablePath, args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    const resp = await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });
    const status = resp ? resp.status() : 0;
    if (status === 403) return { ok: false, source: 'puppeteer-core', url, blocked: true, headers: [], rows: [] };
    try { await page.waitForSelector((parseOptions && parseOptions.tableSelector) || 'table', { timeout: 3000 }); } catch (_) {}
    const res = await parseTableFromPage(page, parseOptions);
    return { ...res, url };
  } catch (e) {
    try { console.warn('⚠️ squadronPuppeteerCore.parseSquadronPage failed:', e && e.message ? e.message : e); } catch (_) {}
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
  }
  return { ok: false, source: 'puppeteer-core', headers: [], rows: [] };
}

module.exports = { searchLeaderboard, parseSquadronPage, parseTableFromPage };
