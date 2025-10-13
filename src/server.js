// src/server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const state = require('./state');
const { loadSettings } = require('./config');
const discord = require('./discordBot');
const { processMissionEnd, postLogs } = require('./missionEnd');
const { postToWebhook } = require('./postWebhook');

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
        } else if (pathname === '/api/map-tracks' && req.method === 'GET') {
            try {
                let gameParam = url.searchParams.get('game');
                if (!gameParam) gameParam = String(state.getCurrentGame());
                const tracks = state.getMapTracks(gameParam);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ game: String(gameParam), tracks }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read map tracks' }));
            }
        } else if (pathname === '/api/record-win' && req.method === 'POST') {
            try {
                const gameParam = String(state.getCurrentGame());
                state.recordResult(gameParam, 'win');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, game: gameParam, result: 'win' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to record win' }));
            }
        } else if (pathname === '/api/record-loss' && req.method === 'POST') {
            try {
                const gameParam = String(state.getCurrentGame());
                state.recordResult(gameParam, 'loss');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, game: gameParam, result: 'loss' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to record loss' }));
            }
        } else if (pathname === '/api/map-tracks' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; if (body.length > 2e7) req.destroy(); });
            req.on('end', () => {
                try {
                    let gameParam = url.searchParams.get('game');
                    if (!gameParam) gameParam = String(state.getCurrentGame());
                    const j = JSON.parse(body || '{}');
                    const arr = (j && Array.isArray(j.tracks)) ? j.tracks : [];
                    const result = state.setMapTracks(gameParam, arr);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ game: String(gameParam), ...result }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid map tracks payload' }));
                }
            });
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
        } else if (pathname === '/api/state' && req.method === 'GET') {
            try {
                const all = state.getAllData ? state.getAllData() : {};
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(all));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Failed to read state' }));
            }
        } else if (pathname === '/api/submit-json' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; if (body.length > 10e6) req.destroy(); });
            req.on('end', async () => {
                try {
                    const j = JSON.parse(body || '{}');
                    const payload = (j && typeof j === 'object' && j.data && typeof j.data === 'object') ? j.data : j;
                    const result = state.replaceAllData(payload);
                    if (!result || result.ok !== true) {
                        throw new Error((result && result.error) || 'State update failed');
                    }
                    // Optional webhook notify (prefer dataWebhookUrl, fallback to summaryWebhookUrl)
                    try {
                        const settings = loadSettings();
                        const webhookUrl = settings && (settings.dataWebhookUrl || settings.summaryWebhookUrl);
                        if (webhookUrl) {
                            const meta = { submittedAt: new Date().toISOString(), size: Buffer.byteLength(JSON.stringify(payload || {}), 'utf8') };
                            // Attach the on-disk parsed_data.json
                            const jsonPath = path.join(process.env.LOGBOT_DATA_DIR || process.cwd(), 'parsed_data.json');
                            let files = [];
                            try {
                                const buf = fs.readFileSync(jsonPath);
                                files.push({ filename: 'parsed_data.json', contentType: 'application/json', content: buf });
                            } catch (_) { /* missing file is fine */ }
                            await postToWebhook(webhookUrl, { content: 'LogBot: JSON submitted', embeds: [], username: 'LogBot', files, meta, data: payload }, { mode: 'new' });
                        }
                    } catch (_) { /* ignore webhook errors */ }
                    broadcast({ type: 'update', message: 'State updated via submit-json', data: { ok: true } });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ ok: true, currentGame: result.currentGame }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: e && e.message ? e.message : 'Bad Request' }));
                }
            });
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
            const htmlPath = path.join(__dirname, '../public/index.html');
            fs.readFile(htmlPath, (err, data) => {
                if (err) {
                    res.writeHead(500);
                    res.end('Error loading index.html');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        } else if (pathname === '/api/map-img') {
          // Proxy the War Thunder local map image, while also saving a copy to maps/ and recording its path per game
          try {
            const httpModule = require('http');
            const { PassThrough } = require('stream');
            const query = url.search || '';
            const options = {
              hostname: 'localhost',
              port: 8111,
              path: '/map.img' + query,
              method: 'GET',
            };
            const proxyReq = httpModule.request(options, (proxyRes) => {
              const contentType = proxyRes.headers['content-type'] || 'image/png';
              const contentLength = (proxyRes.headers['content-length'] != null) ? parseInt(proxyRes.headers['content-length'], 10) : null;

              // Determine if this incoming image should be ignored based on matching a known-bad file size
              const baseDir = process.env.LOGBOT_DATA_DIR || process.cwd();
              const ignorePath = path.join(baseDir, 'maps', 'game1_gen1_1755913257574.png');
              let ignoreSize = null;
              try { const st = fs.statSync(ignorePath); ignoreSize = st.size; } catch (_) {}
              const shouldIgnoreThisImage = (ignoreSize != null && contentLength != null && contentLength === ignoreSize);

              if (shouldIgnoreThisImage) {
                // Return 404 so the client Image.onerror keeps the previous image
                res.writeHead(404, {
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'no-store'
                });
                try { proxyRes.destroy(); } catch (_) {}
                return res.end('Ignored known-bad map image');
              }

              // Normal OK response headers
              res.writeHead(200, {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store'
              });

              const genParam = parseInt(url.searchParams.get('gen') || '', 10);
              const gen = Number.isFinite(genParam) ? genParam : null;
              const gameId = state.getCurrentGame();
              const prevInfo = state.getMapImageInfo ? state.getMapImageInfo(gameId) : { gen: null, path: '' };
              const shouldSave = (gen != null) && (prevInfo.gen !== gen || !prevInfo.path);

              if (!shouldSave) {
                // Just proxy through to client
                proxyRes.pipe(res);
                return;
              }

              // Save a copy on gen change
              const mapsDir = path.join(baseDir, 'maps');
              try { fs.mkdirSync(mapsDir, { recursive: true }); } catch (_) {}
              const ext = (contentType && /jpeg/i.test(contentType)) ? '.jpg' : '.png';
              const fname = `game${gameId}_${gen != null ? 'gen'+gen+'_' : ''}${Date.now()}${ext}`;
              const relPath = path.join('maps', fname);
              const absPath = path.join(mapsDir, fname);
              const tmpPath = absPath + '.tmp';

              const tee = new PassThrough();
              const fileStream = fs.createWriteStream(tmpPath);
              proxyRes.pipe(tee);
              tee.pipe(res);
              tee.pipe(fileStream);

              fileStream.on('finish', () => {
                try {
                  // Determine size of the downloaded image
                  let size = null;
                  try { const st = fs.statSync(tmpPath); size = st.size; } catch (_) {}

                  // Look for an existing file in maps/ with the same size
                  let reusedRel = null;
                  if (size != null) {
                    try {
                      const files = fs.readdirSync(mapsDir);
                      for (const f of files) {
                        const p = path.join(mapsDir, f);
                        try {
                          const st = fs.statSync(p);
                          if (st.isFile() && st.size === size) {
                            reusedRel = path.join('maps', f).replace(/\\/g, '/');
                            break;
                          }
                        } catch (_) { /* skip */ }
                      }
                    } catch (_) { /* ignore directory read issues */ }
                  }

                  if (reusedRel) {
                    // A same-sized file already exists; discard temp and record existing path
                    try { fs.unlinkSync(tmpPath); } catch (_) {}
                    state.setMapImageInfo(gameId, { path: reusedRel, gen, size });
                  } else {
                    // No existing match; keep new file: rename temp -> final and update metadata
                    try { fs.renameSync(tmpPath, absPath); } catch (_) { /* fallback: keep temp name if rename fails */ }
                    const finalExists = fs.existsSync(absPath);
                    const rel = (finalExists ? relPath : path.join('maps', path.basename(tmpPath))).replace(/\\/g, '/');
                    state.setMapImageInfo(gameId, { path: rel, gen, size });
                  }
                } catch (_) { /* ignore meta errors */ }
              });
              fileStream.on('error', () => {
                // Ignore file save errors for the client response
              });
            });
            proxyReq.on('error', (e) => {
              res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
              res.end('Bad Gateway fetching map image');
            });
            proxyReq.end();
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            res.end('Failed to proxy map image');
          }
        } else if (pathname === '/api/map-info') {
            // Proxy map info JSON providing world extents, size, etc.
            try {
                const httpModule = require('http');
                const options = { hostname: 'localhost', port: 8111, path: '/map_info.json', method: 'GET' };
                const proxyReq = httpModule.request(options, (proxyRes) => {
                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-store'
                    });
                    proxyRes.pipe(res);
                });
                proxyReq.on('error', () => {
                    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'Bad Gateway fetching map info' }));
                });
                proxyReq.end();
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Failed to proxy map info' }));
            }
        } else if (pathname === '/api/map-objects') {
            // Proxy map objects JSON (icons/markers) from the telemetry server
            try {
                const httpModule = require('http');
                const options = { hostname: 'localhost', port: 8111, path: '/map_obj.json', method: 'GET' };
                const proxyReq = httpModule.request(options, (proxyRes) => {
                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-store'
                    });
                    proxyRes.pipe(res);
                });
                proxyReq.on('error', () => {
                    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'Bad Gateway fetching map objects' }));
                });
                proxyReq.end();
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Failed to proxy map objects' }));
            }
        } else if (pathname === '/settings') {
          const filePath = path.join(__dirname, '../public/settings.html');
          fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not Found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
          });
        } else if (pathname === '/map') {
            const filePath = path.join(__dirname, '../public/map.html');
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404); return res.end('Not Found'); }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        } else if (pathname === '/side') {
            const filePath = path.join(__dirname, '../public/side.html');
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404); return res.end('Not Found'); }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        } else if (pathname === '/graph.html' || pathname === '/graph') {
            const filePath = path.join(__dirname, '../public/graph.html');
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
                const { buildMergedSummary } = require('./utils/summaryFormatter');
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
        } else if (pathname === '/api/squadron-history') {
            const oldLogsDir = path.join(process.cwd(), 'old_logs');
            fs.readdir(oldLogsDir, (err, files) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Failed to read old_logs directory' }));
                }

                const squadronDataFiles = files.filter(f => f.startsWith('squadron_data-') && f.endsWith('.json'));
                let allPoints = [];

                squadronDataFiles.forEach(file => {
                    const filePath = path.join(oldLogsDir, file);
                    try {
                        const content = fs.readFileSync(filePath, 'utf8');
                        const json = JSON.parse(content);
                        if (json && Array.isArray(json.squadronSnapshots)) {
                            json.squadronSnapshots.forEach(item => {
                                if (item.totalPoints && item.ts) {
                                    allPoints.push({
                                        ts: item.ts,
                                        totalPoints: item.totalPoints
                                    });
                                }
                            });
                        }
                    } catch (e) {
                        // Ignore errors for individual files
                    }
                });

                allPoints.sort((a, b) => a.ts - b.ts);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(allPoints));
            });
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
