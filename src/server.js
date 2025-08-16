// src/server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const state = require('./state');
const { loadSettings } = require('./config');
const discord = require('./discordBot');
const { processMissionEnd, postLogs } = require('./missionEnd');

let wss;

function parseEnvFile(content) {
  const out = {};
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line || /^\s*#/.test(line)) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1);
    if (key) out[key] = val;
  }
  return out;
}

function serializeEnv(obj) {
  const header = '# LogBot settings (secrets and ports)';
  const keys = Object.keys(obj);
  keys.sort();
  const lines = [header];
  for (const k of keys) lines.push(`${k}=${obj[k] ?? ''}`);
  lines.push('');
  return lines.join('\n');
}

function broadcast(data) {
  if (!wss) return;
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function startServer() {
  const { port, wsPort } = loadSettings();
  const server = http.createServer((req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

        if (pathname === '/api/active-vehicles') {
            const gameParam = url.searchParams.get('game');
            const activeVehicles = state.getActiveVehicles(gameParam);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(activeVehicles));
        } else if (pathname === '/api/current-game') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ currentGame: state.getCurrentGame() }));
        } else if (pathname === '/api/meta' && req.method === 'GET') {
            try {
              let gameParam = url.searchParams.get('game');
              if (!gameParam) gameParam = String(state.getCurrentGame());
              const meta = state.getGameMeta(gameParam);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ game: String(gameParam), meta }));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to read meta' }));
            }
        } else if (pathname === '/api/meta' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
            req.on('end', () => {
              try {
                let gameParam = url.searchParams.get('game');
                if (!gameParam) gameParam = String(state.getCurrentGame());
                const j = JSON.parse(body || '{}');
                const saved = state.setGameMeta(gameParam, {
                  squadNo: j.squadNo,
                  gc: j.gc,
                  ac: j.ac,
                });
                broadcast({ type: 'update', message: `Meta updated for game ${gameParam}`, data: { game: String(gameParam), meta: saved } });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ game: String(gameParam), meta: saved }));
              } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid meta payload' }));
              }
            });
        } else if (pathname === '/api/games-list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(state.getGamesList()));
        } else if (pathname === '/api/summaries') {
            const gameParam = url.searchParams.get('game');
            const summaries = state.getSquadronSummaries(gameParam === 'all' ? null : gameParam);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(summaries));
        } else if (pathname === '/api/highlights') {
            const settings = loadSettings();
            const payload = { players: settings.players || {}, squadrons: settings.squadrons || {} };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        } else if (pathname === '/api/result' && req.method === 'POST') {
            const type = url.searchParams.get('type');
            let gameParam = url.searchParams.get('game');
            try {
                const payload = processMissionEnd(type, gameParam);
                broadcast({ type: 'update', message: `Result recorded for game ${payload.game}`, data: { result: payload.type, game: payload.game } });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(payload));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e && e.message ? e.message : 'Bad Request' }));
            }
        } else if (pathname === '/api/post-logs' && req.method === 'POST') {
            let gameParam = url.searchParams.get('game');
            try {
                const payload = postLogs(gameParam);
                broadcast({ type: 'update', message: `Logs posted for game ${payload.game}`, data: { posted: true, game: payload.game } });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(payload));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e && e.message ? e.message : 'Bad Request' }));
            }
        } else if (pathname === '/api/reset' && req.method === 'POST') {
            try {
                const payload = state.resetData();
                broadcast({ type: 'reset', message: 'State has been reset', data: payload });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(payload));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e && e.message ? e.message : 'Failed to reset state' }));
            }
        } else if (pathname === '/') {
            const htmlPath = path.join(__dirname, '../index.html');
            fs.readFile(htmlPath, (err, data) => {
                if (err) {
                    res.writeHead(500);
                    res.end('Error loading index.html');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        } else if (pathname === '/settings') {
            const filePath = path.join(__dirname, '../public/settings.html');
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404); return res.end('Not Found'); }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        } else if (pathname.startsWith('/public/')) {
            const filePath = path.join(__dirname, '..', pathname);
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404); return res.end('Not Found'); }
                const ext = path.extname(filePath).toLowerCase();
                const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
                res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
                res.end(data);
            });
        } else if (pathname.startsWith('/favicon')) {
            const iconPath = path.join(__dirname, '..', pathname);
             fs.readFile(iconPath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('Not Found');
                    return;
                }
                const ext = path.extname(pathname).toLowerCase();
                let contentType = 'image/x-icon';
                if (ext === '.svg') contentType = 'image/svg+xml';
                if (ext === '.png') contentType = 'image/png';
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(data);
            });
        } else if (pathname === '/api/settings-env' && req.method === 'GET') {
            const envPath = path.join(process.cwd(), 'settings.env');
            let envObj = {};
            try { envObj = parseEnvFile(fs.readFileSync(envPath, 'utf8')); } catch (_) {}
            // Obfuscate sensitive values in response
            if (envObj.DISCORD_BOT_TOKEN) {
              envObj.DISCORD_BOT_TOKEN = '********';
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(envObj));
        } else if (pathname === '/api/results' && req.method === 'GET') {
            try {
                const map = state.getResultsMap ? state.getResultsMap() : (state.data && state.data._results) || {};
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(map));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Failed to read results' }));
            }
        } else if (pathname === '/api/merged-summary' && req.method === 'GET') {
            try {
                const { buildMergedSummary } = require('./summaryFormatter');
                const payload = buildMergedSummary();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(payload));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Failed to build merged summary' }));
            }
        } else if (pathname === '/api/settings-env' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
            req.on('end', () => {
                try {
                    const envPath = path.join(process.cwd(), 'settings.env');
                    let current = {};
                    try { current = parseEnvFile(fs.readFileSync(envPath, 'utf8')); } catch (_) {}
                    const j = JSON.parse(body || '{}');
                    const updates = (j && j.updates && typeof j.updates === 'object') ? j.updates : {};
                    // If token missing, empty, or masked, do not overwrite existing
                    if (!Object.prototype.hasOwnProperty.call(updates, 'DISCORD_BOT_TOKEN') || updates.DISCORD_BOT_TOKEN === '' || updates.DISCORD_BOT_TOKEN === '********') {
                      delete updates.DISCORD_BOT_TOKEN;
                    }
                    // Merge
                    const merged = { ...current, ...updates };
                    // Backup existing
                    try { if (fs.existsSync(envPath)) fs.copyFileSync(envPath, envPath + '.bak'); } catch (_) {}
                    fs.writeFileSync(envPath, serializeEnv(merged), 'utf8');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e && e.message ? e.message : 'Bad Request' }));
                }
            });
        } else if (pathname === '/api/settings-json' && req.method === 'GET') {
            const jsonPath = path.join(process.cwd(), 'settings.json');
            try {
              const txt = fs.readFileSync(jsonPath, 'utf8');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(txt);
            } catch (e) {
              // If missing, return minimal default structure
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ players: {}, squadrons: {} }, null, 2));
            }
        } else if (pathname === '/api/settings-json' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; if (body.length > 5e6) req.destroy(); });
            req.on('end', () => {
                try {
                    const jsonPath = path.join(process.cwd(), 'settings.json');
                    // Expect raw JSON text in { text } or object in { data }
                    const j = JSON.parse(body || '{}');
                    let content = '';
                    if (typeof j.text === 'string') {
                      // Validate
                      JSON.parse(j.text);
                      content = j.text;
                    } else if (j && typeof j.data === 'object') {
                      content = JSON.stringify(j.data, null, 2);
                    } else {
                      throw new Error('Expected {text} with JSON string or {data} object');
                    }
                    // Backup existing
                    try { if (fs.existsSync(jsonPath)) fs.copyFileSync(jsonPath, jsonPath + '.bak'); } catch (_) {}
                    fs.writeFileSync(jsonPath, content, 'utf8');
                    // Immediately reload settings and return them
                    const updated = loadSettings();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, settings: updated }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e && e.message ? e.message : 'Bad Request' }));
                }
            });
        } else if (pathname === '/api/settings-reload' && req.method === 'GET') {
            try {
              const settings = loadSettings();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(settings));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e && e.message ? e.message : 'Failed to reload settings' }));
            }
        } else if (pathname === '/api/restart' && req.method === 'POST') {
            // Touch a restart flag file to trigger nodemon file watch based restart.
            try {
              const flagPath = path.join(process.cwd(), 'restart.flag');
              fs.writeFileSync(flagPath, String(Date.now()), 'utf8');
              console.log('♻️  Restart flag touched to trigger nodemon.');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, message: 'Restart signal sent (touch restart.flag). If not using nodemon, restart manually.' }));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to write restart flag: ' + (e && e.message ? e.message : e) }));
            }
        }
        else {
            res.writeHead(404);
            res.end('Not Found');
        }
    } catch (e) {
        console.error("HTTP Server Error:", e);
        res.writeHead(500);
        res.end("Internal Server Error");
    }
  });

  server.listen(port, () => {
    console.log(`🌐 Web interface available at http://localhost:${port}`);
  });

  wss = new WebSocket.Server({ port: wsPort });
  wss.on('connection', () => {
    console.log('📡 WebSocket client connected');
  });
  console.log(`📡 WebSocket server running on port ${wsPort}`);
  
  return { server, wss };
}

module.exports = {
  startServer,
  broadcast,
};
