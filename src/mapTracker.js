// src/mapTracker.js
// Periodically polls War Thunder telemetry (/map_info.json and /map_obj.json) and
// maintains per-game object tracks server-side. Tracks are persisted via state.setMapTracks
// and served to clients through the existing /api/map-tracks endpoint.

const http = require('http');
const state = require('./state');

// Correlation params (normalized coordinates [0..1])
const TRACK_MAX_POINTS = 2000;
const MATCH_MAX_DIST = 0.02; // ~3.5% of map diagonal in normalized space
const MOVEMENT_EPS = 0.001;  // ignore tiny jitter

let timer = null;

// In-memory tracking state per game
const gameTrackState = new Map();
// Structure per gameId: { tracks: Map<string,{points:[{x,y,t}], color, meta, lastSeen }>, nextTrackId: number, lastGen: number|null }

function metaKey(o) {
  return `${o.icon||''}|${o.type||''}|${o.team||''}`;
}

function normalizeXY(o, mapInfo){
  // returns {x,y} normalized [0,1] top-left origin or null
  if (!mapInfo) return null;
  const ox = (typeof o.x === 'number') ? o.x : (o.pos && o.pos.x);
  const oy = (typeof o.y === 'number') ? o.y : (o.pos && o.pos.y);
  if (typeof ox === 'number' && typeof oy === 'number') {
    const px = (ox - mapInfo.minX) / (mapInfo.maxX - mapInfo.minX);
    const py = 1 - (oy - mapInfo.minY) / (mapInfo.maxY - mapInfo.minY);
    return { x: px, y: py };
  }
  return null;
}

function correlatorForGame(gameId){
  if (!gameTrackState.has(gameId)) {
    gameTrackState.set(gameId, { tracks: new Map(), nextTrackId: 1, lastGen: null });
  }
  return gameTrackState.get(gameId);
}

function correlateTracks(gameId, mapInfo, objs) {
  const g = correlatorForGame(gameId);
  const { tracks } = g;
  const now = Date.now();
  const cand = [];
  for (const o of objs) {
    const p = normalizeXY(o, mapInfo);
    if (!p) continue;
    const item = { ...o };
    item._nx = p.x; item._ny = p.y; item._meta = metaKey(o);
    cand.push(item);
  }
  const trackIds = Array.from(tracks.keys());
  const trackFree = new Set(trackIds);
  const objFree = new Set(cand.map((_, i) => i));
  const pairs = [];
  for (let ti=0; ti<trackIds.length; ti++) {
    const tid = trackIds[ti];
    const tr = tracks.get(tid);
    if (!tr || !tr.points.length) continue;
    const last = tr.points[tr.points.length - 1];
    for (let i=0; i<cand.length; i++) {
      const o = cand[i];
      if (o._meta !== tr.meta) continue;
      const d = Math.hypot(o._nx - last.x, o._ny - last.y);
      if (d <= MATCH_MAX_DIST) pairs.push({ tid, i, d });
    }
  }
  pairs.sort((a,b)=>a.d-b.d);
  for (const {tid,i} of pairs) {
    if (!trackFree.has(tid) || !objFree.has(i)) continue;
    const tr = tracks.get(tid);
    const o = cand[i];
    const last = tr.points[tr.points.length - 1];
    const d = Math.hypot(o._nx - last.x, o._ny - last.y);
    if (d > MOVEMENT_EPS) {
      tr.points.push({ x: o._nx, y: o._ny, t: Date.now() });
      if (tr.points.length > TRACK_MAX_POINTS) tr.points.splice(0, tr.points.length - TRACK_MAX_POINTS);
    }
    if (tr.points.length > TRACK_MAX_POINTS) tr.points.splice(0, tr.points.length - TRACK_MAX_POINTS);
    tr.lastSeen = now;
    o._tid = tid;
    trackFree.delete(tid);
    objFree.delete(i);
  }
  for (const i of objFree) {
    const o = cand[i];
    const tid = String(g.nextTrackId++);
    const color = (typeof o.color === 'string') ? o.color : '#59a3ff';
    tracks.set(tid, { points: [{ x: o._nx, y: o._ny, t: Date.now() }], color, meta: o._meta, lastSeen: now });
    o._tid = tid;
  }
}

function serializeTracks(tracks){
  const out = [];
  tracks.forEach((tr, tid) => {
    if (!tr || !Array.isArray(tr.points) || tr.points.length === 0) return;
    out.push({ id: String(tid), meta: tr.meta || '', color: tr.color || '#59a3ff', points: tr.points.map(p => ({ x: +p.x, y: +p.y, t: Number.isFinite(p.t) ? +p.t : undefined })) });
  });
  return out;
}

function httpGetJson(hostname, port, path){
  return new Promise((resolve) => {
    const req = http.request({ hostname, port, path, method: 'GET', timeout: 2000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const txt = Buffer.concat(chunks).toString('utf8');
          const j = JSON.parse(txt || '{}');
          resolve(j);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.end();
  });
}

async function tick(){
  const gameId = String(state.getCurrentGame());
  // fetch map info
  const info = await httpGetJson('localhost', 8111, '/map_info.json');
  if (!info) return;
  // normalize info
  const mapInfo = {};
  if ('map_min_x' in info) mapInfo.minX = info.map_min_x;
  if ('map_max_x' in info) mapInfo.maxX = info.map_max_x;
  if ('map_min_y' in info) mapInfo.minY = info.map_min_y;
  if ('map_max_y' in info) mapInfo.maxY = info.map_max_y;
  if (Array.isArray(info.map_min) && info.map_min.length >= 2) { mapInfo.minX = info.map_min[0]; mapInfo.minY = info.map_min[1]; }
  if (Array.isArray(info.map_max) && info.map_max.length >= 2) { mapInfo.maxX = info.map_max[0]; mapInfo.maxY = info.map_max[1]; }
  const gen = (typeof info.map_generation === 'number') ? info.map_generation : null;
  if (![mapInfo.minX, mapInfo.maxX, mapInfo.minY, mapInfo.maxY].every(v => typeof v === 'number')) return;

  // Reset tracks on generation change
  const g = correlatorForGame(gameId);
  if (g.lastGen !== gen && gen != null) {
    g.tracks.clear();
    g.nextTrackId = 1;
    g.lastGen = gen;
    // also clear persisted tracks for this game
    try { state.setMapTracks(gameId, []); } catch (_) {}
  }

  // fetch objects
  const objPayload = await httpGetJson('localhost', 8111, '/map_obj.json');
  const objs = Array.isArray(objPayload) ? objPayload : (Array.isArray(objPayload?.objects) ? objPayload.objects : []);
  const validObjs = objs.filter(o => o && typeof o === 'object');

  if (validObjs.length) {
    correlateTracks(gameId, mapInfo, validObjs);
    try { state.setMapTracks(gameId, serializeTracks(g.tracks)); } catch (_) {}
  }
}

function startMapTracker(intervalMs = 1000){
  if (timer) return;
  timer = setInterval(() => { tick().catch(()=>{}); }, intervalMs);
  console.log('🗺️  MapTracker started (server-side tracking).');
}

function stopMapTracker(){
  if (timer) { clearInterval(timer); timer = null; }
  console.log('🛑 MapTracker stopped.');
}

module.exports = { startMapTracker, stopMapTracker };
