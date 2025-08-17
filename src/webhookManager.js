// src/webhookManager.js
// Manages short-lived Discord webhooks created by /logbird
// - Persists created webhooks to logbird_webhooks.json
// - Auto-deletes webhooks after 1 hour of inactivity
// - Exposes helpers to create, mark usage, and end session

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(process.cwd(), 'logbird_webhooks.json');
const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');
const CLEAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let clientRef = null;
let cleaner = null;
let logger = null; // optional function(message)

function setLogger(fn) { logger = typeof fn === 'function' ? fn : null; }
function log(msg) { try { if (logger) logger(String(msg)); } catch (_) {} }

function ensureStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      fs.writeFileSync(STORE_FILE, JSON.stringify({ webhooks: [] }, null, 2), 'utf8');
    } else {
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.webhooks)) {
        fs.writeFileSync(STORE_FILE, JSON.stringify({ webhooks: [] }, null, 2), 'utf8');
      }

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

function getInactivityMs() {
  const settings = loadSettings();
  let minutes = Number(settings.logbirdAutoDeleteMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) minutes = 60; // default 60m
  // clamp to reasonable bounds: 1 minute to 7 days
  minutes = Math.max(1, Math.min(360, Math.floor(minutes)));
  return minutes * 60 * 1000;
}
    }
  } catch (_) {}
}

function loadStore() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) || { webhooks: [] };
  } catch (_) {
    return { webhooks: [] };
  }
}

function saveStore(store) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store || { webhooks: [] }, null, 2), 'utf8');
  } catch (_) {}
}

function now() { return Date.now(); }

async function cleanupExpired() {
  const store = loadStore();
  const keep = [];
  const inactivityMs = getInactivityMs();
  const minutes = Math.round(inactivityMs / 60000);
  for (const w of store.webhooks) {
    const last = Number(w.lastUsedAt || w.createdAt || 0);
    if (!Number.isFinite(last) || now() - last > inactivityMs) {
      // try delete
      try {
        if (clientRef) {
          const ch = await clientRef.channels.fetch(w.channelId);
          if (ch && typeof ch.fetchWebhooks === 'function') {
            const hooks = await ch.fetchWebhooks();
            const hook = hooks.get(w.id);
            if (hook) {
              await hook.delete(`Logbird auto-cleanup (inactive > ${minutes}m)`);
              log(`Auto-deleted webhook ${w.name || ''} (${w.id}) in <#${w.channelId}> after ${minutes}m inactivity.`);
            }
          }
        }
      } catch (_) {}
    } else {
      keep.push(w);
    }
  }
  if (keep.length !== store.webhooks.length) {
    saveStore({ webhooks: keep });
  }
}

function startCleaner() {
  if (cleaner) return;
  cleaner = setInterval(() => { cleanupExpired().catch(() => {}); }, CLEAN_INTERVAL_MS);
}

function stopCleaner() {
  if (cleaner) { try { clearInterval(cleaner); } catch (_) {} cleaner = null; }
}

function init(client) {
  clientRef = client || clientRef;
  ensureStore();
  startCleaner();
}

function markUsed(id) {
  const store = loadStore();
  const idx = store.webhooks.findIndex(w => w.id === id);
  if (idx >= 0) {
    store.webhooks[idx].lastUsedAt = now();
    saveStore(store);
    const w = store.webhooks[idx];
    log(`Webhook used: ${w.name || ''} (${w.id}) in <#${w.channelId}>`);
    return true;
  }
  return false;
}

async function registerCreated(hook) {
  const store = loadStore();
  store.webhooks.push({
    id: hook.id,
    token: hook.token,
    url: hook.url,
    name: hook.name,
    channelId: hook.channelId,
    guildId: hook.guildId || (hook.guild ? hook.guild.id : undefined),
    createdAt: now(),
    lastUsedAt: now(),
  });
  saveStore(store);
  log(`Webhook created: ${hook.name || ''} (${hook.id}) in <#${hook.channelId}>`);
}

async function endSessionDeleteAll(reason = 'session end') {
  const store = loadStore();
  const remaining = [];
  for (const w of store.webhooks) {
    try {
      if (clientRef) {
        const ch = await clientRef.channels.fetch(w.channelId);
        if (ch && typeof ch.fetchWebhooks === 'function') {
          const hooks = await ch.fetchWebhooks();
          const hook = hooks.get(w.id);
          if (hook) { await hook.delete(`Logbird cleanup (${reason})`); log(`Webhook deleted: ${w.name || ''} (${w.id}) in <#${w.channelId}> (${reason})`); }
          continue;
        }
      }
    } catch (_) {}
    // Could not delete now; keep for later retry
    remaining.push(w);
  }
  saveStore({ webhooks: remaining });
}

function list() {
  const store = loadStore();
  return Array.isArray(store.webhooks) ? store.webhooks.slice() : [];
}

async function deleteById(id, reason = 'manual delete') {
  if (!id) return false;
  const store = loadStore();
  let deleted = false;
  try {
    if (clientRef) {
      // Find channel for this webhook to delete from API first
      const entry = store.webhooks.find(w => w.id === id);
      if (entry) {
        try {
          const ch = await clientRef.channels.fetch(entry.channelId);
          if (ch && typeof ch.fetchWebhooks === 'function') {
            const hooks = await ch.fetchWebhooks();
            const hook = hooks.get(entry.id);
            if (hook) { await hook.delete(`Logbird cleanup (${reason})`); deleted = true; log(`Webhook deleted: ${entry.name || ''} (${entry.id}) in <#${entry.channelId}> (${reason})`); }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  // Remove from store regardless if API delete succeeded (it may have already been removed)
  const before = store.webhooks.length;
  store.webhooks = store.webhooks.filter(w => w.id !== id);
  saveStore(store);
  return deleted || store.webhooks.length < before;
}

module.exports = {
  init,
  markUsed,
  registerCreated,
  cleanupExpired,
  endSessionDeleteAll,
  stopCleaner,
  list,
  deleteById,
  setLogger,
};
