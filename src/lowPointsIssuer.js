// src/lowPointsIssuer.js
const fs = require('fs');
const path = require('path');
const { getClient } = require('./discordBot');
const { bestMatchPlayer, toNumber } = require('./nameMatch');

function readSettings() {
  const file = path.join(process.cwd(), 'settings.json');
  try {
    if (!fs.existsSync(file)) return {};
    const obj = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    return obj;
  } catch (_) { return {}; }
}

async function countAssigned(guild) {
  try {
    const cfg = getConfig();
    const role = await resolveRole(guild, cfg.roleId, cfg.roleName);
    if (!role) return 0;
    try { await guild.members.fetch(); } catch (_) {}
    let count = 0;
    for (const [, m] of guild.members.cache) {
      try { if (m.roles?.cache?.has(role.id)) count++; } catch (_) {}
    }
    return count;
  } catch (_) { return 0; }
}

function writeSettings(obj) {
  const file = path.join(process.cwd(), 'settings.json');
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (_) { return false; }
}

function getConfig() {
  const s = readSettings();
  const lp = s.lowPoints || {};
  return {
    enabled: !!lp.enabled,
    threshold: Number.isFinite(lp.threshold) ? lp.threshold : 1300,
    roleId: typeof lp.roleId === 'string' ? lp.roleId : null,
    roleName: typeof lp.roleName === 'string' ? lp.roleName : null,
    debug: !!lp.debug || String(process.env.LOGBOT_DEBUG_LP || '').trim() === '1',
    matchMaxTier: Number.isFinite(lp.matchMaxTier) ? lp.matchMaxTier : 1,
    matchMaxNormD: Number.isFinite(lp.matchMaxNormD) ? lp.matchMaxNormD : 0.35,
    memberRoleId: typeof lp.memberRoleId === 'string' ? lp.memberRoleId : null,
    memberRoleName: typeof lp.memberRoleName === 'string' ? lp.memberRoleName : null,
  };
}

function saveConfig(partial) {
  const s = readSettings();
  if (!s.lowPoints || typeof s.lowPoints !== 'object') s.lowPoints = {};
  s.lowPoints = { ...s.lowPoints, ...partial };
  writeSettings(s);
}

// name matching helpers now provided by ./nameMatch

function readLatestSnapshot() {
  try {
    const file = path.join(process.cwd(), 'squadron_data.json');
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (Array.isArray(obj.squadronSnapshots)) {
      const arr = obj.squadronSnapshots;
      return arr.length ? arr[arr.length - 1] : null;
    }
    return obj && typeof obj === 'object' && Object.keys(obj).length ? obj : null;
  } catch (_) { return null; }
}

function getAllRows() {
  const snap = readLatestSnapshot();
  return snap && snap.data && Array.isArray(snap.data.rows) ? snap.data.rows : [];
}

function getRowsBelowThreshold(threshold) {
  const rows = getAllRows();
  return rows.filter(r => toNumber(r['Personal clan rating'] ?? r.rating) < threshold);
}

async function computeEligibleCount(guild) {
  try {
    const cfg = getConfig();
    const allRows = getAllRows();
    if (!guild) return 0;
    try { await guild.members.fetch(); } catch (_) {}
    // Optional limiter pool
    let baseRole = null;
    if (cfg.memberRoleId || cfg.memberRoleName) {
      try { baseRole = await resolveRole(guild, cfg.memberRoleId, cfg.memberRoleName); } catch (_) {}
    }
    const pool = baseRole ? guild.members.cache.filter(m => m.roles?.cache?.has(baseRole.id)) : guild.members.cache;
    let count = 0;
    for (const [, m] of pool) {
      const display = m.nickname || m.user?.username || '';
      if (!display) continue;
      const bm = bestMatchPlayer(allRows, display);
      if (!bm || !bm.row) continue;
      const qualityOk = (bm.tier == null && bm.normD == null) || ((bm.tier <= cfg.matchMaxTier) && (bm.normD <= cfg.matchMaxNormD));
      if (!qualityOk) continue;
      const rating = toNumber(bm.row['Personal clan rating'] ?? bm.row.rating);
      if (rating < cfg.threshold) count++;
    }
    return count;
  } catch (_) {
    return 0;
  }
}

async function resolveRole(guild, roleId, roleName) {
  try {
    await guild.roles.fetch();
  } catch (_) {}
  if (roleId) {
    try { const r = await guild.roles.fetch(roleId); if (r) return r; } catch (_) {}
  }
  if (roleName) {
    const name = String(roleName).toLowerCase();
    const r = guild.roles.cache.find(x => x && x.name && x.name.toLowerCase() === name);
    if (r) return r;
  }
  return null;
}

