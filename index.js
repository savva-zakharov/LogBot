const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const WebSocket = require('ws');
const http = require('http');

// Load vehicle classifications
let vehicleClassifications = {};
const loadVehicleClassifications = () => {
    try {
        // Try to load comprehensive database first
        const comprehensivePath = path.join(__dirname, 'comprehensive_vehicle_classifications.json');
        if (fs.existsSync(comprehensivePath)) {
            const content = fs.readFileSync(comprehensivePath, 'utf8');
            vehicleClassifications = JSON.parse(content);
            console.log(`✅ Comprehensive vehicle classifications loaded (${Object.keys(vehicleClassifications).length} categories)`);
            
            // Log vehicle counts per category
            Object.entries(vehicleClassifications).forEach(([category, vehicles]) => {
                console.log(`   - ${category}: ${vehicles.length} vehicles`);
            });
        } else {
            vehicleClassifications = {};
            console.log('⚠️  comprehensive_vehicle_classifications.json not found. Proceeding with empty classifications');
        }
    } catch (error) {
        console.error('❌ Error loading vehicle classifications:', error);
        vehicleClassifications = {};
    }
};

// Function to classify a vehicle with intelligent matching
const classifyVehicle = (vehicleName) => {
    if (!vehicleName || typeof vehicleName !== 'string') {
        return 'other';
    }
    
    const cleanVehicleName = vehicleName.trim();
    
    for (const [category, vehicles] of Object.entries(vehicleClassifications)) {
        // Check for exact match first (highest priority)
        if (vehicles.includes(cleanVehicleName)) {
            return category;
        }
        
        // Check for exact match ignoring case
        const exactMatch = vehicles.find(v => v.toLowerCase() === cleanVehicleName.toLowerCase());
        if (exactMatch) {
            return category;
        }
        
        // Check for partial matches with intelligent scoring
        for (const classifiedVehicle of vehicles) {
            const classifiedLower = classifiedVehicle.toLowerCase();
            const vehicleLower = cleanVehicleName.toLowerCase();
            
            // High confidence matches
            if (vehicleLower === classifiedLower) {
                return category;
            }
            
            // Check if the classified vehicle name is contained in the detected name
            if (vehicleLower.includes(classifiedLower)) {
                return category;
            }
            
            // Check if the detected name is contained in the classified name
            if (classifiedLower.includes(vehicleLower)) {
                return category;
            }
            
            // Check for common abbreviations and variations
            const commonVariations = [
                [classifiedLower.replace(/\s+/g, ''), vehicleLower.replace(/\s+/g, '')], // Remove spaces
                [classifiedLower.replace(/[()]/g, ''), vehicleLower.replace(/[()]/g, '')], // Remove parentheses
                [classifiedLower.replace(/mk\.?/gi, 'mark'), vehicleLower.replace(/mk\.?/gi, 'mark')], // Mk variations
                [classifiedLower.replace(/\-/g, ''), vehicleLower.replace(/\-/g, '')] // Remove hyphens
            ];
            
            for (const [var1, var2] of commonVariations) {
                if (var1 === var2 || var1.includes(var2) || var2.includes(var1)) {
                    return category;
                }
            }
        }
    }
    
    return 'other'; // Default category for unclassified vehicles
};

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

