// src/webhookManager.js
// Manages short-lived Discord webhooks created by /logbird
// - Persists created webhooks to settings.json (key: logbirdWebhooks)
// - Auto-deletes webhooks after 1 hour of inactivity
// - Exposes helpers to create, mark usage, and end session

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEGACY_STORE_FILE = path.join(process.cwd(), 'logbird_webhooks.json');
const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');
const CLEAN_INTERVAL_MS = 60 * 1000; // 1 minute

let clientRef = null;
let cleaner = null;
let logger = null; // optional function(message)
let targetChannel = null; // cached Discord text channel for notices
let targetChannelId = null;
let lastResolveAt = 0;

function setLogger(fn) { logger = typeof fn === 'function' ? fn : null; }
function log(msg) {
  const line = String(msg);
  try { if (logger) { logger(line); return; } } catch (_) {}
  try { console.log(line); } catch (_) {}
}
function isDebug() {
  try {
    const s = loadSettings();
    return !!(s.logbirdDebug || process.env.LOGBIRD_DEBUG);
  } catch (_) { return !!process.env.LOGBIRD_DEBUG; }
}
function dbg(msg) {
  if (!isDebug()) return;
  const line = `[LogbirdWebhookManager] ${String(msg)}`;
  if (logger) { try { logger(line); } catch (_) {} } else { try { console.log(line); } catch (_) {} }
}

// --- Encryption helpers (AES-256-GCM) ---
function getPassphrase() {
  try {
    const s = loadSettings();
    const fromSettings = s && typeof s.logbirdCryptoKey === 'string' ? s.logbirdCryptoKey.trim() : '';
    const fromEnv = process.env.LONGBIRD_CRYPTO_KEY || process.env.LOGBIRD_CRYPTO_KEY || '';
    const key = fromSettings || fromEnv;
    return key && key.length >= 8 ? key : null; // minimal sanity
  } catch (_) { return null; }
}

function deriveKey(passphrase) {
  try {
    // Deterministic key from passphrase using scrypt
    const salt = 'logbird.v1.salt';
    return crypto.scryptSync(String(passphrase), salt, 32); // 256-bit key
  } catch (_) { return null; }
}

function encryptString(plain) {
  try {
    const pw = getPassphrase();
    if (!pw) return null;
    const key = deriveKey(pw);
    if (!key) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'v1:' + iv.toString('base64') + ':' + enc.toString('base64') + ':' + tag.toString('base64');
  } catch (_) { return null; }
}

function decryptString(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    if (!token.startsWith('v1:')) return null;
    const pw = getPassphrase();
    if (!pw) return null;
    const key = deriveKey(pw);
    if (!key) return null;
    const parts = token.split(':');
    if (parts.length !== 4) return null;
    const iv = Buffer.from(parts[1], 'base64');
    const data = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch (_) { return null; }
}

// Public wrappers for encryption helpers
function encryptWebhookUrl(url) {
  return encryptString(url);
}

function decryptWebhookUrl(token) {
  return decryptString(token);
}

// Retrieve decrypted URL for a stored webhook by id
function getDecryptedUrlById(id) {
  try {
    if (!id) return null;
    const store = loadStore();
    const w = Array.isArray(store.webhooks) ? store.webhooks.find(x => x && x.id === id) : null;
    if (!w) return null;
    // Prefer encrypted field
    if (w.urlEnc) {
      const dec = decryptString(w.urlEnc);
      if (dec) return dec;
    }
    // Legacy plain url support
    if (w.url && typeof w.url === 'string') return w.url;
    // Fallback: reconstruct from id/token if available
    if (w.id && w.token) return `https://discord.com/api/webhooks/${w.id}/${w.token}`;
    return null;
  } catch (_) { return null; }
}

// --- Discord notice helpers ---
function isSnowflake(str) { return typeof str === 'string' && /^\d{10,}$/.test(str); }

