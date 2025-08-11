const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Summary output columns order
const OUTPUT_ORDER = [
  'Medium',
  'Heavy',
  'Light',
  'SPG',
  'Fighter',
  'Attacker',
  'Bomber',
  'Heli',
  'SPAA'
];

// Map Title Case categories from classifier to summary labels
const CATEGORY_TO_OUTPUT = {
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

// Settings loader: reads settings.json and settings.env, with env taking precedence
function loadSettings() {
  const defaults = { players: {}, squadrons: {}, telemetryUrl: 'http://localhost:8111', discordBotToken: '', discordChannel: '#general', clientId: '', guildId: '', port: 3000, wsPort: 3001 };
  try {
    const cwd = process.cwd();
    const envPath = path.join(cwd, 'settings.env');
    const envMap = loadEnvFile(envPath);
    const candidates = [
      path.join(cwd, 'settings.json'),
      path.join(cwd, 'highlights.json'), // fallback for legacy name
      path.join(__dirname, '../', 'settings.json'), // Adjusted path for src directory
      path.join(__dirname, '../', 'highlights.json'),
    ];
    const fileToRead = candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
    if (!fileToRead) return defaults;
    const raw = fs.readFileSync(fileToRead, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const base = {
        players: parsed.players || {},
        squadrons: parsed.squadrons || {},
        telemetryUrl: parsed.telemetryUrl || defaults.telemetryUrl,
        discordBotToken: typeof parsed.discordBotToken === 'string' ? parsed.discordBotToken : defaults.discordBotToken,
        discordChannel: typeof parsed.discordChannel === 'string' ? parsed.discordChannel : defaults.discordChannel,
        clientId: typeof parsed.clientId === 'string' ? parsed.clientId : defaults.clientId,
        guildId: typeof parsed.guildId === 'string' ? parsed.guildId : defaults.guildId,
        port: (typeof parsed.port === 'number' && Number.isFinite(parsed.port)) ? parsed.port : defaults.port,
        wsPort: (typeof parsed.wsPort === 'number' && Number.isFinite(parsed.wsPort)) ? parsed.wsPort : defaults.wsPort,
      };
      // Override with settings.env values if present, then process.env
      const envOverrides = {
        telemetryUrl: envMap.TELEMETRY_URL || process.env.TELEMETRY_URL,
        discordBotToken: envMap.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN,
        discordChannel: envMap.DISCORD_CHANNEL || process.env.DISCORD_CHANNEL,
        clientId: envMap.CLIENT_ID || process.env.CLIENT_ID,
        guildId: envMap.GUILD_ID || process.env.GUILD_ID,
        port: parsePort(envMap.PORT || process.env.PORT),
        wsPort: parsePort(envMap.WS_PORT || process.env.WS_PORT),
      };
      return {
        players: base.players,
        squadrons: base.squadrons,
        telemetryUrl: envOverrides.telemetryUrl || base.telemetryUrl || defaults.telemetryUrl,
        discordBotToken: (envOverrides.discordBotToken !== undefined ? envOverrides.discordBotToken : base.discordBotToken) || defaults.discordBotToken,
        discordChannel: envOverrides.discordChannel || base.discordChannel || defaults.discordChannel,
        clientId: (envOverrides.clientId !== undefined ? envOverrides.clientId : base.clientId) || defaults.clientId,
        guildId: (envOverrides.guildId !== undefined ? envOverrides.guildId : base.guildId) || defaults.guildId,
        port: Number.isFinite(envOverrides.port) ? envOverrides.port : base.port,
        wsPort: Number.isFinite(envOverrides.wsPort) ? envOverrides.wsPort : base.wsPort,
      };
    }
  } catch (_) {}
  return defaults;
}

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
