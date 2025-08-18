// send-webhook.js
// Standalone CLI to send messages to a Discord webhook (sender app)
// Usage examples:
//   node send-webhook.js --url https://discord.com/api/webhooks/ID/TOKEN --content "Hello world"
//   node send-webhook.js --id ID --token TOKEN --content "Hello world" --username "Logbird"
//   echo '{"url":"https://discord.com/api/webhooks/ID/TOKEN","content":"Hello"}' | node send-webhook.js --stdin
//   node send-webhook.js --url https://discord.com/api/webhooks/ID/TOKEN --content "Here is a file" --file ./path/to/file.txt
//   node send-webhook.js --id ID --token TOKEN --payloadJson ./payload.json --file ./a.txt --file ./img.png

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') { args.stdin = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

function help(code = 1) {
  const text = `\nDiscord Webhook Sender\n\nUsage:\n  node send-webhook.js --url <webhookUrl> [--content <text>] [--username <name>] [--embedsJson <pathOrJson>] [--file <path> ...]\n  node send-webhook.js --id <id> --token <token> [--content <text>] [--username <name>] [--embedsJson <pathOrJson>] [--file <path> ...]\n  echo '{"url":"https://discord.com/api/webhooks/ID/TOKEN","content":"Hello"}' | node send-webhook.js --stdin\n\nOptions:\n  --url           Full Discord webhook URL\n  --id            Webhook ID (used with --token)\n  --token         Webhook token (used with --id)\n  --content       Message content (default: "Hello world from sender app!")\n  --username      Override webhook username (optional)\n  --embedsJson    JSON string or path to a JSON file containing an array of embeds\n  --file          File path to attach (repeatable). Up to 10 files.\n  --payloadJson   JSON string or path to JSON with the full payload (alternative to --content/--embedsJson)\n  --stdin         Read a JSON object from stdin with fields: { url|id+token, content, username, embeds }\n`;
  console.log(text);
  process.exit(code);
}

function toUrlFrom(id, token) {
  return `https://discord.com/api/webhooks/${encodeURIComponent(id)}/${encodeURIComponent(token)}`;
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

function parseEmbeds(input) {
  if (!input) return undefined;
  // Try file path first
  const fileText = readFileSafe(input);
  const raw = fileText != null ? fileText : input;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch (_) {
    return undefined;
  }
}

function parsePayloadJson(input) {
  if (!input) return undefined;
  const fileText = readFileSafe(input);
  const raw = fileText != null ? fileText : input;
  try { return JSON.parse(raw); } catch (_) { return undefined; }
}

function detectContentType(filename) {
  const ext = (filename || '').toLowerCase();
  if (ext.endsWith('.png')) return 'image/png';
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'image/jpeg';
  if (ext.endsWith('.gif')) return 'image/gif';
  if (ext.endsWith('.webp')) return 'image/webp';
  if (ext.endsWith('.txt') || ext.endsWith('.log')) return 'text/plain; charset=utf-8';
  if (ext.endsWith('.json')) return 'application/json';
  if (ext.endsWith('.pdf')) return 'application/pdf';
  if (ext.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (ext.endsWith('.csv')) return 'text/csv; charset=utf-8';
  if (ext.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

function normalizeArray(val) {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

function loadFiles(argValues) {
  const files = [];
  const arr = normalizeArray(argValues);
  for (const entry of arr) {
    if (!entry || typeof entry !== 'string') continue;
    // Allow overrides: path:filename or path=filename
    let p = entry; let nameOverride = null;
    const m = entry.match(/^(.*?)[=:](.+)$/);
    if (m) { p = m[1]; nameOverride = m[2]; }
    try {
      const buf = fs.readFileSync(p);
      const originalName = nameOverride || path.basename(p);
      files.push({ filename: originalName, buffer: buf, contentType: detectContentType(originalName) });
      if (files.length >= 10) break; // Discord max 10 files
    } catch (_) { /* skip unreadable file */ }
  }
  return files;
}

function buildMultipartBody(payloadObj, files) {
  const boundary = '----logbird-' + Math.random().toString(36).slice(2);
  const chunks = [];

  function push(s) { chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8')); }

  // payload_json part
  push(`--${boundary}\r\n`);
  push('Content-Disposition: form-data; name="payload_json"\r\n');
  push('Content-Type: application/json; charset=utf-8\r\n\r\n');
  push(JSON.stringify(payloadObj || {}));
  push('\r\n');

  // files parts
  const list = files || [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const fieldName = `files[${i}]`;
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${fieldName}"; filename="${f.filename.replace(/"/g, '')}"\r\n`);
    push(`Content-Type: ${f.contentType}\r\n\r\n`);
    push(f.buffer);
    push('\r\n');
  }

  // closing boundary
  push(`--${boundary}--\r\n`);

  return { body: Buffer.concat(chunks), boundary };
}

function postByUrl(urlStr, bodyObj) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const opts = {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers: { 'Content-Type': 'application/json' },
      };
      const req = (isHttps ? https : http).request(opts, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(Buffer.from(d)));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body });
        });
      });
      req.on('error', (e) => resolve({ ok: false, status: 0, error: e && e.message ? e.message : String(e) }));
      const buf = Buffer.from(JSON.stringify(bodyObj), 'utf8');
      req.setHeader('Content-Length', Buffer.byteLength(buf));
      req.write(buf);
      req.end();
    } catch (e) {
      resolve({ ok: false, status: 0, error: e && e.message ? e.message : String(e) });
    }
  });
}

function postMultipartByUrl(urlStr, payloadObj, files) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const { body, boundary } = buildMultipartBody(payloadObj, files);
      const opts = {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = (isHttps ? https : http).request(opts, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(Buffer.from(d)));
        res.on('end', () => {
          const resBody = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: resBody });
        });
      });
      req.on('error', (e) => resolve({ ok: false, status: 0, error: e && e.message ? e.message : String(e) }));
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, status: 0, error: e && e.message ? e.message : String(e) });
    }
  });
}

async function main() {
  const args = parseArgs(process.argv);

  let dataFromStdin = null;
  if (args.stdin) {
    dataFromStdin = await new Promise((resolve) => {
      const chunks = [];
      process.stdin.on('data', (d) => chunks.push(Buffer.from(d)));
      process.stdin.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (_) { resolve(null); }
      });
    });
  }

  const url = (args.url) || (args.id && args.token ? toUrlFrom(args.id, args.token) : (dataFromStdin && (dataFromStdin.url || (dataFromStdin.id && dataFromStdin.token && toUrlFrom(dataFromStdin.id, dataFromStdin.token)))));
  if (!url) return help(1);

  const files = loadFiles(args.file);
  const content = (args.content || (dataFromStdin && dataFromStdin.content) || 'Hello world from sender app!');
  const username = (args.username || (dataFromStdin && dataFromStdin.username));
  const embeds = parseEmbeds(args.embedsJson) || (dataFromStdin && dataFromStdin.embeds);
  const payloadJson = parsePayloadJson(args.payloadJson);

  const payload = payloadJson && typeof payloadJson === 'object' ? payloadJson : { content };
  if (username) payload.username = username;
  if (embeds) payload.embeds = embeds;

  const result = files.length > 0 ? await postMultipartByUrl(url, payload, files)
                                 : await postByUrl(url, payload);
  if (!result.ok) {
    console.error('Send failed:', result.status, result.error || result.body);
    process.exit(2);
  }
  console.log('Sent ok:', result.status, result.body || '(no body)');
}

if (require.main === module) {
  main().catch((e) => { console.error('Unexpected error:', e && e.message ? e.message : e); process.exit(2); });
}