async function resolveNoticeChannel() {
  if (!clientRef) return null;
  const nowTs = Date.now();
  if (targetChannel && (nowTs - lastResolveAt) < 60_000) return targetChannel; // 1 min cache
  targetChannel = null;
  targetChannelId = null;
  try {
    const s = loadSettings();
    const raw = (s.discordChannel || '').trim();
    if (!raw) return null;
    let channelId = null;
    if (/^\d{10,}\/\d{10,}$/.test(raw)) {
      const [, cId] = raw.split('/');
      channelId = cId;
    } else if (isSnowflake(raw) || isSnowflake(raw.replace(/^#/, ''))) {
      channelId = raw.replace(/^#/, '');
    }
    if (channelId) {
      try {
        const ch = await clientRef.channels.fetch(channelId);
        if (ch && typeof ch.send === 'function') {
          targetChannel = ch;
          targetChannelId = ch.id;
          lastResolveAt = nowTs;
          return targetChannel;
        }
      } catch (_) {}
    }
    // Fallback: try by bare name across visible guilds (best-effort)
    const name = raw.replace(/^#/, '').toLowerCase();
    try { await clientRef.guilds.fetch(); } catch (_) {}
    for (const [, guild] of clientRef.guilds.cache) {
      try { await guild.channels.fetch(); } catch (_) {}
      const found = guild.channels.cache.find(c => c && typeof c.send === 'function' && c.name && c.name.toLowerCase() === name);
      if (found) {
        targetChannel = found;
        targetChannelId = found.id;
        lastResolveAt = nowTs;
        return targetChannel;
      }
    }
  } catch (_) {}
  lastResolveAt = nowTs;
  return null;
}

async function sendDiscordNotice(text) {
  try {
    const ch = await resolveNoticeChannel();
    if (!ch) return;
    const content = '```\n' + String(text == null ? '' : text) + '\n```';
    await ch.send({ content, allowedMentions: { parse: [] } });
  } catch (_) {}
}

function ensureStore() {
  try {
    // Ensure settings.json exists and has logbirdWebhooks array
    const settings = loadSettings();
    if (!Array.isArray(settings.logbirdWebhooks)) settings.logbirdWebhooks = [];

    // Migrate from legacy file if present
    if (fs.existsSync(LEGACY_STORE_FILE)) {
      try {
        const raw = fs.readFileSync(LEGACY_STORE_FILE, 'utf8');
        const legacy = JSON.parse(raw || '{}');
        const legacyArr = Array.isArray(legacy.webhooks) ? legacy.webhooks : [];
        if (legacyArr.length) {
          // Merge by id (avoid duplicates)
          const existingIds = new Set(settings.logbirdWebhooks.map(w => w.id));
          for (const w of legacyArr) {
            if (w && w.id && !existingIds.has(w.id)) settings.logbirdWebhooks.push(w);
          }
          dbg(`Migrated ${legacyArr.length} legacy webhook entries into settings.json`);
        }
        // Best effort: archive legacy file to avoid re-migrating
        try { fs.renameSync(LEGACY_STORE_FILE, LEGACY_STORE_FILE + '.bak'); } catch (_) {}
      } catch (_) { /* ignore */ }
    }

    saveSettings(settings);
  } catch (_) {}
}

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

function saveSettings(obj) {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj || {}, null, 2), 'utf8'); } catch (_) {}
}

function getInactivityMs() {
  const settings = loadSettings();
  let minutes = Number(settings.logbirdAutoDeleteMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) minutes = 15; // default 15m
  // clamp to reasonable bounds: 1 minute to 6 hours
  minutes = Math.max(1, Math.min(360, Math.floor(minutes)));
  return minutes * 60 * 1000;
}


function loadStore() {
  ensureStore();
  const settings = loadSettings();
  const arr = Array.isArray(settings.logbirdWebhooks) ? settings.logbirdWebhooks : [];
  return { webhooks: arr };
}

function saveStore(store) {
  const settings = loadSettings();
  settings.logbirdWebhooks = Array.isArray(store && store.webhooks) ? store.webhooks : [];
  saveSettings(settings);
}

function now() { return Date.now(); }

async function cleanupExpired() {
  const store = loadStore();
  const keep = [];
  const inactivityMs = getInactivityMs();
  const minutes = Math.round(inactivityMs / 60000);
  dbg(`Running cleanupExpired: ${store.webhooks.length} webhook(s), timeout ${minutes}m`);
  if (!clientRef) dbg('No clientRef available; cannot delete via Discord API. Will keep entries until client is ready.');
  for (const w of store.webhooks) {
    const last = Number(w.lastUsedAt || w.createdAt || 0);
    const ageMs = now() - last;
    const expired = !Number.isFinite(last) || ageMs > inactivityMs;
    if (expired) {
      // try delete
      try {
        if (clientRef) {
          dbg(`Attempting delete: id=${w.id} channel=${w.channelId} name='${w.name || ''}' age=${Math.round(ageMs/1000)}s`);
          const ch = await clientRef.channels.fetch(w.channelId).catch((e) => { dbg(`fetch channel failed for ${w.channelId}: ${e && e.message ? e.message : e}`); return null; });
          if (ch && typeof ch.fetchWebhooks === 'function') {
            const hooks = await ch.fetchWebhooks().catch((e) => { dbg(`fetchWebhooks failed in channel ${w.channelId}: ${e && e.message ? e.message : e}`); return null; });
            const hook = hooks && hooks.get ? hooks.get(w.id) : null;
            if (hook) {
              await hook.delete(`Logbird auto-cleanup (inactive > ${minutes}m)`).then(async () => {
                const msg = `Webhook deleted (auto): ${w.name || ''} (${w.id}) in <#${w.channelId}> after ${minutes}m inactivity`;
                log(msg);
                try { await sendDiscordNotice(msg); } catch (_) {}
                dbg(`Deleted webhook ${w.id} in channel ${w.channelId}`);
              }).catch((e) => {
                dbg(`hook.delete failed for ${w.id}: ${e && e.message ? e.message : e}`);
                keep.push(w); // keep for retry
              });
            } else {
              dbg(`Webhook id ${w.id} not found in channel ${w.channelId}; removing from store`);
            }
          } else {
            dbg(`Channel ${w.channelId} not accessible or no fetchWebhooks; keeping for retry`);
            keep.push(w);
          }
        } else {
          keep.push(w); // no client to delete now
        }
      } catch (e) { dbg(`Unexpected error during delete of ${w.id}: ${e && e.message ? e.message : e}`); keep.push(w); }
    } else {
      // Not expired
      keep.push(w);
    }
  }
  if (keep.length !== store.webhooks.length) {
    dbg(`Cleanup pruned ${store.webhooks.length - keep.length} webhook(s); ${keep.length} remain`);
    saveStore({ webhooks: keep });
  }
}

function startCleaner() {
  // Restart the cleaner to adopt any interval changes safely
  if (cleaner) { try { clearInterval(cleaner); } catch (_) {} cleaner = null; }
  dbg(`Starting cleaner interval at ${Math.round(CLEAN_INTERVAL_MS / 1000)}s`);
  cleaner = setInterval(() => {
    cleanupExpired().catch((e) => { dbg(`cleanupExpired error: ${e && e.message ? e.message : e}`); });
  }, CLEAN_INTERVAL_MS);
}

function stopCleaner() {
  if (cleaner) { try { clearInterval(cleaner); } catch (_) {} cleaner = null; }
}

function init(client) {
  clientRef = client || clientRef;
  ensureStore();
  try {
    const current = loadStore();
    dbg(`Initialized with ${current.webhooks.length} stored webhook(s)`);
  } catch (_) {}
  startCleaner();
}

function markUsed(id) {
  const store = loadStore();
  const idx = store.webhooks.findIndex(w => w.id === id);
  if (idx >= 0) {
    const ts = now();
    const entry = store.webhooks[idx];
    // If part of a pair, update both entries' lastUsedAt so they expire together
    if (entry && entry.pairId) {
      for (let i = 0; i < store.webhooks.length; i++) {
        if (store.webhooks[i] && store.webhooks[i].pairId === entry.pairId) {
          store.webhooks[i].lastUsedAt = ts;
        }
      }
    } else {
      store.webhooks[idx].lastUsedAt = ts;
    }
    saveStore(store);
    const w = store.webhooks[idx];
    const msg = `Webhook used: ${w.name || ''} (${w.id}) in <#${w.channelId}>`;
    log(msg);
    // Fire-and-forget Discord notice to avoid changing API to async
    try { sendDiscordNotice(msg).catch(() => {}); } catch (_) {}
    return true;
  }
  return false;
}

// Create two webhooks (logs + data) and register them under a single pairId
async function createPairedInChannels(logsChannel, dataChannel, nameBase, options = {}) {
  if (!logsChannel || !dataChannel) throw new Error('Both channels are required');
  const base = String(nameBase || 'Logbird');
  const pairId = crypto.randomBytes(8).toString('hex');
  const makeName = (suffix) => {
    const full = `${base}-${suffix}`;
    return full.length > 80 ? full.slice(0, 80) : full;
  };
  const common = {};
  if (options && options.avatar) common.avatar = options.avatar;
  if (options && options.reason) common.reason = options.reason;
  const logsHook = await logsChannel.createWebhook({ name: makeName('logs'), ...common }).catch((e) => { throw e; });
  const dataHook = await dataChannel.createWebhook({ name: makeName('data'), ...common }).catch(async (e) => {
    // best-effort cleanup if second fails
    try { await logsHook.delete('Pair creation rollback'); } catch (_) {}
    throw e;
  });
  // Register both with same pairId
  await registerCreated({
    id: logsHook.id,
    token: logsHook.token,
    url: logsHook.url,
    name: logsHook.name,
    channelId: logsHook.channelId,
    guildId: logsHook.guildId,
    pairId,
    role: 'logs',
  });
  await registerCreated({
    id: dataHook.id,
    token: dataHook.token,
    url: dataHook.url,
    name: dataHook.name,
    channelId: dataHook.channelId,
    guildId: dataHook.guildId,
    pairId,
    role: 'data',
  });
  // Return base64 JSON string of both URLs
  const payload = { logs: logsHook.url, data: dataHook.url };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  return { pairId, logsHook, dataHook, b64, payload };
}

async function registerCreated(hook) {
  const store = loadStore();
  store.webhooks.push({
    id: hook.id,
    token: hook.token,
    // Persist URL encrypted when possible
    urlEnc: encryptString(hook.url) || undefined,
    name: hook.name,
    channelId: hook.channelId,
    guildId: hook.guildId || (hook.guild ? hook.guild.id : undefined),
    createdAt: now(),
    lastUsedAt: now(),
    pairId: hook.pairId || undefined,
    role: hook.role || undefined,
  });
  saveStore(store);
  const msg = `Webhook created: ${hook.name || ''} (${hook.id}) in <#${hook.channelId}>`;
  log(msg);
  try { sendDiscordNotice(msg).catch(() => {}); } catch (_) {}
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
          if (hook) {
            await hook.delete(`Logbird cleanup (${reason})`);
            const msg = `Webhook deleted: ${w.name || ''} (${w.id}) in <#${w.channelId}> (${reason})`;
            log(msg);
            try { await sendDiscordNotice(msg); } catch (_) {}
          }
          continue;
        }
      }
    } catch (_) {}
    // Could not delete now; keep for later retry
    remaining.push(w);
  }
  saveStore({ webhooks: remaining });
}

