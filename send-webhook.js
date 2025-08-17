// send-webhook.js
// Standalone CLI to send messages to a Discord webhook (sender app)
// Usage examples:
//   node send-webhook.js --url https://discord.com/api/webhooks/ID/TOKEN --content "Hello world"
//   node send-webhook.js --id ID --token TOKEN --content "Hello world" --username "Logbird"
//   echo '{"url":"https://discord.com/api/webhooks/ID/TOKEN","content":"Hello"}' | node send-webhook.js --stdin

const http = require('http');
const https = require('https');

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
  const text = `\nDiscord Webhook Sender\n\nUsage:\n  node send-webhook.js --url <webhookUrl> [--content <text>] [--username <name>] [--embedsJson <pathOrJson>]\n  node send-webhook.js --id <id> --token <token> [--content <text>] [--username <name>] [--embedsJson <pathOrJson>]\n  echo '{"url":"https://discord.com/api/webhooks/ID/TOKEN","content":"Hello"}' | node send-webhook.js --stdin\n\nOptions:\n  --url           Full Discord webhook URL\n  --id            Webhook ID (used with --token)\n  --token         Webhook token (used with --id)\n  --content       Message content (default: "Hello world from sender app!")\n  --username      Override webhook username (optional)\n  --embedsJson    JSON string or path to a JSON file containing an array of embeds\n  --stdin         Read a JSON object from stdin with fields: { url|id+token, content, username, embeds }\n`;
  console.log(text);
  process.exit(code);
}

function toUrlFrom(id, token) {
  return `https://discord.com/api/webhooks/${encodeURIComponent(id)}/${encodeURIComponent(token)}`;
}

function readFileSafe(path) {
  try { return require('fs').readFileSync(path, 'utf8'); } catch (_) { return null; }
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

  const content = (args.content || (dataFromStdin && dataFromStdin.content) || 'Hello world from sender app!');
  const username = (args.username || (dataFromStdin && dataFromStdin.username));
  const embeds = parseEmbeds(args.embedsJson) || (dataFromStdin && dataFromStdin.embeds);

  const payload = { content };
  if (username) payload.username = username;
  if (embeds) payload.embeds = embeds;

  const result = await postByUrl(url, payload);
  if (!result.ok) {
    console.error('Send failed:', result.status, result.error || result.body);
    process.exit(2);
  }
  console.log('Sent ok:', result.status, result.body || '(no body)');
}

if (require.main === module) {
  main().catch((e) => { console.error('Unexpected error:', e && e.message ? e.message : e); process.exit(2); });
}
