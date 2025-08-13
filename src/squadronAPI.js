// src/squadronAPI.js
const { fetchJson, normalizeTag, toNum } = require('./squadronUtils');

// Normalized TableResult returned from API by mapping JSON to table-like rows
// headers: [ 'Rank', 'Tag', 'Points' ]
async function searchLeaderboard(tag, { maxPages = 100 } = {}) {
  const needle = normalizeTag(tag);
  if (!needle) return { ok: false, source: 'api', headers: [], rows: [] };

  const makeUrl = (page) => `https://warthunder.com/en/community/getclansleaderboard/dif/_hist/page/${page}/sort/dr_era5`;
  const headers = ['Rank', 'Tag', 'Points'];

  for (let page = 1; page <= maxPages; page++) {
    const json = await fetchJson(makeUrl(page));
    if (!json || json.status !== 'ok') {
      return { ok: false, source: 'api', headers, rows: [] };
    }
    const arr = Array.isArray(json.data) ? json.data : [];
    if (!arr.length) {
      return { ok: false, source: 'api', headers, rows: [] };
    }
    const rows = arr.map(it => {
      const rank = it.pos || null;
      const tagRaw = String(it.tagl || '');
      const points = toNum(it?.astat?.dr_era5_hist);
      const cells = [ String(rank ?? ''), tagRaw, String(points) ];
      const links = [ null, null, null ];
      return { cells, links };
    });
    const hitIndex = rows.findIndex(r => (r.cells || []).some(c => normalizeTag(c).includes(needle)));
    if (hitIndex !== -1) {
      return { ok: true, source: 'api', headers, rows, matchIndex: hitIndex, page };
    }
  }
  return { ok: false, source: 'api', headers, rows: [] };
}

module.exports = { searchLeaderboard };
