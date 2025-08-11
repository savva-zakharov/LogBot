// src/server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const state = require('./state');
const { loadSettings } = require('./config');
const discord = require('./discordBot');

let wss;

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

        if (pathname === '/api/active-vehicles') {
            const gameParam = url.searchParams.get('game');
            const activeVehicles = state.getActiveVehicles(gameParam);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(activeVehicles));
        } else if (pathname === '/api/current-game') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ currentGame: state.getCurrentGame() }));
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
            if (!['win', 'loss'].includes(type)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'type must be win or loss' }));
            }
            if (!gameParam || gameParam === 'current' || gameParam === 'all') {
                gameParam = String(state.getCurrentGame());
            }
            const numericGame = parseInt(gameParam, 10);
            const result = state.recordResult(numericGame, type);
            broadcast({ type: 'update', message: `Result recorded for game ${gameParam}` });
            // Attempt to post to Discord
            try { discord.postGameSummary(numericGame); } catch (_) {}
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
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

  // Initialize Discord bot (non-blocking)
  const settings = loadSettings();
  try { discord.init(settings); } catch (e) { console.warn('⚠️ Discord init failed:', e && e.message ? e.message : e); }
  
  return { server, wss };
}

module.exports = {
  startServer,
  broadcast,
};
