const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const CLASS_FILE = path.join(ROOT, 'comprehensive_vehicle_classifications.json');

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

function findLatestBatchFile() {
  const files = fs.readdirSync(ROOT)
    .filter(f => /^classification_batch_results_.*\.json$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(ROOT, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(ROOT, files[0].f) : null;
}

function readUnclassified(latestPath) {
  const raw = fs.readFileSync(latestPath, 'utf8');
  const json = JSON.parse(raw);
  const list = Array.from(new Set((json.unclassifiedVehicles || []).filter(Boolean)));
  return list;
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

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

  console.log('Running batch classification over parsed_data files...');
  await runNode('test_classification_batch.js');

  const latest = findLatestBatchFile();
  if (!latest) {
    console.error('No classification_batch_results_*.json found.');
    process.exit(1);
  }
  console.log('Using latest results:', latest);

  const unclassified = readUnclassified(latest);
  console.log(`Unclassified vehicles: ${unclassified.length}`);
  if (unclassified.length === 0) {
    console.log('Nothing to enrich.');
    return;
  }

  // Feed each vehicle into the wiki scraper sequentially
  for (let i = 0; i < unclassified.length; i++) {
    const v = unclassified[i];
    console.log(`[${i + 1}/${unclassified.length}] Enriching via wiki: ${v}`);
    try {
      await runNode('scrape_wt_wiki.js', ['--', v]);
    } catch (e) {
      console.warn('  - Error for', v, ':', e.message);
    }
    await sleep(500); // small gap between invocations; scraper has its own politeness delays too
  }

  console.log('Done. comprehensive_vehicle_classifications.json should be updated.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Pipeline error:', err);
    process.exit(1);
  });
}
