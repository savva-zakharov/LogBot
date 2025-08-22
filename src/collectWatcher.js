// src/collectWatcher.js
// Watches a single configured channel (settings.discordDataChannel)
// for messages with JSON attachments. Validates structure similar to parsed_data.json
// and stores accepted entries into collected_data.json bucketed by today's BR.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { getTodaysBr } = require('./brHelper');

const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');
const COLLECTED_PATH = path.join(process.cwd(), 'collected_data.json');
const PROCESSED_MAX = 5000;
const processedIds = new Set();

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const j = JSON.parse(raw || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}

function ensureCollected() {
  try {
    if (!fs.existsSync(COLLECTED_PATH)) {
      fs.writeFileSync(COLLECTED_PATH, JSON.stringify({}, null, 2), 'utf8');
    } else {
      // basic sanity
      const raw = fs.readFileSync(COLLECTED_PATH, 'utf8');
      try {
        const j = JSON.parse(raw || '{}');
        if (!j || typeof j !== 'object') throw new Error('bad');
      } catch (_) {
        fs.writeFileSync(COLLECTED_PATH, JSON.stringify({}, null, 2), 'utf8');
      }
    }
  } catch (_) {}
}

function loadCollected() {
  ensureCollected();
  try {
    return JSON.parse(fs.readFileSync(COLLECTED_PATH, 'utf8')) || {};
  } catch (_) { return {}; }
}

function saveCollected(obj) {
  try { fs.writeFileSync(COLLECTED_PATH, JSON.stringify(obj || {}, null, 2), 'utf8'); } catch (_) {}
}

function isNumericKey(k) { return typeof k === 'string' && /^\d+$/.test(k); }

function validateParsedShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const has = (k) => Object.prototype.hasOwnProperty.call(obj, k);
  if (!(has('_gameState') && has('_telemetry') && has('_meta') && has('_results'))) return false;
  if (typeof obj._gameState !== 'object' || typeof obj._telemetry !== 'object') return false;
  // Minimal sanity checks for fields
  if (!('currentGame' in obj._gameState) || !('lastGameIncrementTime' in obj._gameState)) return false;
  if (!('lastEvtId' in obj._telemetry) || !('lastDmgId' in obj._telemetry)) return false;
  return true;
}

// Apply discard rules on the numbered matrix under _results (assumed path)
// Rules:
// - If a numbered matrix entry (e.g., key "0") contains more than 2 subcategories, and either subcategory has > 8 entries, discard the DATASET.
// - If it contains the "none" subcategory, discard that CATEGORY.
// Returns { accepted: boolean, mutatedResults }
function applyMatrixRules(results) {
  try {
    if (!results || typeof results !== 'object') return { accepted: true, mutatedResults: results };
    const mutated = { ...results };
    for (const key of Object.keys(results)) {
      if (!isNumericKey(key)) continue;
      const cat = results[key];
      if (!cat || typeof cat !== 'object') continue;
      const subKeys = Object.keys(cat);
      // If contains "none", drop this category entirely
      if (subKeys.map(s => s.toLowerCase()).includes('none')) {
        delete mutated[key];
        continue;
      }
      // If >2 subcategories and any subcategory has >8 entries => discard whole dataset
      const tooManySubs = subKeys.length > 2;
      if (tooManySubs) {
        for (const sk of subKeys) {
          const val = cat[sk];
          if (Array.isArray(val) && val.length > 8) {
            return { accepted: false, mutatedResults: results };
          }
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const count = Object.keys(val).length;
            if (count > 8) return { accepted: false, mutatedResults: results };
          }
        }
      }
    }
    return { accepted: true, mutatedResults: mutated };
  } catch (_) {
    return { accepted: true, mutatedResults: results };
  }
}

// If numeric keys exist under _results (e.g., "0", "1"), remap collisions with unique ids within the same BR bucket
function uniquifyNumericKeys(brBucket, results) {
  const out = { ...results };
  const used = new Set(Object.keys(out));
  const existing = new Set();
  // Collect existing keys in collected store under this BR for uniqueness context
  const store = loadCollected();
  const br = String(brBucket);
  const existingGames = (store[br] && store[br].games) ? store[br].games : {};
  for (const gId of Object.keys(existingGames)) existing.add(gId);
  const makeId = () => String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
  for (const k of Object.keys(out)) {
    if (!isNumericKey(k)) continue;
    let newId = k;
    // If this id already exists in the BR bucket, remap
    if (existing.has(newId)) {
      newId = makeId();
      // avoid collisions with current object keys too
      while (used.has(newId) || existing.has(newId)) newId = makeId();
      out[newId] = out[k];
      delete out[k];
      used.delete(k); used.add(newId);
    }
  }
  return out;
}

