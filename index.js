    const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const WebSocket = require('ws');
const http = require('http');
const { loadVehicleClassifications: loadVC, classifyVehicleLenient } = require('./classifier');

// Global safety nets: never let the process die silently
process.on('uncaughtException', (err) => {
  try { console.error('❌ Uncaught Exception:', err && err.stack ? err.stack : err); }
  catch (_) {}
});
process.on('unhandledRejection', (reason, promise) => {
  try { console.error('❌ Unhandled Rejection:', reason && reason.stack ? reason.stack : reason); }
  catch (_) {}
});

// Load vehicle classifications
let vehicleClassifications = {}; // category -> [vehicles]
let vehicleToCategory = {}; // vehicle -> category (preferred lookup)

// ---------------- Squadron Summary Mapping ----------------
// Summary output columns order (all categories except Naval)
const OUTPUT_ORDER = [
  'Medium',
  'Heavy',
  'Light',
  'SPG',
  'Fighter',
  'Attacker',
  'Bomber',
  'Helicopter',
  'SPAA'
];

// Map Title Case categories from classifier to summary labels (identity mapping),
// exclude 'Naval' from summaries by not providing a mapping for it
const CATEGORY_TO_OUTPUT = {
  'Medium Tank': 'Medium',
  'Heavy Tank': 'Heavy',
  'Light Tank': 'Light',
  'Tank destroyer': 'SPG',
  'Fighter': 'Fighter',
  'Attacker': 'Attacker',
  'Bomber': 'Bomber',
  'Helicopter': 'Helicopter',
  'SPAA': 'SPAA',
};

const loadVehicleClassifications = () => {
    try {
        const { vehicleToCategory: v2c, vehicleClassifications: cats } = loadVC();
        vehicleToCategory = v2c || {};
        vehicleClassifications = cats || {};
        console.log(`✅ Comprehensive vehicle classifications loaded (${Object.keys(vehicleToCategory).length} vehicles, ${Object.keys(vehicleClassifications).length} categories)`);
        Object.entries(vehicleClassifications).forEach(([category, vehicles]) => {
            console.log(`   - ${category}: ${vehicles.length} vehicles`);
        });
    } catch (error) {
        console.error('❌ Error loading vehicle classifications:', error);
        vehicleClassifications = {};
        vehicleToCategory = {};
    }
};

// Removed local classifyVehicle; use classifier.classifyVehicleLenient directly.

// Global game state variables
let currentGame = 0;
let lastGameIncrementTime = 0;

// Function to load game state from JSON file
const loadGameState = () => {
    const jsonFilePath = path.join(__dirname, 'parsed_data.json');
    
    if (fs.existsSync(jsonFilePath)) {
        try {
            const stats = fs.statSync(jsonFilePath);
            const fileAge = Date.now() - stats.mtime.getTime();
            const oneHourInMs = 60 * 60 * 1000; // 1 hour in milliseconds
            
            if (fileAge < oneHourInMs) {
                console.log(`⏰ JSON file is less than 1 hour old (${Math.round(fileAge / (60 * 1000))} minutes) - keeping existing data`);
                
                // Load existing game state from JSON
                try {
                    const content = fs.readFileSync(jsonFilePath, 'utf8');
                    const data = JSON.parse(content);
                    if (data._gameState && typeof data._gameState.currentGame === 'number') {
                        currentGame = data._gameState.currentGame;
                        lastGameIncrementTime = data._gameState.lastGameIncrementTime || 0;
                        console.log(`🎮 Restored game state - Current game: ${currentGame}`);
                        return true; // Indicate that state was restored
                    }
                } catch (error) {
                    console.log('⚠️ Could not load game state from JSON, starting from 0');
                }
            } else {
                // File is old; do NOT load or infer state from it to avoid stale/duplicate runs
                console.log('🧹 JSON file is older than 1 hour - not restoring or inferring game state');
            }
        } catch (error) {
            console.log('⚠️ Error checking JSON file age, starting fresh');
        }
    }
    return false; // Indicate that no state was restored
};

