// src/brHelper.js
// Helper to derive today's BR from settings.json seasonSchedule
const fs = require('fs');
const path = require('path');

function getTodaysBr() {
  try {
    const settingsPath = path.join(process.cwd(), 'settings.json');
    if (!fs.existsSync(settingsPath)) return null;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
    const sched = settings && settings.seasonSchedule ? settings.seasonSchedule : null;
    if (sched && typeof sched === 'object') {
      const today = new Date();
      const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
      for (const key of Object.keys(sched)) {
        const e = sched[key];
        const sd = e && e.startDate; const ed = e && e.endDate; const br = e && e.br;
        if (sd && ed && br && todayStr >= sd && todayStr <= ed) {
          return br;
        }
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

module.exports = { getTodaysBr };
