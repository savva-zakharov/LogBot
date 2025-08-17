// src/lowPointsIssuer.js
const fs = require('fs');
const path = require('path');
const { getClient, sendMessage } = require('./discordBot');
const { bestMatchPlayer, toNumber } = require('./nameMatch');

function readSettings() {
  const file = path.join(process.cwd(), 'settings.json');
  try {
    if (!fs.existsSync(file)) return {};
    const obj = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    return obj;
  } catch (_) { return {}; }
}

// Build a detailed listing of matched members in Discord that are below threshold,
// splitting into included (would be candidates) and excluded with reasons.
async function listBelowDetails(guild) {
  const cfg = getConfig();
  const allRows = getAllRows();
  const result = { included: [], excluded: [] };
  try { await guild.members.fetch(); } catch (_) {}
  // Optional limiter
  let baseRole = null;
  if (cfg.memberRoleId || cfg.memberRoleName) {
    try { baseRole = await resolveRole(guild, cfg.memberRoleId, cfg.memberRoleName); } catch (_) {}
  }
  const pool = baseRole ? guild.members.cache.filter(m => m.roles?.cache?.has(baseRole.id)) : guild.members.cache;
  // Excluded role IDs and name map
  let excludedRoleIds = new Set();
  const roleNames = new Map();
  try {
    await guild.roles.fetch();
    guild.roles.cache.forEach(r => { if (r?.id) roleNames.set(r.id, r.name || r.id); });
    const byName = new Map();
    guild.roles.cache.forEach(r => { if (r?.name) byName.set(r.name.toLowerCase(), r.id); });
    excludedRoleIds = new Set(
      (cfg.excludeRoles || []).map(v => {
        const s = String(v).trim();
        if (/^\d{10,}$/.test(s)) return s;
        const id = byName.get(s.toLowerCase());
        return id || null;
      }).filter(Boolean)
    );
  } catch (_) {}

  for (const [, m] of pool) {
    const display = m.nickname || m.user?.username || '';
    if (!display) continue;
    const bm = bestMatchPlayer(allRows, display);
    if (!bm || !bm.row) continue;
    const qualityOk = (bm.tier == null && bm.normD == null) || ((bm.tier <= cfg.matchMaxTier) && (bm.normD <= cfg.matchMaxNormD));
    if (!qualityOk) continue;
    const rating = toNumber(bm.row['Personal clan rating'] ?? bm.row.rating);
    if (!(rating < cfg.threshold)) continue;
    // Evaluate reasons
    let withinGrace = false;
    try {
      const dojStr = bm.row['Date of entry'] || bm.row['date of entry'] || bm.row['Date'] || '';
      const doj = parseDateOfEntry(dojStr);
      const days = daysSince(doj);
      withinGrace = (days != null) && (days < cfg.graceDays);
    } catch (_) { withinGrace = false; }
    let excludedByRole = false;
    let matchedExcludedRoles = [];
    try {
      if (m.roles?.cache && excludedRoleIds.size) {
        for (const [rid] of m.roles.cache) {
          if (excludedRoleIds.has(rid)) { excludedByRole = true; matchedExcludedRoles.push(roleNames.get(rid) || rid); }
        }
      }
    } catch (_) { excludedByRole = false; }

    const entry = {
      memberId: m.id,
      display,
      player: String(bm.row.Player || bm.row.player || ''),
      rating,
      reasons: [],
    };
    if (withinGrace) entry.reasons.push('grace');
    if (excludedByRole) entry.reasons.push(`excludedRole:${matchedExcludedRoles.join('|')}`);
    if (entry.reasons.length) result.excluded.push(entry);
    else result.included.push(entry);
  }
  // Sort for readability
  result.included.sort((a, b) => a.rating - b.rating);
  result.excluded.sort((a, b) => a.rating - b.rating);
  return result;
}