function upsertCollected(br, payload) {
  const store = loadCollected();
  const key = String(br || 'unknown');
  if (!store[key]) store[key] = { games: {} };
  // Default strategy: if payload._results has numeric keys, merge them as game IDs
  let results = payload._results || {};
  // Apply rules and uniqueness
  const rules = applyMatrixRules(results);
  if (!rules.accepted) return { ok: false, reason: 'discard_rules' };
  results = rules.mutatedResults;
  results = uniquifyNumericKeys(key, results);
  // Merge into bucket
  for (const gameId of Object.keys(results)) {
    store[key].games[gameId] = {
      receivedAt: new Date().toISOString(),
      _source: 'discord-attachment',
      data: payload,
    };
  }
  saveCollected(store);
  return { ok: true };
}

function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    try {
      const mod = url.startsWith('https:') ? https : http;
      mod.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // follow redirect
          return resolve(downloadToBuffer(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    } catch (e) { reject(e); }
  });
}

function looksJsonAttachment(att) {
  if (!att) return false;
  const name = (att.name || '').toLowerCase();
  const ct = (att.contentType || '').toLowerCase();
  return name.endsWith('.json') || ct.includes('application/json') || ct.includes('text/json');
}

async function processMessage(message) {
  try {
    if (!message) return;
    if (!message.id) return;
    const attCount = message.attachments ? message.attachments.size : 0;
    console.log(`[collectWatcher] Received message ${message.id} (channel ${message.channelId}, webhookId=${message.webhookId || 'n/a'}) with ${attCount} attachments`);
    if (processedIds.has(message.id)) { console.log(`[collectWatcher] Skip: already processed ${message.id}`); return; }
    // Determine configured channel id
    let channelId = null;
    try {
      const s = loadSettings();
      const raw = s.discordDataChannel || '';
      if (typeof raw === 'string' && raw.trim()) {
        if (/^\d{10,}\/\d{10,}$/.test(raw)) {
          const [, cId] = raw.split('/');
          channelId = cId;
        } else {
          channelId = raw.replace(/^#/, '');
        }
      }
    } catch (_) {}
    if (!channelId) { console.log('[collectWatcher] Skip: no discordDataChannel configured'); return; }
    if (message.channelId !== channelId) { console.log(`[collectWatcher] Skip: message ${message.id} in channel ${message.channelId}, expecting ${channelId}`); return; }
    if (!message.attachments || message.attachments.size === 0) { console.log(`[collectWatcher] Skip: message ${message.id} has no attachments`); return; }
    // Mark as seen (best-effort) before heavy work to avoid duplicate concurrent handling
    processedIds.add(message.id);
    if (processedIds.size > PROCESSED_MAX) {
      // trim set occasionally
      const iter = processedIds.values();
      for (let i = 0; i < Math.ceil(PROCESSED_MAX / 2); i++) {
        const n = iter.next(); if (n.done) break; processedIds.delete(n.value);
      }
      processedIds.add(message.id);
    }
    for (const [, att] of message.attachments) {
      const isJsonish = looksJsonAttachment(att);
      console.log(`[collectWatcher] Inspect attachment: name="${att.name}" ct="${att.contentType}" size=${att.size} jsonLike=${isJsonish}`);
      if (!isJsonish) continue;
      // Download and parse
      let buf = null; let parsed = null;
      try {
        console.log(`[collectWatcher] Downloading attachment from ${att.url}`);
        buf = await downloadToBuffer(att.url);
        console.log(`[collectWatcher] Downloaded ${buf ? buf.length : 0} bytes for ${att.name}`);
        if (buf && buf.length <= 8 * 1024 * 1024) { // 8MB safety
          try {
            parsed = JSON.parse(buf.toString('utf8'));
            console.log(`[collectWatcher] JSON parsed for ${att.name}`);
          } catch (e) {
            console.warn(`[collectWatcher] JSON parse failed for ${att.name}: ${e && e.message ? e.message : e}`);
          }
        } else {
          console.warn(`[collectWatcher] Skip: buffer too large (${buf ? buf.length : 0} bytes) for ${att.name}`);
        }
      } catch (e) { console.warn(`[collectWatcher] Download failed for ${att.name}: ${e && e.message ? e.message : e}`); continue; }
      if (!validateParsedShape(parsed)) {
        console.warn(`[collectWatcher] Validation failed for ${att.name}`);
        continue; // skip invalid shape
      }
      const todaysBr = getTodaysBr();
      const res = upsertCollected(todaysBr || 'unknown', parsed);
      console.log(`[collectWatcher] Upsert ${res && res.ok ? 'OK' : 'NOT-OK'} for ${att.name} into BR=${todaysBr || 'unknown'}`);
      // Optional: react to message to signal success/failure
      try {
        if (typeof message.react === 'function') {
          if (res.ok) { await message.react('✅'); } else { await message.react('⚠️'); }
        }
      } catch (_) {}
    }
  } catch (_) {}
}

function init(client) {
  // Passive mode: do not attach any listeners. Messages should be forwarded
  // by the bot/webhook manager via collectWatcher.processMessage(message).
  return; // no-op
}

module.exports = { init, processMessage };
