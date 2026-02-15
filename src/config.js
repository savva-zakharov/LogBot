const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Default configuration for output order and category mapping
const DEFAULT_OUTPUT_ORDER = [
  'Light',
  'Medium',
  'Heavy',
  'SPG',
  'Fighter',
  'Attacker',
  'Bomber',
  'Heli',
  'SPAA'
];

const DEFAULT_CATEGORY_TO_OUTPUT = {
  'Medium Tank': 'Medium',
  'Heavy Tank': 'Heavy',
  'Light Tank': 'Light',
  'Tank destroyer': 'SPG',
  'Fighter': 'Fighter',
  'Attacker': 'Attacker',
  'Bomber': 'Bomber',
  'Helicopter': 'Heli',
  'SPAA': 'SPAA',
};

// Will be populated by loadSettings(); keep references stable
let OUTPUT_ORDER = [...DEFAULT_OUTPUT_ORDER];
let CATEGORY_TO_OUTPUT = { ...DEFAULT_CATEGORY_TO_OUTPUT };

function parsePort(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : NaN;
}

function loadEnvFile(filePath) {
  const map = {};
  try {
    if (!fs.existsSync(filePath)) return map;
    const raw = fs.readFileSync(filePath, 'utf8');
    raw.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      // Remove optional surrounding quotes
      map[key] = val.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    });
  } catch (_) {}
  return map;
}

// Settings loader: reads settings.json and settings.env, with env taking precedence
function loadSettings() {
  const defaults = { 
    players: {}, 
    squadrons: {}, 
    telemetryUrl: 'http://localhost:8111', 
    discordBotToken: '', 
    discordChannel: '#general', 
    clientId: '', 
    guildId: '', 
    port: 3000, 
    wsPort: 3001, 
    squadronPageUrl: '', 
    waitingVoiceChannel: '', 
    discordLogsChannel: '', 
    discordDataChannel: '', 
    discordWinLossChannell: '', 
    disablePerGameSummaries: false, 
    summaryWebhookUrl: '', 
    dataWebhookUrl: '',
    metalistManager: {},
    outputOrder: [...DEFAULT_OUTPUT_ORDER],
    categoryToOutput: {...DEFAULT_CATEGORY_TO_OUTPUT},
    tableStyle: 'light'
  };

  try {
    const cwd = process.cwd();
    const settingsPath = path.join(cwd, 'settings.json');
    const envPath = path.join(cwd, 'settings.env');
    const envMap = loadEnvFile(envPath);

    // Determine which file to read (settings.json preferred)
    const candidates = [
      settingsPath,
      path.join(cwd, 'highlights.json'),
      path.join(__dirname, '..', 'settings.json'),
      path.join(__dirname, '..', 'highlights.json'),
    ];
    const fileToRead = candidates.find(p => fs.existsSync(p));

    // If no file exists at any of the candidate locations, create minimal settings.json
    if (!fileToRead) {
      try { fs.writeFileSync(settingsPath, JSON.stringify({ players: {}, squadrons: {} }, null, 2), 'utf8'); } catch (_) {}
    }

    let jsonSettings = {};
    let rawForFile = '{}';
    let loadedFromSettingsPath = false;
    const readPath = fs.existsSync(settingsPath) ? settingsPath : fileToRead;
    if (readPath && fs.existsSync(readPath)) {
      try {
        rawForFile = fs.readFileSync(readPath, 'utf8');
        jsonSettings = JSON.parse(rawForFile || '{}');
        loadedFromSettingsPath = (readPath === settingsPath);
      } catch (e) {
        console.error(`Error reading settings file ${readPath}:`, e && e.message ? e.message : e);
        // Backup the bad file and replace with defaults to keep app running
        try {
          const backup = readPath.replace(/\.json$/i, `-bad-${Date.now()}.json`);
          fs.writeFileSync(backup, rawForFile || '', 'utf8');
          fs.writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf8');
          jsonSettings = { ...defaults };
          loadedFromSettingsPath = true;
        } catch (_) {}
      }
    }

    // Merge defaults with file values (env overrides applied later, not persisted)
    const settings = { ...defaults, ...jsonSettings };

    // Normalize essential containers
    if (!settings.players || typeof settings.players !== 'object') settings.players = {};
    if (!settings.squadrons || typeof settings.squadrons !== 'object') settings.squadrons = {};

    // Handle output configuration: mutate exported references in place
    const desiredOrder = Array.isArray(jsonSettings.outputOrder) ? jsonSettings.outputOrder.slice() : DEFAULT_OUTPUT_ORDER.slice();
    OUTPUT_ORDER.splice(0, OUTPUT_ORDER.length, ...desiredOrder);
    settings.outputOrder = OUTPUT_ORDER.slice();

    const desiredMap = (jsonSettings.categoryToOutput && typeof jsonSettings.categoryToOutput === 'object')
      ? { ...DEFAULT_CATEGORY_TO_OUTPUT, ...jsonSettings.categoryToOutput }
      : { ...DEFAULT_CATEGORY_TO_OUTPUT };
    for (const k of Object.keys(CATEGORY_TO_OUTPUT)) delete CATEGORY_TO_OUTPUT[k];
    Object.assign(CATEGORY_TO_OUTPUT, desiredMap);
    settings.categoryToOutput = { ...CATEGORY_TO_OUTPUT };

    // Apply env overrides (do not persist these to file here)
    Object.assign(settings, envMap);

    // Persist merged defaults back to settings.json if we read from it, or if it exists in cwd
    try {
      const currentOnDisk = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8') || '{}') : {};
      const toPersist = { ...currentOnDisk, ...{ players: settings.players, squadrons: settings.squadrons, telemetryUrl: settings.telemetryUrl, discordBotToken: settings.discordBotToken, discordChannel: settings.discordChannel, clientId: settings.clientId, guildId: settings.guildId, port: settings.port, wsPort: settings.wsPort, squadronPageUrl: settings.squadronPageUrl, waitingVoiceChannel: settings.waitingVoiceChannel, discordLogsChannel: settings.discordLogsChannel, discordDataChannel: settings.discordDataChannel, discordWinLossChannell: settings.discordWinLossChannell, disablePerGameSummaries: settings.disablePerGameSummaries, summaryWebhookUrl: settings.summaryWebhookUrl, dataWebhookUrl: settings.dataWebhookUrl, metalistManager: settings.metalistManager, outputOrder: settings.outputOrder, categoryToOutput: settings.categoryToOutput, tableStyle: settings.tableStyle } };
      // Only write if something changed compared to current file (ignoring env overrides)
      const before = JSON.stringify(currentOnDisk);
      const after = JSON.stringify(toPersist);
      if (before !== after) {
        fs.writeFileSync(settingsPath, JSON.stringify(toPersist, null, 2), 'utf8');
      }
    } catch (e) {
      console.error('Error updating settings.json with defaults:', e && e.message ? e.message : e);
    }

    return settings;
  } catch (error) {
    console.error('Error loading settings:', error);
    return defaults;
  }
}

