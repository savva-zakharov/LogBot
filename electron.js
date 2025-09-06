// electron.js



const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { ensureExternalSettings, loadSettings } = require('./src/config');
const { decryptWithPlayerName } = require('./src/decodeNameKey');
const readline = require('readline');
const { loadVehicleClassifications: loadVC } = require('./src/classifier');
const state = require('./src/state');
const server = require('./src/server');
const { runSetupWizard } = require('./src/setup');
const metalistManager = require('./src/utils/metalistManager');

// Global safety nets
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason.stack || reason);
});

async function initialize() {
  console.log('🚀 Starting War Thunder Log Monitor (Electron Client)...');

  let mainWindow;

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    mainWindow.loadFile('public/index.html');

    mainWindow.on('closed', function () {
      mainWindow = null;
    });
  }

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    }
  });

  createWindow();

  // 0. Initialize Metalist data
  try {
    await metalistManager.loadMetalist();
    const latestBR = metalistManager.getLatestBR();
    if (latestBR) {
      console.log(`✅ Loaded Metalist data (latest BR: ${latestBR})`);
    } else {
      console.log('⚠️  No Metalist data loaded');
    }
  } catch (error) {
    console.error('❌ Failed to load Metalist data:', error.message);
  }

  // 1. Initial configuration setup
  const cfgPath = path.join(process.cwd(), 'settings.json');
  const cfgMissing = !fs.existsSync(cfgPath);
  if (cfgMissing) {
    try {
      await runSetupWizard();
    } catch (e) {
      console.error('❌ Setup wizard failed:', e && e.message ? e.message : e);
      ensureExternalSettings();
    }
  } else {
    ensureExternalSettings();
  }

  // Client mode logic from index.js
  const argv = process.argv.slice(2);
  let clientArg = null;
  const idx = argv.findIndex(a => a === '--client' || a.startsWith('--client='));
  if (idx !== -1) {
    const token = argv[idx];
    const eqIdx = token.indexOf('=');
    if (eqIdx > 0) {
      clientArg = token.slice(eqIdx + 1).trim();
    } else if (argv[idx + 1] && !argv[idx + 1].startsWith('--')) {
      clientArg = String(argv[idx + 1]).trim();
    }
  }

  const persistWebhook = (input) => {
    try {
      const cfgPathLocal = path.join(process.cwd(), 'settings.json');
      const raw = fs.existsSync(cfgPathLocal) ? fs.readFileSync(cfgPathLocal, 'utf8') : '{}';
      const j = JSON.parse(raw || '{}');
      if (input && typeof input === 'object' && input.logs && input.data) {
        j.summaryWebhookUrl = input.logs;
        j.dataWebhookUrl = input.data;
        fs.writeFileSync(cfgPathLocal, JSON.stringify(j, null, 2), 'utf8');
        console.log('✅ summaryWebhookUrl and dataWebhookUrl saved to settings.json');
        return;
      }
      console.log('ℹ️ No bundle provided; leaving settings.json unchanged');
    } catch (e) {
      console.warn('⚠️ Could not persist webhook settings:', e && e.message ? e.message : e);
    }
  };

  const tryDecodeBase64Bundle = (s) => {
    try {
      const buf = Buffer.from(String(s || '').trim(), 'base64');
      const txt = buf.toString('utf8');
      const obj = JSON.parse(txt);
      if (obj && typeof obj === 'object' && typeof obj.logs === 'string' && typeof obj.data === 'string') return obj;
    } catch (_) {}
    return null;
  };

  const tryDecodeKeyedBundle = (s) => {
    try {
      const token = String(s || '').trim();
      if (!token.startsWith('n1:')) return null;
      const cfgPathLocal = path.join(process.cwd(), 'settings.json');
      const raw = fs.existsSync(cfgPathLocal) ? fs.readFileSync(cfgPathLocal, 'utf8') : '{}';
      const j = JSON.parse(raw || '{}');
      const players = j && j.players && typeof j.players === 'object' ? Object.keys(j.players) : [];
      for (const name of players) {
        try {
          const payload = decryptWithPlayerName(token, name);
          if (payload && typeof payload.logs === 'string' && typeof payload.data === 'string') {
            console.log(`✅ Decoded bundle using player key: ${name}`);
            return payload;
          }
        } catch (_) { /* try next */ }
      }
    } catch (_) {}
    return null;
  };

  if (!clientArg) {
    // In Electron, we can't easily prompt in the console.
    // This part could be replaced with a dialog box in the UI.
    console.log('ℹ️ No client bundle token provided via command line.');
  } else {
    let bundle = tryDecodeBase64Bundle(clientArg);
    if (!bundle) bundle = tryDecodeKeyedBundle(clientArg);
    if (bundle) { persistWebhook(bundle); }
    else { console.warn('⚠️ --client value is not a valid bundle. Skipping.'); }
  }


  // 2. Load vehicle classifications
  try {
    const { vehicleToCategory, vehicleClassifications } = loadVC();
    state.setVehicleClassifications(vehicleToCategory, vehicleClassifications);
    console.log(`✅ Comprehensive vehicle classifications loaded (${Object.keys(vehicleToCategory).length} vehicles)`);
  } catch (error) {
    console.error('❌ Error loading vehicle classifications:', error);
    app.quit();
  }

  // 3. Initialize application state
  state.loadAndPrepareInitialState();

  // 4. Start the web and WebSocket server
  server.startServer();


  // 5. Define callbacks
  const callbacks = {
    onNewLine: (line) => {},
    onGameIncrement: () => {
      if (state.incrementGame()) {
        server.broadcast({ type: 'game', message: 'New game started' });
        try {
          const payload = postLogs(state.getCurrentGame());
          if (payload && payload.ok) {
            console.log(`[MISSION] POST-LOGS: posted logs for game ${payload.game} after increment`);
          } else {
            console.warn('[MISSION] POST-LOGS: failed to post logs after increment');
          }
        } catch (e) {
          console.warn('[MISSION] POST-LOGS: error posting logs after increment:', e && e.message ? e.message : e);
        }
      }
    },
    onEntry: (entry) => {
      const current_game = state.getCurrentGame();
      const new_entry = state.recordEntry({ ...entry, game: current_game });
      if(new_entry){
        server.broadcast({ type: 'update', message: 'New vehicle entry', data: new_entry });
      }
    },
    onStatusChange: (entry) => {
        const current_game = state.getCurrentGame();
        const new_entry = state.recordEntry({ ...entry, game: current_game, status: 'destroyed' });
        if(new_entry){
            server.broadcast({ type: 'update', message: 'Vehicle destroyed', data: new_entry });
        }
    }
  };

  console.log('✅ Application started successfully.');
}

app.whenReady().then(initialize);
