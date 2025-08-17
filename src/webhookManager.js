// src/webhookManager.js
// Manages short-lived Discord webhooks created by /logbird
// - Persists created webhooks to logbird_webhooks.json
// - Auto-deletes webhooks after 1 hour of inactivity
// - Exposes helpers to create, mark usage, and end session

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(process.cwd(), 'logbird_webhooks.json');
const INACTIVITY_MS = 60 * 60 * 1000; // 1 hour
const CLEAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let clientRef = null;
let cleaner = null;

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
  for (const w of store.webhooks) {
    const last = Number(w.lastUsedAt || w.createdAt || 0);
    if (!Number.isFinite(last) || now() - last > INACTIVITY_MS) {
      // try delete
      try {
        if (clientRef) {
          const ch = await clientRef.channels.fetch(w.channelId);
          if (ch && typeof ch.fetchWebhooks === 'function') {
            const hooks = await ch.fetchWebhooks();
            const hook = hooks.get(w.id);
            if (hook) {
              await hook.delete('Logbird auto-cleanup (inactive > 1h)');
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
          if (hook) { await hook.delete(`Logbird cleanup (${reason})`); }
          continue;
        }
      }
    } catch (_) {}
    // Could not delete now; keep for later retry
    remaining.push(w);
  }
  saveStore({ webhooks: remaining });
}

module.exports = {
  init,
  markUsed,
  registerCreated,
  cleanupExpired,
  endSessionDeleteAll,
  stopCleaner,
};
