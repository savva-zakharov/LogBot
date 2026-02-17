// src/tracker/schedule.js
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchTextWithFallback, fetchText } = require('./scraper');
const { logError } = require('./utils');

const SETTINGS_FILE = 'settings.json';
const SCHEDULE_FILE = 'sqbbr.txt';
const SCHEDULE_URL = 'https://forum.warthunder.com/t/season-schedule-for-squadron-battles/4446';

function getSettingsFilePath() {
  return path.join(process.cwd(), SETTINGS_FILE);
}

function getScheduleFilePath() {
  return path.join(process.cwd(), SCHEDULE_FILE);
}

/**
 * Strip header line ending with ':' before the schedule list
 */
function stripHeaderPrefix(s) {
  try {
    const text = String(s || '');
    const colon = text.indexOf(':');
    if (colon !== -1) {
      const firstParen = text.indexOf('(');
      if (colon < 200 && (firstParen === -1 || colon < firstParen)) {
        return text.slice(colon + 1).trim();
      }
    }
    return text;
  } catch (e) {
    logError('stripHeaderPrefix', e);
    return String(s || '');
  }
}

/**
 * Parse a schedule entry text into structured data
 */
function parseEntry(text, year) {
  const brMatch = text.match(/\b(?:BR|БР)\s*([0-9]+(?:\.[0-9]+)?)/i);
  const rangeMatch = text.match(/\((\d{2})\.(\d{2})\s*[—-]\s*(\d{2})\.(\d{2})\)/);
  let br = brMatch ? brMatch[1] : null;
  if (!br) {
    const fallbackMatch = text.match(/([0-9]+\.[0-9]+)\s*\(/);
    if (fallbackMatch) {
      br = fallbackMatch[1];
    }
  }
  let startDate = null, endDate = null;
  if (rangeMatch) {
    const [_, d1, m1, d2, m2] = rangeMatch;
    const pad = (s) => String(s).padStart(2, '0');
    startDate = `${year}-${pad(m1)}-${pad(d1)}`;
    endDate = `${year}-${pad(m2)}-${pad(d2)}`;
    try {
      if (parseInt(m2, 10) < parseInt(m1, 10)) {
        console.warn(`[SEASON] Date range spans year boundary? '${text}' -> start ${startDate}, end ${endDate}`);
      }
    } catch (e) {
      logError('parseEntry.yearWrapCheck', e);
    }
  }
  return { br, startDate, endDate };
}

/**
 * Initialize season schedule from forum post
 */
async function initSeasonSchedule() {
  try {
    console.log(`[SEASON] Fetching schedule from: ${SCHEDULE_URL}`);
    const raw = await fetchTextWithFallback(SCHEDULE_URL);
    if (!raw) {
      console.warn('[SEASON] No HTML received from forum URL. Aborting schedule init.');
      return;
    }
    const $ = cheerio.load(raw);
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';
    const metaDesc = ogDesc || $('meta[name="description"]').attr('content') || '';
    if (!metaDesc) {
      console.warn('[SEASON] No og:description/meta description found. Aborting schedule init.');
      return;
    }
    console.log(`[SEASON] og:description length: ${metaDesc.length}`);
    
    // Prepare a cleaned version for EN parsing: strip Cyrillic, normalize dashes and whitespace
    const metaDescEn = String(metaDesc)
      .replace(/[–—−]/g, '-')
      .replace(/[\u0400-\u04FF]/g, '')
      .replace(/[\t\r\f\v]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    
    const metaDescStripped = stripHeaderPrefix(metaDesc);
    const metaDescEnStripped = stripHeaderPrefix(metaDescEn);
    
    // Extract schedule-like snippets
    const lines = [];
    const pushMatch = (m) => { const s = (m && m[0] ? m[0] : '').trim(); if (s) lines.push(s); };
    
    // Patterns for week entries and "Until the end of season"
    const reWeek = /((?:\b\d+\s*(?:st|nd|rd|th)?\s*)?\bweek\b[^()]*\(\d{2}\.\d{2}\s*[—-]\s*\d{2}\.\d{2}\))/gi;
    const reUntil = /(Until the end of season[^()]*\(\d{2}\.\d{2}\s*[—-]\s*\d{2}\.\d{2}\))/gi;
    let m;
    
    while ((m = reWeek.exec(metaDescEnStripped))) pushMatch(m);
    while ((m = reUntil.exec(metaDescEnStripped))) pushMatch(m);
    
    // Deduplicate while preserving order
    const seen = new Set();
    const scheduleLines = lines.filter(l => { if (seen.has(l)) return false; seen.add(l); return true; });
    
    console.log(`[SEASON] Candidate lines: ${lines.length}; unique retained: ${scheduleLines.length}`);
    if (!scheduleLines.length) {
      console.warn('[SEASON] No schedule lines matched expected pattern. Aborting schedule init.');
      return;
    }
    console.log(`[SEASON] First lines preview: ${scheduleLines.slice(0, 3).map(s => JSON.stringify(s)).join(' | ')}`);

    // Write sqbbr.txt
    try {
      const outPath = getScheduleFilePath();
      fs.writeFileSync(outPath, scheduleLines.join('\n') + '\n', 'utf8');
      console.log(`[SEASON] Wrote schedule lines to ${outPath}`);
    } catch (e) {
      logError('initSeasonSchedule.writeSchedule', e);
    }

    // Parse into settings.json seasonSchedule
    const year = new Date().getUTCFullYear();
    const settingsPath = getSettingsFilePath();
    let settingsObj = {};
    try {
      if (fs.existsSync(settingsPath)) {
        settingsObj = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
      } else {
        settingsObj = { players: {}, squadrons: {} };
      }
    } catch (e) {
      logError('initSeasonSchedule.readSettings', e);
      settingsObj = { players: {}, squadrons: {} };
    }

    const seasonSchedule = {};
    let idx = 1;
    for (const line of scheduleLines) {
      const entry = parseEntry(line, year);
      if (entry.br && entry.startDate && entry.endDate) {
        seasonSchedule[String(idx)] = {
          startDate: entry.startDate,
          endDate: entry.endDate,
          br: entry.br,
        };
        console.log(`[SEASON] Parsed #${idx}: br=${entry.br} start=${entry.startDate} end=${entry.endDate}`);
        idx++;
      } else {
        if (!(entry.br)) console.warn('[SEASON] Parse failed: BR not found for line:', line);
        if (!(entry.startDate && entry.endDate)) console.warn('[SEASON] Parse failed: dates not found for line:', line);
      }
    }
    if (Object.keys(seasonSchedule).length) {
      settingsObj.seasonSchedule = seasonSchedule;
      try {
        fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2), 'utf8');
        console.log(`[SEASON] Updated seasonSchedule in ${settingsPath}`);
      } catch (e) {
        logError('initSeasonSchedule.writeSettings', e);
      }
    } else {
      console.warn('[SEASON] No valid parsed entries to write to settings.json');
    }
  } catch (e) {
    logError('initSeasonSchedule', e);
  }
}

module.exports = {
  initSeasonSchedule,
  stripHeaderPrefix,
  parseEntry,
};