async function monitorTextbox(targetUrl) {
    // Game tracking variables are now global

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--disable-features=SitePerProcess'] // Just in case localhost has cross-origin features
    });

    const page = await browser.newPage();

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    console.log('✅ Page loaded. Watching for updates...');

    // JSON file path
    const jsonFilePath = path.join(__dirname, 'parsed_data.json');
    
    // Handle existing JSON file
    let shouldResetFile = true;
    
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
                        
                        // Broadcast restored game state to web interface (delayed to ensure WebSocket server is ready)
                        setTimeout(() => {
                            broadcastToWeb(`🎮 Game state restored - Current game: ${currentGame}`, 'game');
                        }, 1000);
                    }
                } catch (error) {
                    console.log('⚠️ Could not load game state from JSON, starting from 0');
                }
                
                shouldResetFile = false; // Don't reset if file is newer than 1 hour
            } else {
                // File is older than 1 hour, backup before resetting
                const content = fs.readFileSync(jsonFilePath, 'utf8');
                const data = JSON.parse(content);
                
                // Check if the JSON contains any actual data
                const hasData = Object.keys(data).length > 0 && 
                               Object.values(data).some(game => 
                                   Object.keys(game).length > 0
                               );
                
                if (hasData) {
                    // File contains data and is older than 1 hour, create backup
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const backupPath = jsonFilePath.replace('.json', `_${timestamp}.json`);
                    fs.copyFileSync(jsonFilePath, backupPath);
                    console.log(`💾 Previous JSON (${Math.round(fileAge / (60 * 1000))} minutes old) backed up as: ${path.basename(backupPath)}`);
                } else {
                    // File is empty and older than 1 hour, just delete it
                    fs.unlinkSync(jsonFilePath);
                    console.log('🗑️ Previous JSON was empty and old - deleted instead of backing up');
                }
            }
        } catch (error) {
            // If file is corrupted or can't be parsed, create backup anyway
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = jsonFilePath.replace('.json', `_backup_corrupted_${timestamp}.json`);
            fs.copyFileSync(jsonFilePath, backupPath);
            console.log(`⚠️ Previous JSON was corrupted - backed up as: ${path.basename(backupPath)}`);
        }
    }
    
    // Reset JSON file only if needed
    if (shouldResetFile) {
        const initialData = {
            _gameState: {
                currentGame: 0,
                lastGameIncrementTime: 0
            }
        };
        fs.writeFileSync(jsonFilePath, JSON.stringify(initialData, null, 2), 'utf8');
        console.log('🔄 JSON file reset - starting fresh session');
    }
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
            } else if (pathname === '/') {
                // Serve NEW UI (fresh minimal table with hierarchical filters)
                const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>War Thunder Parsed Data</title>
  <style>
    body { font-family: Arial, sans-serif; background: #121212; color: #e0e0e0; margin: 0; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1 { color: #4CAF50; margin: 0 0 12px 0; }
    .filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    select { background: #1e1e1e; color: #ddd; border: 1px solid #444; padding: 6px 8px; border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; }
    thead th { background: #1e1e1e; color: #aaa; padding: 8px; border-bottom: 1px solid #333; text-align: left; }
    tbody td { padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
    .status-active { color: #66BB6A; }
    .status-destroyed { color: #EF5350; }
  </style>
  <script>
    let rows = [];
    const ws = new window.WebSocket(\`ws://\${window.location.hostname}:3001\`);

    async function fetchGames() {
      const [gamesResp, currentResp] = await Promise.all([
        fetch('/api/games-list'),
        fetch('/api/current-game')
      ]);
      const games = await gamesResp.json();
      const current = (await currentResp.json()).currentGame;
      return { games, current };
    }

    async function fetchRowsForSelectedGame() {
      const gameSel = document.getElementById('filterGame');
      const game = gameSel.value;
      if (game === 'all') {
        // Fetch all games and aggregate
        const gamesResp = await fetch('/api/games-list');
        const games = await gamesResp.json();
        const promises = games.map(function(g){
          return fetch('/api/active-vehicles?game=' + encodeURIComponent(g))
            .then(function(r){ return r.json(); })
            .then(function(list){
              return list.map(function(item){
                if (item && (item.game === undefined || item.game === null)) {
                  item.game = g; // ensure game column present
                }
                return item;
              });
            });
        });
        const results = await Promise.all(promises);
        rows = [].concat.apply([], results);
      } else {
        const resp = await fetch('/api/active-vehicles?game=' + encodeURIComponent(game));
        rows = await resp.json();
      }
    }

    function populateFilter(selectId, values, placeholder) {
      const sel = document.getElementById(selectId);
      const prev = sel.value;
      sel.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = placeholder;
      sel.appendChild(allOpt);
      values.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
      });
      if (values.includes(prev)) sel.value = prev; else sel.value = 'all';
    }

    function applyFiltersAndRender() {
      const game = document.getElementById('filterGame').value;
      const squadron = document.getElementById('filterSquadron').value;
      const player = document.getElementById('filterPlayer').value;
      const vehicle = document.getElementById('filterVehicle').value;
      const status = document.getElementById('filterStatus').value;
      const type = document.getElementById('filterType').value;

      const filtered = rows.filter(r => (
        (squadron === 'all' || r.squadron === squadron) &&
        (player === 'all' || r.player === player) &&
        (vehicle === 'all' || r.vehicle === vehicle) &&
        (status === 'all' || r.status === status) &&
        (type === 'all' || r.classification === type)
      ));

      // Update dependent filters from filtered dataset
      const squadrons = Array.from(new Set(rows.map(r => r.squadron))).sort();
      const players = Array.from(new Set(rows.map(r => r.player))).sort();
      const vehicles = Array.from(new Set(rows.map(r => r.vehicle))).sort();
      populateFilter('filterSquadron', squadrons, 'All Squadrons');
      populateFilter('filterPlayer', players, 'All Players');
      populateFilter('filterVehicle', vehicles, 'All Vehicles');

      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = filtered.map(function(r) {
        var statusClass = (r.status === 'destroyed') ? 'status-destroyed' : 'status-active';
        return '<tr>' +
          '<td>' + r.game + '</td>' +
          '<td>' + r.squadron + '</td>' +
          '<td>' + r.player + '</td>' +
          '<td>' + r.vehicle + '</td>' +
          '<td>' + (r.classification || 'other') + '</td>' +
          '<td class="' + statusClass + '">' + r.status + '</td>' +
        '</tr>';
      }).join('');
    }

    async function init() {
      const { games, current } = await fetchGames();
      const gameSel = document.getElementById('filterGame');
      const saved = localStorage.getItem('selectedGame');
      const initial = (saved === 'all') ? 'all' : (saved && games.includes(parseInt(saved, 10)) ? saved : String(current));
      gameSel.innerHTML = '<option value="all">All Games</option>' + games.map(function(g){ return '<option value="' + g + '">Game ' + g + '</option>'; }).join('');
      gameSel.value = initial;
      localStorage.setItem('selectedGame', gameSel.value);

      await fetchRowsForSelectedGame();

      // Initialize status and type filters
      document.getElementById('filterStatus').value = 'all';
      document.getElementById('filterType').value = 'all';

      applyFiltersAndRender();

      // Wire events
      ['filterGame', 'filterSquadron', 'filterPlayer', 'filterVehicle', 'filterStatus', 'filterType'].forEach(id => {
        document.getElementById(id).addEventListener('change', async (e) => {
          if (id === 'filterGame') {
            localStorage.setItem('selectedGame', e.target.value);
            await fetchRowsForSelectedGame();
          }
          applyFiltersAndRender();
        });
      });
    }

    ws.onmessage = async (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'game') {
          // refresh games list and keep selected
          const { games } = await fetchGames();
          const gameSel = document.getElementById('filterGame');
          const prev = gameSel.value;
          gameSel.innerHTML = '<option value="all">All Games</option>' + games.map(function(g){ return '<option value="' + g + '">Game ' + g + '</option>'; }).join('');
          if (prev === 'all') { gameSel.value = 'all'; }
          else if (games.map(String).includes(prev)) gameSel.value = prev; else gameSel.value = String(games[games.length-1]);
          localStorage.setItem('selectedGame', gameSel.value);
          await fetchRowsForSelectedGame();
          applyFiltersAndRender();
        } else if (data.type === 'match' || data.type === 'destroyed' || data.type === 'update') {
          // If current selected game is active, refresh rows
          await fetchRowsForSelectedGame();
          applyFiltersAndRender();
        }
      } catch (_) { }
    };

    window.addEventListener('load', init);
  </script>
</head>
<body>
  <div class="container">
    <h1>War Thunder Parsed Data</h1>
    <div class="filters">
      <select id="filterGame"></select>
      <select id="filterSquadron"><option value="all">All Squadrons</option></select>
      <select id="filterPlayer"><option value="all">All Players</option></select>
      <select id="filterVehicle"><option value="all">All Vehicles</option></select>
      <select id="filterStatus">
        <option value="all">All Status</option>
        <option value="active">Active</option>
        <option value="destroyed">Destroyed</option>
      </select>
      <select id="filterType">
        <option value="all">All Types</option>
        <option value="light tank">Light Tank</option>
        <option value="medium tank">Medium Tank</option>
        <option value="heavy tank">Heavy Tank</option>
        <option value="spg">SPG</option>
        <option value="spaa">SPAA</option>
        <option value="fighter">Fighter</option>
        <option value="attacker">Attacker</option>
        <option value="bomber">Bomber</option>
        <option value="helicopter">Helicopter</option>
        <option value="other">Other</option>
      </select>
    </div>
    <table>
      <thead>
        <tr>
          <th>Game</th>
          <th>Squadron</th>
          <th>Player</th>
          <th>Vehicle</th>
          <th>Type</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>
</body>
</html>`;
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html);
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
            
            // Check if vehicle already exists, or update status if it does
            if (existingData[data.Game][data.Squadron][data.Player][data.Vehicle]) {
                // Vehicle exists, update status if it's being destroyed
                if (data.status === 'destroyed') {
                    existingData[data.Game][data.Squadron][data.Player][data.Vehicle].status = 'destroyed';
                    existingData[data.Game][data.Squadron][data.Player][data.Vehicle].destroyedAt = new Date().toISOString();
                    fs.writeFileSync(jsonFilePath, JSON.stringify(existingData, null, 2), 'utf8');
                    const message = `💥 Vehicle destroyed - Game: ${data.Game}, Squadron: ${data.Squadron}, Player: ${data.Player}, Vehicle: ${data.Vehicle}`;
                    console.log(message);
                    broadcastToWeb(message, 'destroyed');
                }
                return;
            }
            
            // Add vehicle with status tracking
            existingData[data.Game][data.Squadron][data.Player][data.Vehicle] = {
                status: data.status || 'active', // 'active' or 'destroyed'
                firstSeen: new Date().toISOString()
            };
            
            // Update game state in JSON
            existingData._gameState = {
                currentGame: currentGame,
                lastGameIncrementTime: lastGameIncrementTime
            };
            
            // Write back to file
            fs.writeFileSync(jsonFilePath, JSON.stringify(existingData, null, 2), 'utf8');
            const message = `💾 New unique entry saved - Game: ${data.Game}, Squadron: ${data.Squadron}, Player: ${data.Player}, Vehicle: ${data.Vehicle}`;
            console.log(message);
            broadcastToWeb(message, 'info');
        } catch (error) {
            console.error('❌ Error saving to JSON:', error);
        }
    };

    // Function to handle game increment
    const handleGameIncrement = () => {
        const now = Date.now();
        const timeSinceLastIncrement = now - lastGameIncrementTime;
        
        // Check if 10 seconds (10000ms) have passed since last increment
        if (timeSinceLastIncrement >= 10000) {
            currentGame++;
            lastGameIncrementTime = now;
            
            // Persist game state to JSON immediately
            try {
                let existingData = {};
                try {
                    const fileContent = fs.readFileSync(jsonFilePath, 'utf8');
                    if (fileContent.trim()) {
                        existingData = JSON.parse(fileContent);
                    }
                } catch (parseError) {
                    existingData = {};
                }
                
                existingData._gameState = {
                    currentGame: currentGame,
                    lastGameIncrementTime: lastGameIncrementTime
                };
                
                fs.writeFileSync(jsonFilePath, JSON.stringify(existingData, null, 2), 'utf8');
            } catch (error) {
                console.error('❌ Error persisting game state:', error);
            }
            
            const message = `🎮 Game incremented to ${currentGame} - "The Best Squad" achieved!`;
            console.log(message);
            broadcastToWeb(message, 'game');
            return true;
        } else {
            const remainingCooldown = Math.ceil((10000 - timeSinceLastIncrement) / 1000);
            const message = `⏰ Game increment on cooldown - ${remainingCooldown}s remaining`;
            console.log(message);
            broadcastToWeb(message, 'info');
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
                                classification: classifyVehicle(vehicle),
                                firstSeen: vehicleData.firstSeen,
                                destroyedAt: vehicleData.destroyedAt || null
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
                
                // Check for "The Best Squad" achievement to increment game
                if (line.includes('has achieved "The Best Squad"')) {
                    window.handleGameIncrement();
                }
                
                // Parse the line for the specific pattern
                const parseResult = parseNewLine(line);
                if (parseResult) {
                    // Get current game number and process the match
                    window.getCurrentGame().then(currentGameNumber => {
                        // Check if this is a destruction event
                        const isDestroyed = line.includes(' destroyed ');
                        const status = isDestroyed ? 'destroyed' : 'active';
                        // Dedupe identical events in a short window
                        const key = `${currentGameNumber}|${parseResult.squadron}|${parseResult.player}|${parseResult.vehicle}|${status}`;
                        const now = Date.now();
                        const prev = recentEvents.get(key);
                        const suppressLog = !!(prev && (now - prev) < DEDUPE_MS);
                        if (!suppressLog) {
                            recentEvents.set(key, now);
                        }
                        // Cleanup old entries
                        for (const [k, ts] of Array.from(recentEvents.entries())) {
                            if ((now - ts) > DEDUPE_MS) recentEvents.delete(k);
                        }
                        
                        const logMessage = isDestroyed ? 
                            `💥 Vehicle destroyed - Game: ${currentGameNumber}, Squadron: ${parseResult.squadron}, Player: ${parseResult.player}, Vehicle: ${parseResult.vehicle}` :
                            `🎯 Match found - Game: ${currentGameNumber}, Squadron: ${parseResult.squadron}, Player: ${parseResult.player}, Vehicle: ${parseResult.vehicle}`;
                        
                        if (!suppressLog) {
                            window.printToCLI(logMessage);
                        } else {
                            // trigger UI refresh without spamming CLI
                            window.broadcastEvent(logMessage, isDestroyed ? 'destroyed' : 'match');
                        }
                        
                        // Save to JSON file with status
                        window.saveDataToJSON({
                            Game: currentGameNumber,
                            Squadron: parseResult.squadron,
                            Player: parseResult.player,
                            Vehicle: parseResult.vehicle,
                            status: status
                        });
                    });
                }
            });
        }
    });

    function parseNewLine(line) {
        // Regex to match squadron, player name, and vehicle in parentheses
        // Squadron: starts and ends with various delimiters (^, =, [, ], and box drawing characters U+2500-U+257F)
        // Player name: any characters after squadron until opening parenthesis
        // Vehicle: captures content of first complete parentheses group, including nested ones
        const regex = /([\^=\[\]┌┐└┘├┤┬┴┼─│┏┓┗┛┣┫┳┻╋━┃┍┑┕┙┝┥┯┷┿┎┒┖┚┞┦┰┸╀┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿]{1}[^\^=\[\]┌┐└┘├┤┬┴┼─│┏┓┗┛┣┫┳┻╋━┃┍┑┕┙┝┥┯┷┿┎┒┖┚┞┦┰┸╀┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿()]+[\^=\[\]┌┐└┘├┤┬┴┼─│┏┓┗┛┣┫┳┻╋━┃┍┑┕┙┝┥┯┷┿┎┒┖┚┞┦┰┸╀┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿]{1})\s+([^(]+?)\s+\(([^()]*(?:\([^()]*\)[^()]*)*)\)/;
        const match = line.trim().match(regex);
        
        if (match) {
            const [, squadron, player, vehicle] = match;
            return { 
                squadron: squadron.trim(), 
                player: player.trim(), 
                vehicle: vehicle.trim(),
                originalLine: line.trim()
            };
        }
        
        return null;
    }
      

    observer.observe(target, { childList: true, subtree: true });
});
}

// Get target URL from command line arguments
const targetUrl = process.argv[2] || 'http://localhost:8111';

// Initialize and start monitoring
console.log('🚀 Starting War Thunder Log Monitor...');

// Load vehicle classifications
loadVehicleClassifications();

// Load existing game state if file is recent (less than 1 hour old)
loadGameState();

monitorTextbox(targetUrl).catch(console.error);
