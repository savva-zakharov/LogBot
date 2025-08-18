// src/postWebhook.js
// Discord-compatible webhook helper with edit-on-next-call behavior
// - For Discord webhooks, attempts to PATCH-edit the previous message instead of sending a new one.
// - Falls back to POST with wait=true and stores the returned message id for future edits.
// - For non-Discord hosts, does a simple POST as before.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const REF_FILE = path.join(process.cwd(), '.summary_webhook_refs.json');

function loadRefs() {
  try {
    if (!fs.existsSync(REF_FILE)) return {};
    const raw = fs.readFileSync(REF_FILE, 'utf8');
    const j = JSON.parse(raw || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}

function saveRefs(obj) {
  try { fs.writeFileSync(REF_FILE, JSON.stringify(obj || {}, null, 2), 'utf8'); } catch (_) {}
}

function isDiscordWebhook(u) {
  if (!u) return false;
  const host = (u.hostname || '').toLowerCase();
  return host.includes('discord.com') || host.includes('discordapp.com');
}

function httpRequest(u, opts, bodyObj) {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      method: opts.method || 'POST',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: opts.path,
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(Buffer.from(d)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, body });
        const err = new Error(`HTTP ${res.statusCode}: ${body}`);
        err.status = res.statusCode;
        err.body = body;
        reject(err);
      });
    });
    req.on('error', (e) => reject(e));
    const buf = Buffer.from(JSON.stringify(bodyObj || {}), 'utf8');
    req.setHeader('Content-Length', Buffer.byteLength(buf));
    req.write(buf);
    req.end();
  });
}

async function postToWebhook(urlStr, bodyObj) {
  const u = new URL(urlStr);
  // Non-Discord: simple POST, no edit tracking
  if (!isDiscordWebhook(u)) {
    const pathWithQuery = u.pathname + (u.search || '');
    return httpRequest(u, { method: 'POST', path: pathWithQuery }, bodyObj);
  }

  // Discord webhook: try to edit previous, else send new with wait=true
  const refs = loadRefs();
  const key = urlStr; // key by full webhook URL

  // Attempt edit if we have a stored message id
  const prev = refs[key] && refs[key].messageId ? String(refs[key].messageId) : null;
  if (prev) {
    try {
      // PATCH /webhooks/{id}/{token}/messages/{message.id}
      const editUrl = new URL(urlStr);
      editUrl.pathname = editUrl.pathname.replace(/\/$/, '') + `/messages/${encodeURIComponent(prev)}`;
      const pathWithQuery = editUrl.pathname + (editUrl.search || '');
      const res = await httpRequest(editUrl, { method: 'PATCH', path: pathWithQuery }, bodyObj);
      return res; // edited successfully, keep same id
    } catch (_) {
      // fall through to sending a new message
    }
  }

  // POST a new message with wait=true to receive the created message (and id)
  const postUrl = new URL(urlStr);
  const params = new URLSearchParams(postUrl.search || '');
  if (!params.has('wait')) params.set('wait', 'true');
  postUrl.search = '?' + params.toString();
  const created = await httpRequest(postUrl, { method: 'POST', path: postUrl.pathname + postUrl.search }, bodyObj);
  try {
    const parsed = JSON.parse(created.body || '{}');
    if (parsed && parsed.id) {
      refs[key] = { messageId: String(parsed.id) };
      saveRefs(refs);
    }
  } catch (_) {}
  return created;
}

module.exports = { postToWebhook };
