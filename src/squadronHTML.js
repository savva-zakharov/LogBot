// src/squadronHTML.js
const { fetchTextWithStatus, parseTableFromHtml, normalizeTag } = require('./squadronUtils');

async function searchLeaderboard(tag, {
  base = 'https://warthunder.com/en/community/clansleaderboard',
  maxPages = 50,
  parseOptions = {
    tableSelector: 'table.leaderboards',
    headerSelector: 'thead th',
    rowSelector: 'tbody tr',
    cellSelector: 'td',
  },
} = {}) {
  const needle = normalizeTag(tag);
  if (!needle) return { ok: false, source: 'html', headers: [], rows: [] };

  for (let p = 1; p <= maxPages; p++) {
    const url = p === 1 ? base : `${base}/page/${p}/`;
    const { status, body } = await fetchTextWithStatus(url, 15000);
    if (status === 403) {
      return { ok: false, source: 'html', url, blocked: true, headers: [], rows: [] };
    }
    if (status !== 200 || !body) continue;
    const parsed = parseTableFromHtml(body, parseOptions);
    if (parsed && parsed.ok && parsed.rows && parsed.rows.length) {
      // look for tag match on this page
      const rows = parsed.rows;
      const hitIndex = rows.findIndex(r => (r.cells || []).some(c => normalizeTag(c).includes(needle)));
      if (hitIndex !== -1) {
        return { ...parsed, source: 'html', url, matchIndex: hitIndex, page: p };
      }
    }
  }
  return { ok: false, source: 'html', headers: [], rows: [] };
}

async function parseSquadronPage(url, parseOptions) {
  const { status, body } = await fetchTextWithStatus(url, 15000);
  if (status === 403) return { ok: false, source: 'html', url, blocked: true, headers: [], rows: [] };
  if (status !== 200 || !body) return { ok: false, source: 'html', url, headers: [], rows: [] };
  const parsed = parseTableFromHtml(body, parseOptions);
  return { ...parsed, source: 'html', url };
}

module.exports = { searchLeaderboard, parseSquadronPage };
