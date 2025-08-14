// src/scraper.js
const { loadSettings } = require('./config');
const { parseLogLine } = require('./parser');
const { processMissionEnd } = require('./missionEnd');
const server = require('./server');
const state = require('./state');

async function startScraper(callbacks) {
  const { onNewLine, onGameIncrement, onEntry, onStatusChange } = callbacks;
  const { telemetryUrl } = loadSettings();

  // HTTP polling mode; default to localhost HUD endpoint if needed
  const useHttpHud = true;
  const hudUrl = (typeof telemetryUrl === 'string' && /\/hudmsg\b/.test(telemetryUrl))
    ? telemetryUrl
    : 'http://localhost:8111/hudmsg';

  if (useHttpHud) {
    console.log(`✅ Using HTTP polling mode for telemetry: ${hudUrl}`);
    const seenIds = new Set();
    let lastDamageTime = null; // seconds
    let timer = null;
    let backoffMs = 1000;
    // Resume from persisted cursors if available
    let { lastEvtId, lastDmgId } = state.getTelemetryCursors();
    // Mission polling state
    const missionUrl = (() => { try { const u = new URL(hudUrl); return `${u.origin}/mission.json`; } catch { return 'http://localhost:8111/mission.json'; } })();
    let lastMissionOutcome = null; // 'success' | 'fail' | null

    const tick = async () => {
      try {
        const url = new URL(hudUrl);
        url.searchParams.set('lastEvt', String(lastEvtId));
        url.searchParams.set('lastDmg', String(lastDmgId));
        const res = await fetch(url.toString(), {
          headers: {
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.5',
            'x-requested-with': 'XMLHttpRequest',
            'referer': 'http://localhost:8111/'
          }
        });
        if (res.status === 400) {
          // Server rejected params; reset cursors and retry next tick
          lastEvtId = 0; lastDmgId = 0;
          throw new Error('HTTP 400');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json().catch(() => ({}));
        const damage = Array.isArray(data.damage) ? data.damage : [];
        const events = Array.isArray(data.events) ? data.events : [];

        // advance cursors
        let maxEvtId = lastEvtId;
        for (const e of events) {
          const eid = typeof e.id === 'number' ? e.id : null;
          if (eid != null && eid > maxEvtId) maxEvtId = eid;
        }
        let maxDmgId = lastDmgId;
        for (const d of damage) {
          const id = d.id ?? `${d.msg}|${d.time}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          // cap size
          if (seenIds.size > 2000) {
            // naive prune: clear and re-seed last 200 by iterating tail
            const last200 = damage.slice(-200);
            seenIds.clear();
            for (const x of last200) seenIds.add(x.id ?? `${x.msg}|${x.time}`);
          }

          // Game increment heuristic: time reset backwards by >= 60s
          const t = Number.isFinite(d.time) ? d.time : null;
          if (t != null && lastDamageTime != null && t < lastDamageTime && (lastDamageTime - t) >= 60) {
            if (typeof onGameIncrement === 'function') onGameIncrement();
          }
          if (t != null) lastDamageTime = t;

          const line = String(d.msg ?? '').trim();
          if (line) {
            if (typeof onNewLine === 'function') onNewLine(line);
            const parsedEntries = parseLogLine(line);
            parsedEntries.forEach(entry => {
              if (typeof onEntry === 'function') onEntry({ ...entry, status: 'active' });
              if (entry.status === 'destroyed' && typeof onStatusChange === 'function') {
                onStatusChange({ ...entry, status: 'destroyed' });
              }
            });
          }
          const did = typeof d.id === 'number' ? d.id : null;
          if (did != null && did > maxDmgId) maxDmgId = did;
        }
        lastEvtId = maxEvtId;
        lastDmgId = maxDmgId;
        // Persist updated cursors so we can resume after restart
        try { state.setTelemetryCursors({ lastEvtId, lastDmgId }); } catch (_) {}

        // success: reset backoff if it had grown
        backoffMs = 1000;
        
        // Also check mission status to detect victory/loss
        try {
          const mres = await fetch(missionUrl, {
            headers: {
              'accept': 'application/json, text/plain, */*',
              'referer': 'http://localhost:8111/'
            }
          });
          if (mres.ok) {
            const mjson = await mres.json().catch(() => ({}));
            const mstatus = mjson?.status; // e.g., 'running' while in progress
            // Normalize objectives: can be array, object map, or null
            let objectivesRaw = mjson?.objectives;
            let objectives = null;
            if (Array.isArray(objectivesRaw)) objectives = objectivesRaw;
            else if (objectivesRaw && typeof objectivesRaw === 'object') objectives = Object.values(objectivesRaw);
            let outcome = null;
            if (objectives && objectives.length) {
              const isPrimary = (o) => {
                const p = o && (o.primary ?? o.Primary);
                return p === true || p === 'true' || p === 1 || p === '1';
              };
              const getStatus = (o) => String((o && (o.status ?? o.Status)) || '').toLowerCase();
              const primaries = objectives.filter(o => isPrimary(o));
              const candidates = primaries.length ? primaries : objectives;
              // Prefer explicit fail over success
              if (candidates.some(o => getStatus(o) === 'fail' || getStatus(o) === 'failed')) outcome = 'fail';
              else if (candidates.some(o => getStatus(o) === 'success' || getStatus(o) === 'succeeded')) outcome = 'success';
            }
            if (outcome && outcome !== lastMissionOutcome) {
              // Centralized mission processing (independent of HTTP server route)
              const type = outcome === 'success' ? 'win' : 'loss';
              try {
                const payload = processMissionEnd(type, 'current');
                // Broadcast to WS clients if server is running
                try { server.broadcast({ type: 'update', message: `Result recorded for game ${payload.game}`, data: { result: payload.type, game: payload.game } }); } catch (_) {}
              } catch (_) {
                // Fallback: at least emit local callbacks
                const line = outcome === 'success' ? '[Mission] Victory' : '[Mission] Defeat';
                if (typeof onNewLine === 'function') onNewLine(line);
                if (typeof onEntry === 'function') onEntry({ type: 'mission_result', result: outcome, status: 'final' });
              }
              lastMissionOutcome = outcome;
            }
            // Reset outcome marker when mission is running again
            if (mstatus === 'running' && lastMissionOutcome) {
              lastMissionOutcome = null;
            }
          }
        } catch (_) { /* ignore mission fetch errors */ }
      } catch (err) {
        // transient failure: back off a bit, but keep polling
        backoffMs = Math.min(backoffMs * 2, 15000);
        console.error(`⚠️ Telemetry poll failed: ${err?.message || err}. Retrying in ${backoffMs}ms`);
        clearInterval(timer);
        timer = setInterval(tick, backoffMs);
      }
    };

    // start polling
    await tick();
    timer = setInterval(tick, 1000);

    // Return a close-compatible object
    return {
      close: async () => { if (timer) clearInterval(timer); }
    };
  }
  // Unreachable branch retained during transition previously has been removed with Puppeteer
}

module.exports = { startScraper };