// Helpers for join-date grace period
function parseDateOfEntry(s) {
  try {
    const str = String(s || '').trim();
    const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) return null;
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const y = parseInt(m[3], 10);
    if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12)) return null;
    return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0));
  } catch (_) { return null; }
}

function daysSince(dateUtc) {
  try {
    if (!(dateUtc instanceof Date) || isNaN(dateUtc.getTime())) return null;
    const now = new Date();
    const ms = now.getTime() - dateUtc.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  } catch (_) { return null; }
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
  // Normalize excludeRoles: accept IDs or names as strings; merge from possible legacy arrays
  const excludeRolesRaw = [];
  if (Array.isArray(lp.excludeRoles)) excludeRolesRaw.push(...lp.excludeRoles);
  if (Array.isArray(lp.excludeRoleIds)) excludeRolesRaw.push(...lp.excludeRoleIds);
  if (Array.isArray(lp.excludeRoleNames)) excludeRolesRaw.push(...lp.excludeRoleNames);
  const excludeRoles = excludeRolesRaw
    .map(v => (v == null ? null : String(v).trim()))
    .filter(v => !!v);
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
    logChannelId: typeof lp.logChannelId === 'string' ? lp.logChannelId : null,
    // Support both spellings: gracePeroid (as requested) and gracePeriod
    graceDays: Number.isFinite(lp.gracePeroid) ? lp.gracePeroid : (Number.isFinite(lp.gracePeriod) ? lp.gracePeriod : 30),
    excludeRoles,
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
    // Build excluded role ID set
    let excludedRoleIds = new Set();
    try {
      await guild.roles.fetch();
      const byName = new Map();
      guild.roles.cache.forEach(r => { if (r?.name) byName.set(r.name.toLowerCase(), r.id); });
      excludedRoleIds = new Set(
        (cfg.excludeRoles || []).map(v => {
          const s = String(v).trim();
          if (/^\d{10,}$/.test(s)) return s; // looks like ID
          const id = byName.get(s.toLowerCase());
          return id || null;
        }).filter(Boolean)
      );
    } catch (_) {}
    // Optional limiter pool
    let baseRole = null;
    if (cfg.memberRoleId || cfg.memberRoleName) {
      try { baseRole = await resolveRole(guild, cfg.memberRoleId, cfg.memberRoleName); } catch (_) {}
    }
    const pool = baseRole ? guild.members.cache.filter(m => m.roles?.cache?.has(baseRole.id)) : guild.members.cache;
    let count = 0;
    for (const [, m] of pool) {
      // Skip excluded members
      try {
        if (m.roles?.cache && excludedRoleIds.size) {
          let skip = false;
          for (const [rid] of m.roles.cache) { if (excludedRoleIds.has(rid)) { skip = true; break; } }
          if (skip) continue;
        }
      } catch (_) {}
      const display = m.nickname || m.user?.username || '';
      if (!display) continue;
      const bm = bestMatchPlayer(allRows, display);
      if (!bm || !bm.row) continue;
      const qualityOk = (bm.tier == null && bm.normD == null) || ((bm.tier <= cfg.matchMaxTier) && (bm.normD <= cfg.matchMaxNormD));
      if (!qualityOk) continue;
      const rating = toNumber(bm.row['Personal clan rating'] ?? bm.row.rating);
      if (rating >= cfg.threshold) continue;
      // Grace period check based on join date in snapshot
      const dojStr = bm.row['Date of entry'] || bm.row['date of entry'] || bm.row['Date'] || '';
      const doj = parseDateOfEntry(dojStr);
      const days = daysSince(doj);
      if (days != null && days < cfg.graceDays) continue; // skip if within grace period
      count++;
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

async function issueRolesInGuild(guild, options = {}) {
  const cfg = getConfig();
  const role = await resolveRole(guild, cfg.roleId, cfg.roleName);
  if (!role) return { added: 0, removed: 0, totalCandidates: 0, roleMissing: true };

  // Optional limiter: only consider members who already have this role
  let baseRole = null;
  if (cfg.memberRoleId || cfg.memberRoleName) {
    baseRole = await resolveRole(guild, cfg.memberRoleId, cfg.memberRoleName);
  }

  const allRows = getAllRows();
  const candidates = new Map(); // key: memberId, value: { display, player }
  const matchSamples = [];
  try { await guild.members.fetch(); } catch (_) {}
  // Build excluded role ID set
  let excludedRoleIds = new Set();
  try {
    await guild.roles.fetch();
    const byName = new Map();
    guild.roles.cache.forEach(r => { if (r?.name) byName.set(r.name.toLowerCase(), r.id); });
    excludedRoleIds = new Set(
      (cfg.excludeRoles || []).map(v => {
        const s = String(v).trim();
        if (/^\d{10,}$/.test(s)) return s;
        const id = byName.get(s.toLowerCase());
        return id || null;
      }).filter(Boolean)
    );
  } catch (_) {}

  const totalMembers = guild.members.cache.size;
  let basePool = [];
  if (baseRole) {
    basePool = guild.members.cache.filter(mem => mem.roles?.cache?.has(baseRole.id));
  } else {
    basePool = guild.members.cache;
  }
  const baseCount = baseRole ? basePool.size : totalMembers;
  for (const [, m] of basePool) {
    // Skip excluded members
    try {
      if (m.roles?.cache && excludedRoleIds.size) {
        let skip = false;
        for (const [rid] of m.roles.cache) { if (excludedRoleIds.has(rid)) { skip = true; break; } }
        if (skip) continue;
      }
    } catch (_) {}
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
      // grace period gate
      let withinGrace = false;
      try {
        const dojStr = bm.row['Date of entry'] || bm.row['date of entry'] || bm.row['Date'] || '';
        const doj = parseDateOfEntry(dojStr);
        const days = daysSince(doj);
        withinGrace = (days != null) && (days < cfg.graceDays);
      } catch (_) { withinGrace = false; }
      accepted = qualityOk && below && !withinGrace;
      if (accepted) {
        const playerName = bm.row.Player || bm.row.player || null;
        candidates.set(m.id, { display, player: playerName });
      }
      if (cfg.debug && matchSamples.length < 10) {
        matchSamples.push(`[MATCH ${accepted ? 'ACCEPT' : 'REJECT'}] member="${display}" -> player="${bm.row.Player || bm.row.player}" rating=${rating} ${below ? '(< thr)' : '(>= thr)'} tier=${bm.tier ?? '?'} normD=${(bm.normD ?? 0).toFixed(3)} graceDays=${cfg.graceDays}`);
      }
    } else if (cfg.debug && matchSamples.length < 10) {
      matchSamples.push(`[NO-MATCH] member="${display}"`);
    }
  }

  console.log(`[LowPoints] Guild="${guild.name}" role="${role.name}" threshold=${cfg.threshold} snapshotRows=${allRows.length} members=${totalMembers} basePool=${baseCount}${baseRole ? ` baseRole="${baseRole.name}"` : ''} matched=${candidates.size} maxTier=${cfg.matchMaxTier} maxNormD=${cfg.matchMaxNormD} graceDays=${cfg.graceDays}`);
  if (cfg.debug && matchSamples.length) {
    for (const line of matchSamples) console.log(`[LowPoints] ${line}`);
  }

  let added = 0;
  let removed = 0;
  const addedMembers = [];
  const removedMembers = [];
  // Add role to all candidates missing it
  for (const [memberId, info] of candidates) {
    try {
      const m = guild.members.cache.get(memberId) || await guild.members.fetch(memberId);
      if (!m) continue;
      if (!m.roles.cache.has(role.id)) {
        await m.roles.add(role, `Below low-points threshold ${cfg.threshold}`);
        added++;
        const disp = (info && info.display) || m.nickname || m.user?.username || (m.user ? `${m.user.username}#${m.user.discriminator}` : String(memberId));
        const pl = info && info.player ? String(info.player) : '';
        addedMembers.push(pl ? `${disp} -> ${pl}` : disp);
      }
    } catch (_) {}
  }
  // Remove role from members who are not candidates anymore
  for (const [, m] of guild.members.cache) {
    try {
      // Skip excluded members entirely (do not add or remove roles)
      let isExcluded = false;
      try {
        if (m.roles?.cache && excludedRoleIds.size) {
          for (const [rid] of m.roles.cache) { if (excludedRoleIds.has(rid)) { isExcluded = true; break; } }
        }
      } catch (_) { isExcluded = false; }
      if (isExcluded) continue;
      if (m.roles.cache.has(role.id) && !candidates.has(m.id)) {
        await m.roles.remove(role, `No longer below threshold ${cfg.threshold}`);
        removed++;
        const disp = m.nickname || m.user?.username || (m.user ? `${m.user.username}#${m.user.discriminator}` : String(m.id));
        // try to resolve matched player name for clarity
        let pl = '';
        try {
          const bm2 = bestMatchPlayer(allRows, disp);
          if (bm2 && bm2.row) pl = String(bm2.row.Player || bm2.row.player || '');
        } catch (_) {}
        removedMembers.push(pl ? `${disp} -> ${pl}` : disp);
      }
    } catch (_) {}
  }
  console.log(`[LowPoints] Guild="${guild.name}" sync-complete added=${added} removed=${removed}`);
  if (added || removed) {
    const fmtList = (arr) => {
      if (!arr.length) return '(none)';
      const maxShow = 25;
      const shown = arr.slice(0, maxShow);
      const suffix = arr.length > maxShow ? ` ... (+${arr.length - maxShow} more)` : '';
      return shown.join(', ') + suffix;
    };
    const lines = [];
    lines.push(`LowPoints sync for guild "${guild.name}"`);
    lines.push(`Role: ${role.name}`);
    lines.push(`Threshold: ${cfg.threshold}`);
    lines.push(`Eligible matched: ${candidates.size}`);
    lines.push(`Added (${added}): ${fmtList(addedMembers)}`);
    lines.push(`Removed (${removed}): ${fmtList(removedMembers)}`);
    await sendMessage(lines.join('\n'));
  }
  return { added, removed, totalCandidates: candidates.size, roleMissing: false };
}

async function removeRoleInGuild(guild, options = {}) {
  const cfg = getConfig();
  const role = await resolveRole(guild, cfg.roleId, cfg.roleName);
  if (!role) return { removed: 0, roleMissing: true };
  try { await guild.members.fetch(); } catch (_) {}
  let removed = 0;
  const removedMembers = [];
  const allRows = getAllRows();
  for (const [, m] of guild.members.cache) {
    try {
      if (m.roles.cache.has(role.id)) {
        await m.roles.remove(role, 'Low-points role removal');
        removed++;
        const disp = m.nickname || m.user?.username || (m.user ? `${m.user.username}#${m.user.discriminator}` : String(m.id));
        let pl = '';
        try {
          const bm2 = bestMatchPlayer(allRows, disp);
          if (bm2 && bm2.row) pl = String(bm2.row.Player || bm2.row.player || '');
        } catch (_) {}
        removedMembers.push(pl ? `${disp} -> ${pl}` : disp);
      }
    } catch (_) {}
  }
  if (removed) {
    const fmtList = (arr) => arr.length ? arr.slice(0, 40).join(', ') + (arr.length > 40 ? ` ... (+${arr.length - 40} more)` : '') : '(none)';
    const lines = [];
    lines.push(`LowPoints role cleared for guild "${guild.name}"`);
    lines.push(`Role: ${role.name}`);
    lines.push(`Removed (${removed}): ${fmtList(removedMembers)}`);
    await sendMessage(lines.join('\n'));
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
  listBelowDetails,
  issueRolesInGuild,
  removeRoleInGuild,
  autoIssueAfterSnapshot,
};