async function monitorTextbox() {
    // Game tracking variables are now global

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--disable-features=SitePerProcess'] // Just in case localhost has cross-origin features
    });

    const page = await browser.newPage();

    // Attempt to connect to the War Thunder localhost service
    try {
        await page.goto('http://localhost:8111', { waitUntil: 'domcontentloaded' });
        console.log('✅ Page loaded. Watching for updates...');
    } catch (err) {
        console.error('❌ Cannot connect to the service at http://localhost:8111 (net::ERR_CONNECTION_REFUSED).');
        console.error('   Make sure War Thunder is running and the localhost telemetry (http://localhost:8111) is enabled.');
        // Close browser to avoid dangling processes and exit function gracefully
        try { await browser.close(); } catch (_) {}
        return; // Exit without throwing so the app fails gracefully
    }

    // JSON file path (write to a real, writable location; __dirname is read-only in pkg)
    const writeBaseDir = process.env.LOGBOT_DATA_DIR || process.cwd();
    try { fs.mkdirSync(writeBaseDir, { recursive: true }); } catch (_) {}
    const jsonFilePath = path.join(writeBaseDir, 'parsed_data.json');

    // Cooldown notification timer (avoid spamming logs)
    let gameCooldownNotifyTimeout = null;
    // Pending delayed game increment (no longer used for delay, but keep reference null)
    let pendingGameIncrementTimeout = null;

    // Always rename existing file and start fresh (move into old_logs/)
    try {
        if (fs.existsSync(jsonFilePath)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const archiveDir = path.join(writeBaseDir, 'old_logs');
            try { fs.mkdirSync(archiveDir, { recursive: true }); } catch (_) {}
            const backupName = `parsed_data_${timestamp}.json`;
            const backupPath = path.join(archiveDir, backupName);
            fs.renameSync(jsonFilePath, backupPath);
            console.log(`💾 Previous JSON moved to old_logs: ${path.basename(backupPath)}`);
        }
    } catch (error) {
        console.log('⚠️ Could not rotate existing JSON to old_logs, proceeding to reset:', error && error.message ? error.message : error);
        try { fs.unlinkSync(jsonFilePath); } catch (_) {}
    }

    // Create fresh file with reset state
    const initialData = {
        _gameState: {
            currentGame: 0,
            lastGameIncrementTime: 0
        }
    };
    fs.writeFileSync(jsonFilePath, JSON.stringify(initialData, null, 2), 'utf8');
    currentGame = 0;
    lastGameIncrementTime = 0;
    console.log('🔄 JSON file reset - starting fresh session');
    // Web server setup
    const server = http.createServer((req, res) => {
        try {
            const urlObj = new URL(req.url, 'http://localhost:3000');
            const pathname = urlObj.pathname;
            
            if (pathname === '/api/active-vehicles') {
                // API endpoint for active vehicles; optional ?game=ID
                const gameParam = urlObj.searchParams.get('game');
                const activeVehicles = getActiveVehicles(gameParam);
                res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(activeVehicles));
            } else if (pathname === '/api/current-game') {
                // API endpoint for current game number
                res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ currentGame }));
            } else if (pathname === '/api/games-list') {
                // API endpoint for list of available games
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(getGamesList()));
            } else if (pathname === '/api/summaries') {
                // API endpoint: per-game squadron summaries
                const urlObj = new URL(req.url, `http://${req.headers.host}`);
                const gameParam = urlObj.searchParams.get('game');
                let payload = [];
                try {
                    if (gameParam && gameParam !== 'all') {
                        payload = getSquadronSummaries(parseInt(gameParam, 10));
                    } else {
                        payload = getSquadronSummaries();
                    }
                } catch (_) {
                    payload = [];
                }
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(payload));
            } else if (pathname === '/api/highlights') {
                // API endpoint: return highlight configuration
                let payload = { players: {}, squadrons: {} };
                try {
                    const hlPath = path.join(__dirname, 'highlights.json');
                    if (fs.existsSync(hlPath)) {
                        const raw = fs.readFileSync(hlPath, 'utf8');
                        const parsed = JSON.parse(raw);
                        if (parsed && typeof parsed === 'object') payload = parsed;
                    }
                } catch (_) { /* ignore, return defaults */ }
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(payload));
            } else if (pathname === '/api/result') {
                // API endpoint: record a result (win/loss) for a game as a single boolean
                const type = (urlObj.searchParams.get('type') || '').toLowerCase();
                let gameParam = urlObj.searchParams.get('game');
                try {
                    if (!['win', 'loss'].includes(type)) {
                        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        return res.end(JSON.stringify({ error: 'type must be win or loss' }));
                    }
                    if (!gameParam || gameParam === 'current' || gameParam === 'all') {
                        gameParam = String(currentGame);
                    }
                    const gid = String(parseInt(gameParam, 10));
                    const content = fs.existsSync(jsonFilePath) ? fs.readFileSync(jsonFilePath, 'utf8') : '{}';
                    const data = content.trim() ? JSON.parse(content) : {};
                    if (!data._results) data._results = {};
                    // store single boolean: true => win, false => loss, undefined => unset
                    data._results[gid] = (type === 'win');
                    // persist
                    fs.writeFileSync(jsonFilePath, JSON.stringify(data, null, 2), 'utf8');
                    const value = data._results[gid];
                    const note = `🏁 Result set: Game ${gid} -> ${value === true ? 'WIN' : 'LOSS'}`;
                    console.log(note);
                    // Trigger clients to refresh
                    broadcastToWeb(note, 'update');
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ game: parseInt(gid, 10), result: value }));
                } catch (e) {
                    console.error('❌ Error recording result:', e);
                    try {
                        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ error: 'internal_error' }));
                    } catch (_) {}
                }
            } else if (pathname === '/favicon.svg') {
                try {
                    const favPath = path.join(__dirname, 'favicon.svg');
                    if (fs.existsSync(favPath)) {
                        const svg = fs.readFileSync(favPath);
                        res.writeHead(200, {
                            'Content-Type': 'image/svg+xml',
                            'Cache-Control': 'public, max-age=86400',
                            'Access-Control-Allow-Origin': '*'
                        });
                        return res.end(svg);
                    }
                } catch (_) {}
                res.writeHead(404).end();
            } else if (pathname === '/favicon.png' || pathname === '/favicon.ico') {
                // Fallback: redirect to SVG placeholder
                res.writeHead(302, { 'Location': '/favicon.svg' });
                res.end();
            } else if (pathname === '/') {
                // Serve UI from external HTML file
                try {
                    const htmlPath = path.join(__dirname, 'index.html');
                    const html = fs.readFileSync(htmlPath);
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(html);
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Failed to load UI');
                }
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        }
        catch (err) {
            try {
                res.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                res.end('Internal Server Error');
            } catch (_) {
                // ignore
            }
            console.error('HTTP server error:', err);
        }
    });

    // WebSocket server for real-time updates
    const wss = new WebSocket.Server({ port: 3001 });
    
    // Function to broadcast messages to web interface
    const broadcastToWeb = (message, type = 'info') => {
        const data = JSON.stringify({ message, type, timestamp: new Date().toISOString() });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    };

    // Start web server
    server.listen(3000, () => {
        console.log('🌐 Web interface available at http://localhost:3000');
        console.log('📡 WebSocket server running on port 3001');
    });

    // Function to save data to JSON as 4D matrix
    const saveToJSON = (data) => {
        try {
            // Read existing data with better error handling
            let existingData = {};
            try {
                const fileContent = fs.readFileSync(jsonFilePath, 'utf8');
                if (fileContent.trim()) {
                    existingData = JSON.parse(fileContent);
                }
            } catch (parseError) {
                console.log('📝 Creating new JSON file...');
                existingData = {};
            }
            
            // Initialize game dimension if it doesn't exist
            if (!existingData[data.Game]) {
                existingData[data.Game] = {};
            }
            
            // Initialize squadron dimension if it doesn't exist
            if (!existingData[data.Game][data.Squadron]) {
                existingData[data.Game][data.Squadron] = {};
            }
            
            // Initialize player dimension if it doesn't exist
            if (!existingData[data.Game][data.Squadron][data.Player]) {
                existingData[data.Game][data.Squadron][data.Player] = {};
            }
            
            // Ensure vehicle slot exists; set classification at creation time
            if (!existingData[data.Game][data.Squadron][data.Player][data.Vehicle]) {
                existingData[data.Game][data.Squadron][data.Player][data.Vehicle] = {
                    status: data.status || 'active', // 'active' or 'destroyed'
                    firstSeen: new Date().toISOString(),
                    kills: 0,
                    classification: classifyVehicleLenient(data.Vehicle, vehicleToCategory, { minScore: 4 })
                };
            }

            const vehicleRef = existingData[data.Game][data.Squadron][data.Player][data.Vehicle];

            // Backfill classification for legacy entries missing it
            if (!vehicleRef.classification) {
                vehicleRef.classification = classifyVehicleLenient(data.Vehicle, vehicleToCategory, { minScore: 4 });
            }

            // Update status to destroyed if requested
            if (data.status === 'destroyed' && vehicleRef.status !== 'destroyed') {
                vehicleRef.status = 'destroyed';
                vehicleRef.destroyedAt = new Date().toISOString();
                const message = `💥 Vehicle destroyed - Game: ${data.Game}, Squadron: ${data.Squadron}, Player: ${data.Player}, Vehicle: ${data.Vehicle}`;
                console.log(message);
                broadcastToWeb(message, 'destroyed');
            }

            // Increment kills if provided
            if (typeof data.killsDelta === 'number' && data.killsDelta !== 0) {
                vehicleRef.kills = (vehicleRef.kills || 0) + data.killsDelta;
                const message = `⚔️ Kill recorded (+${data.killsDelta}) - Game: ${data.Game}, Squadron: ${data.Squadron}, Player: ${data.Player}, Vehicle: ${data.Vehicle}, Total kills: ${vehicleRef.kills}`;
                console.log(message);
                broadcastToWeb(message, 'update');
            }
            
            // Update game state in JSON
            existingData._gameState = {
                currentGame: currentGame,
                lastGameIncrementTime: lastGameIncrementTime
            };
            
            // Write back to file
            fs.writeFileSync(jsonFilePath, JSON.stringify(existingData, null, 2), 'utf8');
            if (data.status && data.status !== 'destroyed' && typeof data.killsDelta !== 'number') {
                const message = `💾 New unique entry saved - Game: ${data.Game}, Squadron: ${data.Squadron}, Player: ${data.Player}, Vehicle: ${data.Vehicle}`;
                console.log(message);
                broadcastToWeb(message, 'info');
            }
        } catch (error) {
            console.error('❌ Error saving to JSON:', error);
        }
    };

    // Function to handle game increment (no delay; no cooldown)
    const handleGameIncrement = () => {
        try {
            currentGame++;
            lastGameIncrementTime = Date.now();
            // Persist game state to JSON immediately
            let existingData = {};
            try {
                const fileContent = fs.readFileSync(jsonFilePath, 'utf8');
                if (fileContent.trim()) {
                    existingData = JSON.parse(fileContent);
                }
            } catch (_) {
                existingData = {};
            }
            existingData._gameState = {
                currentGame: currentGame,
                lastGameIncrementTime: lastGameIncrementTime
            };
            fs.writeFileSync(jsonFilePath, JSON.stringify(existingData, null, 2), 'utf8');
            const message = `🎮 Game incremented to ${currentGame} - time reset detected`;
            console.log(message);
            broadcastToWeb(message, 'game');
            return true;
        } catch (err) {
            console.error('❌ Error during game increment:', err);
            return false;
        }
    };

    // Function to get current game number
    const getCurrentGame = () => currentGame;

    // Function to list available games from JSON
    const getGamesList = () => {
        try {
            const content = fs.readFileSync(jsonFilePath, 'utf8');
            const data = JSON.parse(content);
            const games = Object.keys(data)
                .filter(k => k !== '_gameState' && /^\d+$/.test(k))
                .map(k => parseInt(k, 10))
                .sort((a,b) => a - b);
            return games;
        } catch (_) {
            return [];
        }
    };



    // Function to get all vehicles for web interface (current game only)
    const getActiveVehicles = (targetGameId = null) => {
        try {
            const content = fs.readFileSync(jsonFilePath, 'utf8');
            const data = JSON.parse(content);
            const allVehicles = [];
            const gameIdNum = (targetGameId === null || targetGameId === undefined) ? currentGame : parseInt(targetGameId, 10);
            const currentGameId = String(gameIdNum);
            
            // Only check the current game
            if (data[currentGameId]) {
                Object.keys(data[currentGameId]).forEach(squadron => {
                    Object.keys(data[currentGameId][squadron]).forEach(player => {
                        Object.keys(data[currentGameId][squadron][player]).forEach(vehicle => {
                            const vehicleData = data[currentGameId][squadron][player][vehicle];
                            allVehicles.push({
                                game: currentGameId,
                                squadron,
                                player,
                                vehicle,
                                status: vehicleData.status,
                                classification: (vehicleData.classification
                                || classifyVehicleLenient(vehicle, vehicleToCategory, { minScore: 4 })),
                                firstSeen: vehicleData.firstSeen,
                                destroyedAt: vehicleData.destroyedAt || null,
                                kills: vehicleData.kills || 0
                            });
                        });
                    });
                });
            }
            
            return allVehicles;
        } catch (error) {
            return [];
        }
    };

    // Function to summarize each squadron per game
    // If targetGameId is provided, only that game is summarized
    const getSquadronSummaries = (targetGameId = null) => {
        try {
            const content = fs.readFileSync(jsonFilePath, 'utf8');
            const data = JSON.parse(content);

            const gameIds = (targetGameId === null || targetGameId === undefined)
                ? Object.keys(data).filter(k => k !== '_gameState' && /^\d+$/.test(k)).sort((a,b) => parseInt(a,10) - parseInt(b,10))
                : [String(parseInt(targetGameId, 10))];

            const results = [];

            gameIds.forEach(gameId => {
                const gameBlock = data[gameId];
                if (!gameBlock) return;

                // Per-game accumulator: squadron -> counts
                const squadronTotals = new Map();

                Object.keys(gameBlock).forEach(squadron => {
                    if (!squadronTotals.has(squadron)) {
                        const init = {};
                        OUTPUT_ORDER.forEach(label => { init[label] = 0; });
                        squadronTotals.set(squadron, init);
                    }
                    const acc = squadronTotals.get(squadron);
                    Object.keys(gameBlock[squadron]).forEach(player => {
                        Object.keys(gameBlock[squadron][player]).forEach(vehicle => {
                            const vehicleData = gameBlock[squadron][player][vehicle] || {};
                            const cat = vehicleData.classification
                                || classifyVehicleLenient(vehicle, vehicleToCategory, { minScore: 4 });
                            const label = CATEGORY_TO_OUTPUT[cat];
                            if (label && Object.prototype.hasOwnProperty.call(acc, label)) {
                                acc[label] += 1;
                            }
                        });
                    });
                });

                // Format output strings for this game
                squadronTotals.forEach((counts, squadron) => {
                    // Strip ALL non-alphanumeric characters from squadron name for display
                    const cleaned = String(squadron).replace(/[^A-Za-z0-9]/g, '');
                    // Ensure first '|' at column 7 by fixing name to 6 characters (pad or truncate)
                    const fixedName = cleaned.padEnd(6, ' ').slice(0, 6);
                        const parts = OUTPUT_ORDER.map(label => `${counts[label]} ${label}`);
                    // Determine current game's indicator (W/L) and cumulative win/loss up to this gameId
                    let indicator = '';
                    let cum = { win: 0, loss: 0 };
                    if (data._results && typeof data._results === 'object') {
                        Object.keys(data._results)
                          .filter(function(k){ return /^\d+$/.test(k) && parseInt(k, 10) <= parseInt(gameId, 10); })
                          .forEach(function(k){
                              const v = data._results[k];
                              if (typeof v === 'boolean') {
                                  if (v === true) cum.win++; else cum.loss++;
                                  if (k === String(gameId)) indicator = v === true ? 'W' : 'L';
                              } else if (v && typeof v === 'object') {
                                  // Backward-compatibility: legacy { win, loss } per game; treat as 1 outcome if one side > 0
                                  const w = (v.win|0), l = (v.loss|0);
                                  if (w > 0 && l === 0) cum.win++;
                                  else if (l > 0 && w === 0) cum.loss++;
                                  if (k === String(gameId)) {
                                      if (w > 0 && l === 0) indicator = 'W';
                                      else if (l > 0 && w === 0) indicator = 'L';
                                  }
                                  // if both zero or both >0, treat as unknown -> ignore
                              }
                          });
                    }
                    const line = `${fixedName} | ${parts.join(' | ')} | ${indicator ? (indicator + ' | ') : ''}${cum.win}/${cum.loss} |`;
                    results.push({ game: parseInt(gameId, 10), squadron: cleaned, line, counts });
                });
            });

            // Sort by game then squadron
            results.sort((a, b) => (a.game - b.game) || a.squadron.localeCompare(b.squadron));
            return results;
        } catch (error) {
            console.error('❌ Error creating squadron summaries:', error);
            return [];
        }
    };

    // Function to get summary string for a specific squadron in a given game
    const getSquadronSummaryFor = (squadronName, targetGameId) => {
        if (targetGameId === undefined || targetGameId === null) return '';
        const all = getSquadronSummaries(targetGameId);
        const item = all.find(x => x.squadron === squadronName && x.game === parseInt(targetGameId, 10));
        return item ? item.line : '';
    };

    // Expose Node functions to receive updates from the browser context
    await page.exposeFunction('printToCLI', (text) => {
        console.log(text);
        // Determine message type for web interface
        let type = 'info';
        if (text.includes('🎯 Match found')) type = 'match';
        else if (text.includes('🎮 Game incremented')) type = 'game';
        else if (text.includes('❌')) type = 'error';
        
        broadcastToWeb(text, type);
    });
    
    await page.exposeFunction('saveDataToJSON', saveToJSON);
    await page.exposeFunction('handleGameIncrement', handleGameIncrement);
    await page.exposeFunction('getCurrentGame', getCurrentGame);
    await page.exposeFunction('getActiveVehicles', getActiveVehicles);
    await page.exposeFunction('getSquadronSummaries', getSquadronSummaries);
    await page.exposeFunction('getSquadronSummaryFor', getSquadronSummaryFor);
    // Allow page to signal UI updates without logging to console
    await page.exposeFunction('signalUpdate', (text = 'update') => {
        broadcastToWeb(text, 'update');
    });
    // Allow page to broadcast events without CLI logging
    await page.exposeFunction('broadcastEvent', (text, type = 'info') => {
        broadcastToWeb(text, type);
    });

    await page.evaluate(() => {
    const target = document.querySelector('#hud-dmg-msg-root > div:nth-child(2)');
    if (!target) {
        console.error('❌ Target element not found');
        return;
    }

    let lastText = '';
    // Deduplicate rapid duplicate HUD events (e.g., re-renders). Keep short-term memory of recent events
    const recentEvents = new Map();
    const DEDUPE_MS = 100; // suppress identical events seen within 0.1 seconds
    // Track HUD timestamps to auto-increment game when time decreases (new match)
    let lastHudTsSec = null; // number of seconds of last seen HUD timestamp
    let lastHudTsStr = null; // string form of last seen HUD timestamp
    let lastResetAnchor = null; // the ts string that triggered the last increment
    function tsToSeconds(tsStr) {
        const parts = tsStr.split(':').map(function(p){ return parseInt(p, 10); });
        if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
        if (parts.length === 2) return parts[0]*60 + parts[1];
        return 0;
    }

    const observer = new MutationObserver(() => {
        const newText = target.innerText.trim(); // PRESERVE visual line breaks
        if (newText && newText !== lastText) {
            // Find only the newly added lines
            const oldLines = lastText.split('\n');
            const newLines = newText.split('\n');
            
            // Get only the lines that were added (difference between old and new)
            const addedLines = newLines.slice(oldLines.length);
            
            lastText = newText;
            
            // Process only the newly added lines
            addedLines.forEach(line => {
                if (!line.trim()) return; // Skip empty lines
                
                // Auto-increment game when HUD timestamp decreases (new match detected)
                const mTs = line.match(/^\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
                if (mTs) {
                    const tsStr = mTs[1];
                    const sec = tsToSeconds(tsStr);
                    if (lastHudTsSec !== null && sec < lastHudTsSec) {
                        const delta = lastHudTsSec - sec; // seconds decreased by
                        // Only consider as new game if drop is >= 60 seconds
                        if (delta >= 60) {
                            // Deduplicate increments for the same reset anchor timestamp
                            if (lastResetAnchor !== tsStr) {
                                const prevTs = lastHudTsStr || String(lastHudTsSec);
                                window.printToCLI(` HUD time dropped by ${delta}s (${prevTs} → ${tsStr}). Advancing game counter.`);
                                window.handleGameIncrement();
                                lastResetAnchor = tsStr;
                            }
                        }
                    }
                    lastHudTsSec = sec;
                    lastHudTsStr = tsStr;
                }
                // Parse the line for the specific pattern
                let parseResults = [];
                try {
                    parseResults = parseNewLine(line);
                } catch (e) {
                    console.error('❌ parseNewLine error:', e, 'Line:', line);
                }
                if (Array.isArray(parseResults) && parseResults.length > 0) {
                    // Get current game number and process the match
                    window.getCurrentGame().then(currentGameNumber => {
                        try {
                            const results = parseResults;
                            const lineText = (results[0] && results[0].originalLine) || line;
                            for (const pr of results) {
                                const vehicleText = `(${pr.vehicle})`;
                                const vehicleIdx = lineText.indexOf(vehicleText);
                                const destroyedIdx = vehicleIdx === -1 ? -1 : lineText.lastIndexOf(' destroyed ', vehicleIdx);
                                const crashedIdx = vehicleIdx === -1 ? -1 : lineText.indexOf(' has crashed', vehicleIdx + vehicleText.length);
                                const wreckedIdx = vehicleIdx === -1 ? -1 : lineText.indexOf(' has been wrecked', vehicleIdx + vehicleText.length);
                                const shotIdx = vehicleIdx === -1 ? -1 : lineText.lastIndexOf(' shot down ', vehicleIdx);

                                // Always write as active first
                                window.saveDataToJSON({
                                    Game: currentGameNumber,
                                    Squadron: pr.squadron,
                                    Player: pr.player,
                                    Vehicle: pr.vehicle,
                                    status: 'active'
                                });

                                const isDestroyed = (destroyedIdx !== -1) || (crashedIdx !== -1) || (wreckedIdx !== -1) || (shotIdx !== -1);
                                if (isDestroyed) {
                                    window.saveDataToJSON({
                                        Game: currentGameNumber,
                                        Squadron: pr.squadron,
                                        Player: pr.player,
                                        Vehicle: pr.vehicle,
                                        status: 'destroyed'
                                    });
                                }

                                const finalStatus = isDestroyed ? 'destroyed' : 'active';
                                const key = `${currentGameNumber}|${pr.squadron}|${pr.player}|${pr.vehicle}|${finalStatus}`;
                                const now = Date.now();
                                const prev = recentEvents.get(key);
                                if (!prev || (now - prev) >= DEDUPE_MS) {
                                    recentEvents.set(key, now);
                                }
                                for (const [k, ts] of Array.from(recentEvents.entries())) {
                                    if ((now - ts) > DEDUPE_MS) recentEvents.delete(k);
                                }
                            }
                            window.printToCLI(` Processed line with ${results.length} entity(ies).`);
                        } catch (e) {
                            console.error('❌ Line handling error:', e, 'Line:', line);
                        }
                    }).catch(e => console.error('❌ getCurrentGame failed:', e));
                }
            });
        }
    });

    function parseNewLine(line) {
        // Rules:
        // - Data may come BEFORE 'destroyed' | 'has achieved' | 'has crashed' | 'shot down'
        // - Or come AFTER 'destroyed' | 'shot down' (e.g., "destroyed by ...")
        // - Format: [SQ] Player (Vehicle)  OR  SQ Player (Vehicle)  OR  Player (Vehicle)
        //   where SQ is <=5 alphanumeric chars after stripping non-alphanumerics. Player has no spaces.

        const lower = String(line).toLowerCase();   
        const kwList = ['destroyed', 'has achieved', 'has crashed', 'shot down', `has been wrecked`, `set afire`];
        let earliest = { idx: -1, kw: '' };
        for (const kw of kwList) {
            const i = lower.indexOf(kw);
            if (i !== -1 && (earliest.idx === -1 || i < earliest.idx)) {
                earliest = { idx: i, kw };
            }
        }

        const original = String(line).trim();
        const segments = [];
        if (earliest.idx !== -1) {
            // For 'destroyed' or 'shot down',parse the segment to the right AND the left of the keyword
            if (earliest.kw === 'destroyed' || earliest.kw === 'shot down' || earliest.kw === 'set afire') {
                const keyLen = earliest.kw.length; // robust to exact keyword used
                let after = original.slice(earliest.idx + keyLen).trim();
                after = after.replace(/^(:|-|–|—|by)\s+/i, '');
                if (after) segments.push(after);
            }
            // For all keywords, parse the segment before the keyword (vehicle appears before the phrase)
            const before = original.slice(0, earliest.idx).trim();
            if (before) segments.push(before);
        } else {
            // No keywords — fallback to whole line
            segments.push(original);
        }

        // Helper to try parsing a segment with multiple patterns
        const VEH = '([^()]*?(?:\\([^()]*\\)[^()]*)*)'; // balanced parentheses approximation
        // Allow optional dash/colon between squad and player, enforce player single token, and strip timestamps before matching
        const reBracketed = new RegExp(
            '^\\s*\\[(?<sq>[^\\[\\]]{1,5})\\]\\s*[-–—:]?\\s+(?<player>[^()]+?)\\s+\\((?<vehicle>' + VEH + ')\\)'
        );
        const reUnbrSquad = new RegExp(
            // Capture a raw first token as potential squad tag, then a player name that may contain spaces
            '^\\s*(?<sqraw>\\S{1,12})\\s*[-–—:]?\\s+(?<player>[^()]+?)\\s+\\((?<vehicle>' + VEH + ')\\)'
        );
        const reNoSquad = new RegExp(
            // Player name may contain spaces; capture up to the vehicle parenthesis
            '^\\s*(?<player>[^()]+?)\\s+\\((?<vehicle>' + VEH + ')\\)'
        );

        const tryParse = (seg) => {
            // Remove leading timestamp like 2:29 or 12:05:31 and optional separator
            const norm = String(seg).replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*[-–—: ]?\s*/, '');
            let m = norm.match(reBracketed);
            if (m) {
                // Clean bracketed squad; if empty after cleaning, treat as no-squad
                const sqClean = (m.groups.sq || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 5);
                if (sqClean.length >= 1) {
                    return {
                        squadron: sqClean,
                        player: m.groups.player.trim(),
                        vehicle: m.groups.vehicle.trim(),
                        originalLine: original
                    };
                }
                // Fall back to parsing without squad
                const mNoB = norm.match(reNoSquad);
                if (mNoB) {
                    return {
                        squadron: 'none',
                        player: mNoB.groups.player.trim(),
                        vehicle: mNoB.groups.vehicle.trim(),
                        originalLine: original
                    };
                }
            }
            m = norm.match(reUnbrSquad);
            if (m) {
                // Clean the raw squad token by stripping non-alphanumerics
                const cleanedSq = (m.groups.sqraw || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 5);
                if (cleanedSq.length >= 1) {
                    return {
                        squadron: cleanedSq,
                        player: m.groups.player.trim(),
                        vehicle: m.groups.vehicle.trim(),
                        originalLine: original
                    };
                }
                // If cleaning produced empty squad, fall back to no-squad pattern on same segment
                const mNo = norm.match(reNoSquad);
                if (mNo) {
                    return {
                        squadron: 'none',
                        player: mNo.groups.player.trim(),
                        vehicle: mNo.groups.vehicle.trim(),
                        originalLine: original
                    };
                }
            }
            m = norm.match(reNoSquad);
            if (m) {
                return {
                    squadron: 'none',
                    player: m.groups.player.trim(),
                    vehicle: m.groups.vehicle.trim(),
                    originalLine: original
                };
            }
            // Fallback: search pattern anywhere in the segment (non-anchored)
            const anyBracketed = new RegExp("\\[(?<sq>[^\\[\\]]{1,5})\\]\\s*[-–—:]?\\s+(?<player>[^()]+?)\\s+\\((?<vehicle>" + VEH + ")\\)");
            m = norm.match(anyBracketed);
            if (m && m.groups) {
                const sqClean2 = (m.groups.sq || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 5);
                return {
                    squadron: sqClean2 || 'none',
                    player: (m.groups.player || '').trim(),
                    vehicle: (m.groups.vehicle || '').trim(),
                    originalLine: original
                };
            }
            const anyNoSquad = new RegExp("(?<!\\S)(?<player>[^()]+?)\\s+\\((?<vehicle>" + VEH + ")\\)");
            m = norm.match(anyNoSquad);
            if (m && m.groups) {
                return {
                    squadron: 'none',
                    player: (m.groups.player || '').trim(),
                    vehicle: (m.groups.vehicle || '').trim(),
                    originalLine: original
                };
            }
            return null;
        };

        const out = [];
        for (const seg of segments) {
            const parsed = tryParse(seg);
            if (parsed) out.push(parsed);
        }
        return out;
    }

    observer.observe(target, { childList: true, subtree: true });
});
}

// Initialize and start monitoring
console.log('🚀 Starting War Thunder Log Monitor...');

// Load vehicle classifications
loadVehicleClassifications();

// Load existing game state if file is recent (less than 1 hour old)
loadGameState();

monitorTextbox().catch(console.error);
