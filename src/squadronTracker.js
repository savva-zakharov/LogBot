// src/squadronTracker.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { resolveChromiumExecutable, loadSettings } = require('./config');

// Lazy accessor to avoid circular dependency at module load
function getDiscordSend() {
  try {
    const mod = require('./discordBot');
    return typeof mod.sendMessage === 'function' ? mod.sendMessage : null;
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

function appendEvent(message, meta = {}) {
  try {
    const file = ensureEventsFile();
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(obj.events)) obj.events = [];
    obj.events.push({ ts: new Date().toISOString(), message, ...meta });
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

  const execPath = resolveChromiumExecutable();
  if (!execPath) {
    console.warn('⚠️ Squadron tracker: no browser executable found.');
    return { enabled: false };
  }

  const browser = await puppeteer.launch({ headless: true, executablePath: execPath });
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  } catch (_) {}
  try { await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 }); } catch (_) {}
  await page.goto(squadronPageUrl, { waitUntil: 'networkidle2' });
  try { await page.waitForSelector('div.squadrons-members__table', { timeout: 15000 }); } catch (_) {}
  // Attempt to scroll to bottom to trigger lazy content
  try {
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const step = () => {
          const { scrollTop, scrollHeight, clientHeight } = document.scrollingElement || document.documentElement;
          const atBottom = scrollTop + clientHeight >= scrollHeight - 5;
          if (atBottom || total > 10) return resolve();
          window.scrollBy(0, Math.max(200, Math.floor(clientHeight / 2)));
          total++;
          setTimeout(step, 200);
        };
        step();
      });
    });
  } catch (_) {}

  const dataFile = ensureParsedDataFile();
  let lastKey = null;
  let lastSnapshot = null;

  async function captureOnce() {
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      try { await page.waitForSelector('div.squadrons-members__table', { timeout: 15000 }); } catch (_) {}
    } catch (_) {}
    let data = { headers: [], rows: [] };
    try {
      data = await scrapeTable(page);
    } catch (e) {
      console.warn('⚠️ Squadron tracker: scrape failed:', e && e.message ? e.message : e);
    }
    const totalPoints = await extractTotalPoints(page);
    const totalPointsCalulated = calculateManualPoints(data.rows || []);
    const effectiveTotal = (typeof totalPoints === 'number' && Number.isFinite(totalPoints))
      ? totalPoints
      : (typeof totalPointsCalulated === 'number' && Number.isFinite(totalPointsCalulated) ? totalPointsCalulated : null);
    const snapshot = { ts: new Date().toISOString(), url: squadronPageUrl, totalPoints: effectiveTotal, totalPointsCalulated, data };
    if (!snapshot.data || !snapshot.data.rows || snapshot.data.rows.length === 0) {
      // Persist a debug snapshot (HTML + screenshot) to help diagnose selector issues
      try {
        const html = await page.content();
        fs.writeFileSync(path.join(process.cwd(), 'debug_squadron.html'), html, 'utf8');
      } catch (_) {}
      try {
        await page.screenshot({ path: path.join(process.cwd(), 'debug_squadron.png'), fullPage: true });
      } catch (_) {}
      console.warn('ℹ️ Squadron tracker: no rows parsed. Saved debug_squadron.html/png for inspection.');
    }
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
        const msgLines = [];
        msgLines.push(`📊 Squadron tracker update (${new Date().toLocaleString()})`);

        // Total points change (site-reported and calculated)
        const prevTotal = prev && typeof prev.totalPoints === 'number' ? prev.totalPoints : null;
        const newTotal = typeof snapshot.totalPoints === 'number' ? snapshot.totalPoints : null;
        if (prevTotal != null && newTotal != null && newTotal !== prevTotal) {
          const delta = newTotal - prevTotal;
          msgLines.push(`• Total points: ${prevTotal} → ${newTotal} (${delta >= 0 ? '+' : ''}${delta})`);
        }
        // Calculated points messaging removed; calculated points are only used as fallback for totalPoints

        // Row-level changes: added/removed players
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
          msgLines.push(`• Departures (${removed.length}):`);
          buildLines(removed, '-').forEach(line => msgLines.push(line));
          if (removed.length > 10) msgLines.push(`   …and ${removed.length - 10} more`);
        }
        if (added.length) {
          msgLines.push(`• New members (${added.length}):`);
          buildLines(added, '+').forEach(line => msgLines.push(line));
          if (added.length > 10) msgLines.push(`   …and ${added.length - 10} more`);
        }

        const composed = msgLines.join('\n');
        console.log(composed);
        const send = getDiscordSend();
        if (send) {
          try { await send(composed); appendEvent(composed, { source: 'squadronTracker' }); } catch (_) { try { appendEvent(composed, { source: 'squadronTracker', note: 'send failed' }); } catch (_) {} }
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
    browser,
    stop: async () => { try { clearInterval(interval); await browser.close(); } catch (_) {} }
  };
}

module.exports = { startSquadronTracker };
