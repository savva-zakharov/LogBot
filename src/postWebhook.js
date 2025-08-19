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


function buildMultipartPayload(bodyObj, files) {
  // Build multipart/form-data buffer with payload_json and files[n]
  const boundary = '----LogBotBoundary' + Math.random().toString(16).slice(2);
  const CRLF = '\r\n';
  const parts = [];
  const pushField = (name, value) => {
    parts.push(Buffer.from(`--${boundary}${CRLF}`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`));
    parts.push(Buffer.from(String(value)));
    parts.push(Buffer.from(CRLF));
  };
  const pushFile = (index, file) => {
    const fieldName = `files[${index}]`;
    const filename = file.filename || `file${index}`;
    const contentType = file.contentType || 'application/octet-stream';
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content || ''), 'utf8');
    parts.push(Buffer.from(`--${boundary}${CRLF}`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"${CRLF}`));
    parts.push(Buffer.from(`Content-Type: ${contentType}${CRLF}${CRLF}`));
    parts.push(content);
    parts.push(Buffer.from(CRLF));
  };

  // Discord expects payload_json for the message body
  const payloadForJson = { ...bodyObj };
  delete payloadForJson.files; // files are in multipart, not inside payload_json
  pushField('payload_json', JSON.stringify(payloadForJson || {}));
  (files || []).forEach((f, i) => pushFile(i, f));
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));
  const buffer = Buffer.concat(parts);
  return { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, buffer };
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
    if (opts && opts.multipart && opts.multipart.buffer) {
      // multipart form payload
      const m = opts.multipart;
      if (m.headers && m.headers['Content-Type']) req.setHeader('Content-Type', m.headers['Content-Type']);
      req.setHeader('Content-Length', Buffer.byteLength(m.buffer));
      req.write(m.buffer);
    } else {
      // JSON payload
      const buf = Buffer.from(JSON.stringify(bodyObj || {}), 'utf8');
      req.setHeader('Content-Length', Buffer.byteLength(buf));
      req.write(buf);
    }
    req.end();
  });
}

async function postToWebhook(urlStr, bodyObj, options = {}) {
  const u = new URL(urlStr);
  // Non-Discord: simple POST, no edit tracking
  if (!isDiscordWebhook(u)) {
    const pathWithQuery = u.pathname + (u.search || '');
    // If files are present, send as multipart to non-Discord as well (best effort)
    if (bodyObj && Array.isArray(bodyObj.files) && bodyObj.files.length) {
      const mp = buildMultipartPayload(bodyObj, bodyObj.files);
      return httpRequest(u, { method: 'POST', path: pathWithQuery, multipart: mp }, bodyObj);
    }
    return httpRequest(u, { method: 'POST', path: pathWithQuery }, bodyObj);
  }

  // Determine mode: 'auto' (default), 'edit' (try edit, else new), 'new' (force new)
  const mode = String(options.mode || 'auto').toLowerCase();
  const refs = loadRefs();
  const key = urlStr; // key by full webhook URL

  if (mode !== 'new') {
    // Attempt edit if we have a stored message id
    const prev = refs[key] && refs[key].messageId ? String(refs[key].messageId) : null;
    if (prev) {
      try {
        // PATCH /webhooks/{id}/{token}/messages/{message.id}
        const editUrl = new URL(urlStr);
        editUrl.pathname = editUrl.pathname.replace(/\/$/, '') + `/messages/${encodeURIComponent(prev)}`;
        const pathWithQuery = editUrl.pathname + (editUrl.search || '');
        // For Discord edits with files, use multipart too
        let res;
        if (bodyObj && Array.isArray(bodyObj.files) && bodyObj.files.length) {
          const mp = buildMultipartPayload(bodyObj, bodyObj.files);
          res = await httpRequest(editUrl, { method: 'PATCH', path: pathWithQuery, multipart: mp }, bodyObj);
        } else {
          res = await httpRequest(editUrl, { method: 'PATCH', path: pathWithQuery }, bodyObj);
        }
        return res; // edited successfully, keep same id
      } catch (_) {
        // fall through to sending a new message
      }
    }
  }

  // POST a new message with wait=true to receive the created message (and id)
  const postUrl = new URL(urlStr);
  const params = new URLSearchParams(postUrl.search || '');
  if (!params.has('wait')) params.set('wait', 'true');
  postUrl.search = '?' + params.toString();
  let created;
  if (bodyObj && Array.isArray(bodyObj.files) && bodyObj.files.length) {
    const mp = buildMultipartPayload(bodyObj, bodyObj.files);
    created = await httpRequest(postUrl, { method: 'POST', path: postUrl.pathname + postUrl.search, multipart: mp }, bodyObj);
  } else {
    created = await httpRequest(postUrl, { method: 'POST', path: postUrl.pathname + postUrl.search }, bodyObj);
  }
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
