const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const CLASS_FILE = path.join(ROOT, 'comprehensive_vehicle_classifications.json');

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

function readAllVehicles() {
  if (!fs.existsSync(CLASS_FILE)) {
    throw new Error('Classification file not found: ' + CLASS_FILE);
  }
  const raw = JSON.parse(fs.readFileSync(CLASS_FILE, 'utf8'));
  // Support both formats: map and category->array
  const isMap = raw && typeof Object.values(raw)[0] === 'string';
  if (isMap) {
    return Object.keys(raw);
  }
  const out = new Set();
  Object.values(raw || {}).forEach((arr) => {
    if (Array.isArray(arr)) arr.forEach((v) => out.add(v));
  });
  return Array.from(out);
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function main() {
  // Single backup at the beginning
  try {
    if (fs.existsSync(CLASS_FILE)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = CLASS_FILE.replace(/\.json$/, `.${ts}.bak.json`);
      fs.copyFileSync(CLASS_FILE, backup);
      console.log('Backup created:', backup);
    } else {
      console.log('No existing classification file to back up.');
    }
  } catch (e) {
    console.warn('Warning: failed to create backup:', e.message);
  }

  const vehicles = readAllVehicles();
  vehicles.sort();
  console.log(`Verifying ${vehicles.length} vehicles via War Thunder Wiki...`);

  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    console.log(`[${i + 1}/${vehicles.length}] ${v}`);
    try {
      await runNode('scrape_wt_wiki.js', ['--', v]);
    } catch (e) {
      console.warn('  - Error:', e.message);
    }
    await sleep(300);
  }

  console.log('Verification complete. Check comprehensive_vehicle_classifications.json for overrides/confirmations.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Pipeline error:', err);
    process.exit(1);
  });
}