// (removed duplicate helper definitions)

// Ensure an external settings.json exists in the writable working directory.
function ensureExternalSettings() {
  try {
    const cfgPath = path.join(process.cwd(), 'settings.json');
    if (!fs.existsSync(cfgPath)) {
      const defaults = {
        // Keep only non-secret structures here; use settings.env for credentials and ports
        players: {},
        squadrons: {},
      };
      fs.writeFileSync(cfgPath, JSON.stringify(defaults, null, 2), 'utf8');
      console.log(`⚙️ Created default settings at ${cfgPath}`);
    }
  } catch (e) {
    try { console.warn('⚠️ Could not create default settings.json in working directory:', e && e.message ? e.message : e); } catch (_) {}
  }
}

// Attempt to resolve a local Chrome/Edge executable for puppeteer-core
function resolveChromiumExecutable() {
    // 1) Explicit env var
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;

    if (process.platform === 'win32') {
        const tryWhere = (name) => {
            try {
                const out = execSync(`where ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
                const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                for (const l of lines) { if (l.toLowerCase().endsWith('.exe') && fs.existsSync(l)) return l; }
            } catch (_) {}
            return null;
        };

        let p = tryWhere('chrome'); if (p) return p;
        p = tryWhere('msedge'); if (p) return p;

        const regRead = (key) => {
            try {
                const out = execSync(`reg query "${key}" /ve`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
                const match = out.match(/REG_SZ\s+(.+\.exe)/i);
                if (match) {
                    const file = match[1].trim();
                    if (fs.existsSync(file)) return file;
                }
            } catch (_) {}
            return null;
        };

        const keys = [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
        ];
        for (const k of keys) { const r = regRead(k); if (r) return r; }

        const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const pf64 = process.env['ProgramW6432'] || pf;
        const local = process.env.LOCALAPPDATA || '';
        const candidates = [
            path.join(pf64, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
            path.join(pf64, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        ].filter(Boolean);
        for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
    } else {
        const tryWhich = (name) => {
            try {
                const out = execSync(`which ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                if (out && fs.existsSync(out)) return out;
            } catch (_) {}
            return null;
        };
        let p = tryWhich('google-chrome'); if (p) return p;
        p = tryWhich('google-chrome-stable'); if (p) return p;
        p = tryWhich('microsoft-edge'); if (p) return p;
        p = tryWhich('chromium'); if (p) return p;
        p = tryWhich('chromium-browser'); if (p) return p;

        const candidates = [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/microsoft-edge',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium'
        ];
        for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
    }
    return null;
}

module.exports = {
  OUTPUT_ORDER,
  CATEGORY_TO_OUTPUT,
  loadSettings,
  ensureExternalSettings,
  resolveChromiumExecutable,
};