async function issueRolesInGuild(guild) {
  const cfg = getConfig();
  const role = await resolveRole(guild, cfg.roleId, cfg.roleName);
  if (!role) return { added: 0, removed: 0, totalCandidates: 0, roleMissing: true };

  // Optional limiter: only consider members who already have this role
  let baseRole = null;
  if (cfg.memberRoleId || cfg.memberRoleName) {
    baseRole = await resolveRole(guild, cfg.memberRoleId, cfg.memberRoleName);
  }

  const allRows = getAllRows();
  const candidates = new Map(); // key: memberId, value: true
  const matchSamples = [];
  try { await guild.members.fetch(); } catch (_) {}

  const totalMembers = guild.members.cache.size;
  let basePool = [];
  if (baseRole) {
    basePool = guild.members.cache.filter(mem => mem.roles?.cache?.has(baseRole.id));
  } else {
    basePool = guild.members.cache;
  }
  const baseCount = baseRole ? basePool.size : totalMembers;
  for (const [, m] of basePool) {
    const display = m.nickname || m.user?.username || '';
    if (!display) continue;
    const bm = bestMatchPlayer(allRows, display);
    let accepted = false;
    if (bm && bm.row) {
      // quality gate
      const qualityOk = (bm.tier == null && bm.normD == null) || ((bm.tier <= cfg.matchMaxTier) && (bm.normD <= cfg.matchMaxNormD));
      // threshold gate
      const rating = toNumber(bm.row['Personal clan rating'] ?? bm.row.rating);
      const below = rating < cfg.threshold;
      accepted = qualityOk && below;
      if (accepted) {
        candidates.set(m.id, true);
      }
      if (cfg.debug && matchSamples.length < 10) {
        matchSamples.push(`[MATCH ${accepted ? 'ACCEPT' : 'REJECT'}] member="${display}" -> player="${bm.row.Player || bm.row.player}" rating=${rating} ${below ? '(< thr)' : '(>= thr)'} tier=${bm.tier ?? '?'} normD=${(bm.normD ?? 0).toFixed(3)}`);
      }
    } else if (cfg.debug && matchSamples.length < 10) {
      matchSamples.push(`[NO-MATCH] member="${display}"`);
    }
  }

  console.log(`[LowPoints] Guild="${guild.name}" role="${role.name}" threshold=${cfg.threshold} snapshotRows=${allRows.length} members=${totalMembers} basePool=${baseCount}${baseRole ? ` baseRole="${baseRole.name}"` : ''} matched=${candidates.size} maxTier=${cfg.matchMaxTier} maxNormD=${cfg.matchMaxNormD}`);
  if (cfg.debug && matchSamples.length) {
    for (const line of matchSamples) console.log(`[LowPoints] ${line}`);
  }

  let added = 0;
  let removed = 0;
  // Add role to all candidates missing it
  for (const [memberId] of candidates) {
    try {
      const m = guild.members.cache.get(memberId) || await guild.members.fetch(memberId);
      if (!m) continue;
      if (!m.roles.cache.has(role.id)) {
        await m.roles.add(role, `Below low-points threshold ${cfg.threshold}`);
        added++;
      }
    } catch (_) {}
  }
  // Remove role from members who are not candidates anymore
  for (const [, m] of guild.members.cache) {
    try {
      if (m.roles.cache.has(role.id) && !candidates.has(m.id)) {
        await m.roles.remove(role, `No longer below threshold ${cfg.threshold}`);
        removed++;
      }
    } catch (_) {}
  }
  console.log(`[LowPoints] Guild="${guild.name}" sync-complete added=${added} removed=${removed}`);
  return { added, removed, totalCandidates: candidates.size, roleMissing: false };
}

async function removeRoleInGuild(guild) {
  const cfg = getConfig();
  const role = await resolveRole(guild, cfg.roleId, cfg.roleName);
  if (!role) return { removed: 0, roleMissing: true };
  try { await guild.members.fetch(); } catch (_) {}
  let removed = 0;
  for (const [, m] of guild.members.cache) {
    try {
      if (m.roles.cache.has(role.id)) {
        await m.roles.remove(role, 'Low-points role removal');
        removed++;
      }
    } catch (_) {}
  }
  return { removed, roleMissing: false };
}

async function autoIssueAfterSnapshot() {
  try {
    const cfg = getConfig();
    if (!cfg.enabled) return;
    const client = getClient && getClient();
    if (!client || !client.guilds || !client.guilds.cache) return;
    for (const [, guild] of client.guilds.cache) {
      if (cfg.debug) console.log(`[LowPoints] Auto-issue after snapshot for guild="${guild.name}"`);
      try { await issueRolesInGuild(guild); } catch (_) {}
    }
  } catch (_) {}
}

module.exports = {
  getConfig,
  saveConfig,
  getRowsBelowThreshold,
  computeEligibleCount,
  countAssigned,
  issueRolesInGuild,
  removeRoleInGuild,
  autoIssueAfterSnapshot,
};