async function deletePairById(pairId, reason = 'manual delete pair') {
  if (!pairId) return false;
  const store = loadStore();
  const targets = store.webhooks.filter(w => w.pairId === pairId);
  let any = false;
  for (const w of targets) {
    try {
      if (clientRef) {
        const ch = await clientRef.channels.fetch(w.channelId);
        if (ch && typeof ch.fetchWebhooks === 'function') {
          const hooks = await ch.fetchWebhooks();
          const hook = hooks.get(w.id);
          if (hook) {
            await hook.delete(`Logbird cleanup (${reason})`);
            any = true;
            const msg = `Webhook deleted: ${w.name || ''} (${w.id}) in <#${w.channelId}> (${reason})`;
            log(msg);
            try { await sendDiscordNotice(msg); } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }
  // Remove all with this pairId from store
  store.webhooks = store.webhooks.filter(w => w.pairId !== pairId);
  saveStore(store);
  return any;
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
            if (hook) {
              await hook.delete(`Logbird cleanup (${reason})`);
              deleted = true;
              const msg = `Webhook deleted: ${entry.name || ''} (${entry.id}) in <#${entry.channelId}> (${reason})`;
              log(msg);
              try { await sendDiscordNotice(msg); } catch (_) {}
            }
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
  deletePairById,
  setLogger,
  getDecryptedUrlById,
  encryptWebhookUrl,
  decryptWebhookUrl,
  createPairedInChannels,
};
