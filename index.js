// index.js
const path = require('path');
const fs = require('fs');
const { ensureExternalSettings } = require('./src/config');
const { loadVehicleClassifications: loadVC } = require('./src/classifier');
const state = require('./src/state');
const server = require('./src/server');
const scraper = require('./src/scraper');
const { runSetupWizard } = require('./src/setup');

// Global safety nets
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason.stack || reason);
});

async function main() {
  console.log('🚀 Starting War Thunder Log Monitor...');

  // 1. Initial configuration setup / interactive wizard
  const argv = process.argv.slice(2);
  const forceSetup = argv.includes('-setup') || argv.includes('--setup');
  const cfgPath = path.join(process.cwd(), 'settings.json');
  const cfgMissing = !fs.existsSync(cfgPath);
  if (forceSetup || cfgMissing) {
    try {
      await runSetupWizard();
    } catch (e) {
      console.error('❌ Setup wizard failed:', e && e.message ? e.message : e);
      // As a fallback, ensure defaults exist so the app can still run
      ensureExternalSettings();
    }
  } else {
    ensureExternalSettings();
  }

  // 2. Load vehicle classifications from the external file
  try {
    const { vehicleToCategory, vehicleClassifications } = loadVC();
    state.setVehicleClassifications(vehicleToCategory, vehicleClassifications);
    console.log(`✅ Comprehensive vehicle classifications loaded (${Object.keys(vehicleToCategory).length} vehicles)`);
  } catch (error) {
    console.error('❌ Error loading vehicle classifications:', error);
    process.exit(1);
  }

  // 3. Initialize application state (rotates old logs, creates new file)
  state.loadAndPrepareInitialState();

  // 4. Start the web and WebSocket server
  server.startServer();

  // 5. Define callbacks to connect modules
  const callbacks = {
    onNewLine: (line) => {
      // This is a good place for raw logging if needed
    },
    onGameIncrement: () => {
      if (state.incrementGame()) {
        server.broadcast({ type: 'game', message: 'New game started' });
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

  // 6. Start the browser scraper (non-fatal if telemetry is unavailable)
  let scraperBrowser = null;
  let scraperRunning = false;
  let retryTimer = null;

  async function tryStartScraper() {
    if (scraperRunning) return; // prevent concurrent starts
    try {
      const browser = await scraper.startScraper(callbacks);
      scraperBrowser = browser;
      scraperRunning = true;
      console.log('✅ Scraper started.');
      // If the browser disconnects (e.g., telemetry page closes), allow retry
      try {
        browser.on('disconnected', () => {
          console.warn('⚠️ Scraper browser disconnected. Will retry in 60s.');
          scraperRunning = false;
        });
      } catch (_) {}
    } catch (error) {
      // Known transient error when WT telemetry not available
      if (error && (error.message === 'TelemetryUnavailable' || error.message === 'BrowserExecutableNotFound')) {
        console.warn('ℹ️ Scraper not started:', error.message, '- will retry in 60s.');
      } else {
        console.error('⚠️ Scraper failed to start:', error && (error.stack || error.message) || error);
      }
    }
  }

  // Immediate attempt, then retry every 60 seconds if not running
  await tryStartScraper();
  retryTimer = setInterval(() => {
    if (!scraperRunning) {
      tryStartScraper();
    }
  }, 60_000);

  console.log('✅ Application started successfully (server/discord online). Scraper will start when telemetry is available.');
}

main();
