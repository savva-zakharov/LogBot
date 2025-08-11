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
  'Helicopter',
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
  'Helicopter': 'Helicopter',
  'SPAA': 'SPAA',
};

// Settings loader: reads settings.json and provides defaults
function loadSettings() {
  const defaults = { players: {}, squadrons: {}, telemetryUrl: 'http://localhost:8111' };
  try {
    const cwd = process.cwd();
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
      return {
        players: parsed.players || {},
        squadrons: parsed.squadrons || {},
        telemetryUrl: parsed.telemetryUrl || defaults.telemetryUrl,
      };
    }
  } catch (_) {}
  return defaults;
}

// Ensure an external settings.json exists in the writable working directory.
function ensureExternalSettings() {
  try {
    const cfgPath = path.join(process.cwd(), 'settings.json');
    if (!fs.existsSync(cfgPath)) {
      const defaults = {
        telemetryUrl: 'http://localhost:8111',
        players: {},
        squadrons: {}
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
