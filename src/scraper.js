// src/scraper.js
const puppeteer = require('puppeteer-core');
const { resolveChromiumExecutable, loadSettings } = require('./config');
const { parseLogLine } = require('./parser');

async function startScraper(callbacks) {
  const { onNewLine, onGameIncrement, onEntry, onStatusChange } = callbacks;

  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    console.error('❌ Could not find Chrome/Edge executable.');
    console.error('   Install Google Chrome or Microsoft Edge, or set PUPPETEER_EXECUTABLE_PATH to the browser executable.');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--disable-features=SitePerProcess']
  });

  const page = await browser.newPage();
  const { telemetryUrl } = loadSettings();

  try {
    await page.goto(telemetryUrl, { waitUntil: 'domcontentloaded' });
    console.log(`✅ Page loaded at ${telemetryUrl}. Watching for updates...`);
  } catch (err) {
    console.error(`❌ Cannot connect to the service at ${telemetryUrl}.`);
    console.error(`   Make sure War Thunder is running and the telemetry service is enabled.`);
    await browser.close();
    process.exit(1);
  }

  // Expose a function from Node to the browser
  await page.exposeFunction('processRawLogLine', (line) => {
    if (onNewLine) onNewLine(line);
    const parsedEntries = parseLogLine(line);

    parsedEntries.forEach(entry => {
        // First, always record the entity as 'active' to ensure it's in the log
        onEntry({ ...entry, status: 'active' });
        // If the parsed status was 'destroyed', record that change specifically
        if (entry.status === 'destroyed') {
            onStatusChange({ ...entry, status: 'destroyed' });
        }
    });
  });

  await page.exposeFunction('signalGameIncrement', () => {
    if (onGameIncrement) onGameIncrement();
  });

  // Inject the simplified observer script into the page
  await page.evaluate(() => {
    const target = document.querySelector('#hud-dmg-msg-root > div:nth-child(2)');
    if (!target) {
      console.error('❌ Target element for logs not found on page.');
      return;
    }

    let lastText = '';
    let lastHudTsSec = null;
    let lastResetAnchor = null;

    function tsToSeconds(tsStr) {
      if (!tsStr) return 0;
      const parts = tsStr.split(':').map(p => parseInt(p, 10));
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      return 0;
    }

    const observer = new MutationObserver(() => {
      const newText = target.innerText.trim();
      if (newText && newText !== lastText) {
        const oldLines = lastText.split('\n');
        const newLines = newText.split('\n');
        const addedLines = newLines.slice(oldLines.length);
        lastText = newText;

        addedLines.forEach(line => {
          if (!line.trim()) return;

          // Check for HUD time reset to detect a new game
          const mTs = line.match(/^\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
          if (mTs) {
            const tsStr = mTs[1];
            const sec = tsToSeconds(tsStr);
            if (lastHudTsSec !== null && sec < lastHudTsSec && (lastHudTsSec - sec) >= 60) {
              if (lastResetAnchor !== tsStr) {
                window.signalGameIncrement();
                lastResetAnchor = tsStr;
              }
            }
            lastHudTsSec = sec;
          }

          // Send the raw line back to Node for parsing
          window.processRawLogLine(line);
        });
      }
    });

    observer.observe(target, { childList: true, subtree: true });
  });

  return browser;
}

module.exports = { startScraper };
