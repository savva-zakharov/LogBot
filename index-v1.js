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
                // File is old; infer currentGame from existing top-level game keys if possible
                try {
                    const content = fs.readFileSync(jsonFilePath, 'utf8');
                    const data = JSON.parse(content);
                    const gameKeys = Object.keys(data)
                        .filter(k => k !== '_gameState' && /^\d+$/.test(k))
                        .map(k => parseInt(k, 10));
                    if (gameKeys.length > 0) {
                        const maxGame = Math.max(...gameKeys);
                        currentGame = maxGame; // continue on the highest observed game index
                        lastGameIncrementTime = 0;
                        console.log(`📊 Inferred current game from data: ${currentGame}`);
                    }
                } catch (e) {
                    // ignore
                }
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

    await page.goto('http://localhost:8111', { waitUntil: 'domcontentloaded' });
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
                // Serve UI
                const html = `
<!DOCTYPE html>
<html>
<head>
    <title>War Thunder Log Monitor</title>
    <style>
        body { font-family: Arial, sans-serif; background: #1a1a1a; color: #fff; margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { color: #4CAF50; text-align: center; }
        .log-container { background: #2d2d2d; border-radius: 8px; padding: 20px; height: 70vh; overflow-y: auto; }
        .log-entry { margin: 5px 0; padding: 8px; border-radius: 4px; font-family: monospace; }
        .match { background: #1b4332; border-left: 4px solid #4CAF50; }
        .game { background: #1a237e; border-left: 4px solid #2196F3; }
        .info { background: #3e2723; border-left: 4px solid #FF9800; }
        .error { background: #4a0e0e; border-left: 4px solid #f44336; }
        .stats { display: flex; gap: 20px; margin: 20px 0; }
        .stat-box { background: #2d2d2d; padding: 15px; border-radius: 8px; flex: 1; text-align: center; }
        .stat-number { font-size: 24px; font-weight: bold; color: #4CAF50; }
    </style>
</head>
<body>
    <div class="container">
        <h1>War Thunder Log Monitor</h1>
        <div class="stats">
            <div class="stat-box">
                <div class="stat-number" id="currentGame">0</div>
                <div>Current Game</div>
            </div>
            <div class="stat-box">
                <div class="stat-number" id="totalMatches">0</div>
                <div>Total Matches</div>
            </div>
            <div class="stat-box">
                <div class="stat-number" id="uniquePlayers">0</div>
                <div>Unique Players</div>
            </div>
        </div>
        <div class="log-container" id="vehicleList">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <h3 style="margin: 0; color: #4CAF50;">Current Game Vehicles</h3>
                <div class="filter-controls" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                    <select id="classificationFilter" style="background: #2d2d2d; color: #fff; border: 1px solid #555; padding: 5px 8px; border-radius: 4px; font-size: 12px;">
                        <option value="all">All Types</option>
                        <option value="tanks">Tanks</option>
                        <option value="light_scout">Light/Scout</option>
                        <option value="bombers">Bombers</option>
                        <option value="fixed_wing">Fighters</option>
                        <option value="helicopters">Helicopters</option>
                        <option value="anti_air">Anti-Air</option>
                        <option value="other">Other</option>
                    </select>
                    <select id="squadronFilter" style="background: #2d2d2d; color: #fff; border: 1px solid #555; padding: 5px 8px; border-radius: 4px; font-size: 12px;">
                        <option value="all">All Squadrons</option>
                    </select>
                    <select id="playerFilter" style="background: #2d2d2d; color: #fff; border: 1px solid #555; padding: 5px 8px; border-radius: 4px; font-size: 12px;">
                        <option value="all">All Players</option>
                    </select>
                    <select id="vehicleFilter" style="background: #2d2d2d; color: #fff; border: 1px solid #555; padding: 5px 8px; border-radius: 4px; font-size: 12px; min-width: 220px;">
                        <option value="all">All Vehicles</option>
                    </select>
                    <div class="status-filters" style="display: flex; gap: 5px;">
                        <button id="showAll" class="filter-btn active" style="background: #4CAF50; color: #fff; border: none; padding: 5px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;">All</button>
                        <button id="showActive" class="filter-btn" style="background: #555; color: #fff; border: none; padding: 5px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;">Active</button>
                        <button id="showDestroyed" class="filter-btn" style="background: #555; color: #fff; border: none; padding: 5px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;">Destroyed</button>
                    </div>
                </div>
            </div>
            <div id="activeVehicles">No vehicles in current game</div>
        </div>
    </div>
    <script>
        const ws = new WebSocket('ws://localhost:3001');
        const currentGameEl = document.getElementById('currentGame');
        const totalMatchesEl = document.getElementById('totalMatches');
        const uniquePlayersEl = document.getElementById('uniquePlayers');
        const activeVehiclesEl = document.getElementById('activeVehicles');
        
        let totalMatches = 0;
        let uniquePlayers = new Set();
        let allVehiclesData = []; // Store all vehicles data for filtering
        let currentStatusFilter = 'all'; // 'all', 'active', 'destroyed'
        let currentSquadronFilter = 'all';
        let currentPlayerFilter = 'all';
        let currentVehicleFilter = 'all';
        let currentClassificationFilter = 'all'; // 'all', 'tanks', 'light_scout', etc.
        
        // Function to update all vehicles display organized by squadron
        const updateActiveVehicles = async () => {
            try {
                // Respect selected game if set
                let url = '/api/active-vehicles';
                const selectedGameStr = localStorage.getItem('selectedGame');
                if (selectedGameStr && /^\d+$/.test(selectedGameStr)) {
                    url += '?game=' + encodeURIComponent(selectedGameStr);
                }
                const response = await fetch(url);
                const vehicles = await response.json();
                
                // Store all vehicles data for filtering
                allVehiclesData = vehicles;
                
                // Update filters dropdowns (squadron, player, vehicle)
                try { updateSquadronFilter && updateSquadronFilter(vehicles); } catch(_) {}
                const playerSelect = document.getElementById('playerFilter');
                const vehicleSelect = document.getElementById('vehicleFilter');
                if (playerSelect) {
                    const players = Array.from(new Set(vehicles.map(v => v.player))).sort((a,b)=>a.localeCompare(b));
                    const prev = playerSelect.value;
                    playerSelect.innerHTML = '<option value="all">All Players</option>' + players.map(p => '<option value="' + p.replace(/"/g,'&quot;') + '\">' + p + '</option>').join('');
                    playerSelect.value = prev && (prev === 'all' || players.includes(prev)) ? prev : 'all';
                }
                if (vehicleSelect) {
                    const vehiclesList = Array.from(new Set(vehicles.map(v => v.vehicle))).sort((a,b)=>a.localeCompare(b));
                    const prev = vehicleSelect.value;
                    vehicleSelect.innerHTML = '<option value="all">All Vehicles</option>' + vehiclesList.map(p => '<option value="' + p.replace(/"/g,'&quot;') + '\">' + p + '</option>').join('');
                    vehicleSelect.value = prev && (prev === 'all' || vehiclesList.includes(prev)) ? prev : 'all';
                }
                
                // Apply current filters and display
                displayFilteredVehicles();
            } catch (error) {
                console.error('Failed to fetch active vehicles:', error);
            }
        };
        
        // Function to update squadron filter dropdown
        const updateSquadronFilter = (vehicles) => {
            const squadronFilter = document.getElementById('squadronFilter');
            const squadrons = [...new Set(vehicles.map(v => v.squadron))].sort();
            
            // Clear existing options except "All Squadrons"
            squadronFilter.innerHTML = '<option value="all">All Squadrons</option>';
            
            // Add squadron options
            squadrons.forEach(squadron => {
                const option = document.createElement('option');
                option.value = squadron;
                option.textContent = squadron;
                if (squadron === currentSquadronFilter) {
                    option.selected = true;
                }
                squadronFilter.appendChild(option);
            });
        };
        
        // Function to display filtered vehicles
        const displayFilteredVehicles = () => {
            let filteredVehicles = allVehiclesData;
            
            // Apply status filter
            if (currentStatusFilter === 'active') {
                filteredVehicles = filteredVehicles.filter(v => v.status === 'active');
            } else if (currentStatusFilter === 'destroyed') {
                filteredVehicles = filteredVehicles.filter(v => v.status === 'destroyed');
            }
            
            // Apply classification filter
            if (currentClassificationFilter !== 'all') {
                filteredVehicles = filteredVehicles.filter(v => v.classification === currentClassificationFilter);
            }
            
            // Apply squadron filter
            if (currentSquadronFilter !== 'all') {
                filteredVehicles = filteredVehicles.filter(v => v.squadron === currentSquadronFilter);
            }
            
            if (filteredVehicles.length === 0) {
                activeVehiclesEl.innerHTML = '<div style="color: #888; text-align: center; padding: 20px;">No vehicles match current filters</div>';
                return;
            }
            
            // Group filtered vehicles by classification first, then by squadron
                const classificationGroups = {};
                filteredVehicles.forEach(v => {
                    if (!classificationGroups[v.classification]) {
                        classificationGroups[v.classification] = {};
                    }
                    if (!classificationGroups[v.classification][v.squadron]) {
                        classificationGroups[v.classification][v.squadron] = [];
                    }
                    classificationGroups[v.classification][v.squadron].push(v);
                });
                
                // Sort classifications and squadrons
                const sortedClassifications = Object.keys(classificationGroups).sort();
                
                // Get classification display names and colors
                const classificationDisplay = {
                    'tanks': { name: 'Tanks', color: '#8B4513' },
                    'light_scout': { name: 'Light/Scout', color: '#32CD32' },
                    'bombers': { name: 'Bombers', color: '#FF4500' },
                    'fixed_wing': { name: 'Fighters', color: '#1E90FF' },
                    'helicopters': { name: 'Helicopters', color: '#9370DB' },
                    'anti_air': { name: 'Anti-Air', color: '#FFD700' },
                    'other': { name: 'Other', color: '#808080' }
                };
                
                const classificationHTML = sortedClassifications.map(classification => {
                    const squadronGroups = classificationGroups[classification];
                    const sortedSquadrons = Object.keys(squadronGroups).sort();
                    const classInfo = classificationDisplay[classification] || { name: classification, color: '#808080' };
                    
                    const squadronHTML = sortedSquadrons.map(squadron => {
                        const squadronVehicles = squadronGroups[squadron];
                    
                    // Sort vehicles: active first, then destroyed
                    squadronVehicles.sort((a, b) => {
                        if (a.status === 'active' && b.status === 'destroyed') return -1;
                        if (a.status === 'destroyed' && b.status === 'active') return 1;
                        return a.player.localeCompare(b.player); // Then by player name
                    });
                    
                    const activeCount = squadronVehicles.filter(v => v.status === 'active').length;
                    const destroyedCount = squadronVehicles.filter(v => v.status === 'destroyed').length;
                    
                    const vehicleHTML = squadronVehicles.map(v => {
                        const isDestroyed = v.status === 'destroyed';
                        const borderColor = isDestroyed ? '#f44336' : '#4CAF50';
                        const backgroundColor = isDestroyed ? '#2a0a0a' : '#0f2a1a';
                        const vehicleColor = isDestroyed ? '#f44336' : '#4CAF50';
                        const statusText = isDestroyed ? '[X]' : '[OK]';
                        const statusColor = isDestroyed ? '#f44336' : '#4CAF50';
                        
                        return \`
                        <div class="vehicle-entry" style="background: \${backgroundColor}; margin: 1px 0; padding: 4px 8px; border-radius: 3px; border-left: 2px solid \${borderColor}; font-size: 12px;">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div style="color: #fff; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                                    \${v.player}
                                </div>
                                <div style="text-align: right; flex: 2; min-width: 0; margin-left: 8px;">
                                    <span style="color: \${vehicleColor}; font-weight: 500; font-size: 11px;">\${v.vehicle}</span>
                                    <span style="color: \${statusColor}; margin-left: 4px; font-size: 10px;">\${statusText}</span>
                                </div>
                            </div>
                        </div>
                        \`;
                    }).join('');
                    
                        return \`
                        <div class="squadron-group" style="margin-bottom: 8px;">
                            <div style="background: #333; padding: 4px 8px; border-radius: 3px; margin-bottom: 2px; border-left: 2px solid #4CAF50;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <h5 style="margin: 0; color: #4CAF50; font-size: 11px; font-weight: 500;">\${squadron}</h5>
                                    <div style="color: #888; font-size: 9px;">
                                        <span style="color: #4CAF50;">\${activeCount}</span>/<span style="color: #f44336;">\${destroyedCount}</span>
                                    </div>
                                </div>
                            </div>
                            <div style="margin-left: 6px;">
                                \${vehicleHTML}
                            </div>
                        </div>
                        \`;
                    }).join('');
                    
                    // Calculate total counts for this classification
                    const totalActive = Object.values(squadronGroups).flat().filter(v => v.status === 'active').length;
                    const totalDestroyed = Object.values(squadronGroups).flat().filter(v => v.status === 'destroyed').length;
                    
                    return \`
                    <div class="classification-group" style="margin-bottom: 15px;">
                        <div style="background: #2a2a2a; padding: 8px 12px; border-radius: 5px; margin-bottom: 5px; border-left: 4px solid \${classInfo.color};">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <h3 style="margin: 0; color: \${classInfo.color}; font-size: 14px; font-weight: 600;">\${classInfo.name}</h3>
                                <div style="color: #888; font-size: 11px;">
                                    <span style="color: #4CAF50;">\${totalActive}</span>/<span style="color: #f44336;">\${totalDestroyed}</span>
                                </div>
                            </div>
                        </div>
                        <div style="margin-left: 10px;">
                            \${squadronHTML}
                        </div>
                    </div>
                    \`;
                }).join('');
                
                // Apply filters
                const filtered = allVehiclesData.filter(v => {
                    if (currentStatusFilter !== 'all' && v.status !== currentStatusFilter) return false;
                    if (currentClassificationFilter !== 'all' && v.classification !== currentClassificationFilter) return false;
                    if (currentSquadronFilter !== 'all' && v.squadron !== currentSquadronFilter) return false;
                    if (currentPlayerFilter !== 'all' && v.player !== currentPlayerFilter) return false;
                    if (currentVehicleFilter !== 'all' && v.vehicle !== currentVehicleFilter) return false;
                    return true;
                });

                // Build table-like view reflecting hierarchy
                const rows = filtered.map(v => {
                    const statusColor = v.status === 'destroyed' ? '#f44336' : '#4CAF50';
                    return '<tr>'+
                        '<td style="padding:6px 8px; color:#bbb;">' + v.game + '</td>'+
                        '<td style="padding:6px 8px;">' + v.squadron + '</td>'+
                        '<td style="padding:6px 8px;">' + v.player + '</td>'+
                        '<td style="padding:6px 8px;">' + v.vehicle + '</td>'+
                        '<td style="padding:6px 8px;">' + v.classification + '</td>'+
                        '<td style="padding:6px 8px; color:' + statusColor + ';">' + v.status + '</td>'+
                    '</tr>';
                }).join('');

                const tableHTML = '<table style="width:100%; border-collapse:collapse; font-size:12px;">'+
                    '<thead><tr style="background:#222;">'+
                        '<th style="text-align:left; padding:6px 8px; border-bottom:1px solid #444; color:#888;">Game</th>'+
                        '<th style="text-align:left; padding:6px 8px; border-bottom:1px solid #444; color:#888;">Squadron</th>'+
                        '<th style="text-align:left; padding:6px 8px; border-bottom:1px solid #444; color:#888;">Player</th>'+
                        '<th style="text-align:left; padding:6px 8px; border-bottom:1px solid #444; color:#888;">Vehicle</th>'+
                        '<th style="text-align:left; padding:6px 8px; border-bottom:1px solid #444; color:#888;">Type</th>'+
                        '<th style="text-align:left; padding:6px 8px; border-bottom:1px solid #444; color:#888;">Status</th>'+
                    '</tr></thead>'+
                    '<tbody>' + (rows || '') + '</tbody></table>';

                activeVehiclesEl.innerHTML = rows ? tableHTML : 'No vehicles in current game';
        };

        // No special renderer needed; we will fetch selected game inside updateActiveVehicles
        
        // Create Game selector UI (attach to filters row beside other selectors; fallback to floating if not found)
        let hostEl = document.querySelector('.filter-controls');
        if (!hostEl) {
            hostEl = document.getElementById('game-selector-wrapper');
            if (!hostEl) {
                hostEl = document.createElement('div');
                hostEl.id = 'game-selector-wrapper';
                hostEl.style.position = 'fixed';
                hostEl.style.top = '6px';
                hostEl.style.right = '8px';
                hostEl.style.zIndex = '9999';
                hostEl.style.background = 'rgba(0,0,0,0.5)';
                hostEl.style.padding = '4px 6px';
                hostEl.style.borderRadius = '4px';
                hostEl.style.border = '1px solid #444';
                document.body.appendChild(hostEl);
            }
        }
        if (hostEl && !document.getElementById('game-selector')) {
            const sel = document.createElement('select');
            sel.id = 'game-selector';
            sel.style.marginLeft = '8px';
            sel.style.padding = '2px 6px';
            sel.style.background = '#222';
            sel.style.color = '#ddd';
            sel.style.border = '1px solid #444';
            sel.style.borderRadius = '3px';
            const label = document.createElement('span');
            label.textContent = 'Game:';
            label.style.marginLeft = '8px';
            label.style.color = '#aaa';
            hostEl.appendChild(label);
            hostEl.appendChild(sel);

            const refreshGames = async () => {
                try {
                    const [gamesResp, currentResp] = await Promise.all([
                        fetch('/api/games-list'),
                        fetch('/api/current-game')
                    ]);
                    const games = await gamesResp.json();
                    const currentJson = await currentResp.json();
                    const current = parseInt(currentJson.currentGame, 10);
                    const selected = parseInt(localStorage.getItem('selectedGame') || current, 10);
                    sel.innerHTML = '';
                    games.forEach(g => {
                        const opt = document.createElement('option');
                        opt.value = String(g);
                        opt.textContent = 'Game ' + g;
                        if (g === selected) opt.selected = true;
                        sel.appendChild(opt);
                    });
                    // If no games listed yet, ensure current appears
                    if (games.length === 0) {
                        const opt = document.createElement('option');
                        opt.value = String(current);
                        opt.textContent = 'Game ' + current;
                        opt.selected = true;
                        sel.appendChild(opt);
                    }
                } catch (e) {
                    console.error('Failed to refresh games list', e);
                }
            };

            sel.addEventListener('change', async () => {
                localStorage.setItem('selectedGame', sel.value);
                await updateActiveVehicles();
            });

            // initial populate
            refreshGames().then(() => updateActiveVehicles());
        }

        // Event handlers for filter controls
        document.addEventListener('DOMContentLoaded', () => {
            // Status filter buttons
            const filterButtons = document.querySelectorAll('.filter-btn');
            filterButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    // Remove active class from all buttons
                    filterButtons.forEach(b => {
                        b.classList.remove('active');
                        b.style.background = '#555';
                    });
                    
                    // Add active class to clicked button
                    e.target.classList.add('active');
                    e.target.style.background = '#4CAF50';
                    
                    // Update filter
                    if (e.target.id === 'showAll') {
                        currentStatusFilter = 'all';
                    } else if (e.target.id === 'showActive') {
                        currentStatusFilter = 'active';
                    } else if (e.target.id === 'showDestroyed') {
                        currentStatusFilter = 'destroyed';
                    }
                    
                    // Refresh display
                    displayFilteredVehicles();
                });
            });
            
            // Classification filter dropdown
            const classificationFilter = document.getElementById('classificationFilter');
            classificationFilter.addEventListener('change', (e) => {
                currentClassificationFilter = e.target.value;
                displayFilteredVehicles();
            });
            
            // Squadron filter dropdown
            const squadronFilter = document.getElementById('squadronFilter');
            squadronFilter.addEventListener('change', (e) => {
                currentSquadronFilter = e.target.value;
                displayFilteredVehicles();
            });
            // Player filter dropdown
            const playerFilter = document.getElementById('playerFilter');
            playerFilter.addEventListener('change', (e) => {
                currentPlayerFilter = e.target.value;
                displayFilteredVehicles();
            });
            // Vehicle filter dropdown
            const vehicleFilter = document.getElementById('vehicleFilter');
            vehicleFilter.addEventListener('change', (e) => {
                currentVehicleFilter = e.target.value;
                displayFilteredVehicles();
            });
        });
        
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            // Update stats
            if (data.type === 'match' || data.type === 'destroyed') {
                totalMatches++;
                totalMatchesEl.textContent = totalMatches;
                
                // Extract player name from message
                const playerMatch = data.message.match(/Player: ([^,]+)/);
                if (playerMatch) {
                    uniquePlayers.add(playerMatch[1]);
                    uniquePlayersEl.textContent = uniquePlayers.size;
                }
                
                // Update active vehicles list
                updateActiveVehicles();
            }
            
            if (data.type === 'game') {
                const gameMatch = data.message.match(/Game incremented to (\d+)/);
                if (gameMatch) {
                    currentGameEl.textContent = gameMatch[1];
                    // Refresh game selector options if present
                    const sel = document.getElementById('game-selector');
                    if (sel) {
                        (async () => {
                            try { await refreshGames(); } catch(e) {}
                            try { await updateActiveVehicles(); } catch(e) {}
                        })();
                    }
                }
            }
        };
        
        ws.onopen = () => {
            // Initialize and start monitoring
            console.log('🚀 Starting War Thunder Log Monitor...');
            
            // Load vehicle classifications
            loadVehicleClassifications();
            
            // Load existing game state if file is recent (less than 1 hour old)
            loadGameState();
            
            // Request current game number on connection
            fetch('/api/current-game')
                .then(response => response.json())
                .then(data => {
                    currentGameEl.textContent = data.currentGame;
                })
                .catch(error => console.error('Failed to fetch current game:', error));
        };
        
        // Update active vehicles every 5 seconds
        setInterval(updateActiveVehicles, 5000);
    </script>
</body>
</html>`;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
        } catch (err) {
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
    const DEDUPE_MS = 3000; // suppress identical events seen within 3 seconds

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

// Initialize and start monitoring
console.log('🚀 Starting War Thunder Log Monitor...');

// Load vehicle classifications
loadVehicleClassifications();

// Load existing game state if file is recent (less than 1 hour old)
loadGameState();

monitorTextbox().catch(console.error);
