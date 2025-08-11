// index.js
const path = require('path');
const fs = require('fs');
const { ensureExternalSettings, loadSettings } = require('./src/config');
const { loadVehicleClassifications: loadVC } = require('./src/classifier');
const state = require('./src/state');
const server = require('./src/server');
const discord = require('./src/discordBot');
const scraper = require('./src/scraper');
const { runSetupWizard } = require('./src/setup');
const { startSquadronTracker } = require('./src/squadronTracker');

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
  const disableWTScrape = argv.includes('--nowtscrape');
  const disableWebServer = argv.includes('--nowebserver');
  const disableDiscordBot = argv.includes('--nodiscordbot');
  const disableWebScrape = argv.includes('--nowebscrape');
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

  // 4. Start the web and WebSocket server (unless disabled)
  if (disableWebServer) {
    console.log('ℹ️ Web server disabled for this session (--nowebserver).');
  } else {
    server.startServer();
  }

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

  // 6. Start Discord bot (unless disabled)
  try {
    if (disableDiscordBot) {
      console.log('ℹ️ Discord bot disabled for this session (--nodiscordbot).');
    } else {
      const settings = loadSettings();
      await discord.init(settings);
      console.log('✅ Discord bot initialized.');
    }
  } catch (e) {
    console.warn('⚠️ Discord bot failed to initialize:', e && e.message ? e.message : e);
  }

  // 7. Start the browser scraper (non-fatal if telemetry is unavailable)
  let scraperBrowser = null;
  let scraperRunning = false;
  let retryTimer = null;
  let squadronTracker = null;

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

  // Immediate attempt, then retry every 60 seconds if not running (unless disabled via --nowtscrape)
  if (disableWTScrape) {
    console.log('ℹ️ Telemetry scraper disabled for this session (--nowtscrape).');
  } else {
    await tryStartScraper();
    retryTimer = setInterval(() => {
      if (!scraperRunning) {
        tryStartScraper();
      }
    }, 60_000);
  }

  // Start squadron tracker (non-fatal if not configured) unless disabled
  if (disableWebScrape) {
    console.log('ℹ️ Squadron web scraper disabled for this session (--nowebscrape).');
  } else {
    try {
      const tracker = await startSquadronTracker();
      if (tracker && tracker.enabled) {
        squadronTracker = tracker;
        console.log('✅ Squadron tracker started.');
      }
    } catch (e) {
      console.warn('⚠️ Squadron tracker not started:', e && e.message ? e.message : e);
    }
  }

  console.log('✅ Application started successfully. Scraper will start when telemetry is available.');
}

main();
