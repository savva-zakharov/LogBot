// src/waitingTracker.js
// Tracks how long members have been in specified voice channels or groups of channels.
const fs = require('fs');
const path = require('path');
const { fuseMatch } = require('./nameMatch');
const { stripBrackets } = require('./utils/nameSanitizer');

let clientRef = null;
let targetMasks = []; // Array of strings (IDs, names, or wildcards like "SQB*")
const waiting = new Map(); // userId -> { joinedAt: number (ms), trackName: string, channelId: string }
let options = {
  // Whether to track bot accounts
  trackBots: false,
  // Function(member) => boolean; if true, member is exempt
  exemptMembers: () => false,
  // Function(channel) => boolean; if true, channel is exempt
  exemptChannels: () => false,
  // Enable verbose logging for troubleshooting
  debug: true,
};

function matchesMask(channel, mask) {
  if (!channel || !mask) return false;
  const maskStr = String(mask).trim();
  const chId = String(channel.id);
  const chName = String(channel.name);

  // Check ID
  if (chId === maskStr) return true;
  // Check exact name (case-insensitive)
  if (chName.toLowerCase() === maskStr.toLowerCase()) return true;

  // Check wildcard (e.g., "SQB*")
  if (maskStr.includes('*')) {
    try {
      // Escape regex special chars except *
      const pattern = maskStr
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      const regex = new RegExp(`^${pattern}$`, 'i');
      return regex.test(chName);
    } catch (e) {
      return false;
    }
  }
  return false;
}

function getTrackForChannel(channel) {
  if (!channel) return null;
  for (const mask of targetMasks) {
    if (matchesMask(channel, mask)) return mask;
  }
  return null;
}

function isSessionActive() {
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  // US window: 02:00–10:00 UTC (120 to 600 mins)
  // EU window: 14:00–22:00 UTC (840 to 1320 mins)
  return (mins >= 120 && mins < 600) || (mins >= 840 && mins < 1320);
}

function finalizeAll() {
  const now = Date.now();
  if (options.debug) console.log(`[WaitingTracker] Finalizing all ${waiting.size} active tracks.`);
  for (const [userId, rec] of waiting.entries()) {
    try {
      const seconds = Math.max(0, Math.floor((now - rec.joinedAt) / 1000));
      if (seconds > 0) {
        // We need to resolve the member to record time
        const guild = clientRef.guilds.cache.get(rec.guildId) || clientRef.guilds.cache.first();
        if (guild) {
          const member = guild.members.cache.get(userId);
          if (member) {
            recordTime(member, seconds, rec.trackName);
          }
        }
      }
    } catch (e) {
      if (options.debug) console.error(`[WaitingTracker] Error finalizing for user ${userId}:`, e);
    }
  }
  waiting.clear();
}

function seed() {
  if (!clientRef) return;
  try {
    if (!isSessionActive()) {
      if (options.debug) console.log('ℹ️ WaitingTracker: session not active; skipping seed.');
      return;
    }
    let added = 0;
    const guilds = clientRef.guilds.cache;
    for (const [, guild] of guilds) {
      try {
        const channels = guild.channels.cache.filter(c => (c.type === 2 || c.type === 13)); // GuildVoice or GuildStageVoice
        for (const [, ch] of channels) {
          const trackName = getTrackForChannel(ch);
          if (!trackName) continue;

          for (const [, gm] of ch.members) {
            try {
              if (!options.trackBots && gm.user?.bot) continue;
              if (typeof options.exemptMembers === 'function' && options.exemptMembers(gm)) continue;
              if (!waiting.has(gm.id)) {
                waiting.set(gm.id, { joinedAt: Date.now(), trackName: trackName, channelId: ch.id, guildId: guild.id });
                added++;
              }
            } catch (_) { }
          }
        }
      } catch (_) { }
    }
    if (options.debug || added) console.log(`ℹ️ WaitingTracker: seeded ${added} member(s) currently in tracked channels.`);
  } catch (_) { }
}

function init(client, masks, opts = {}) {
  clientRef = client;
  targetMasks = Array.isArray(masks) ? masks : (masks ? [String(masks)] : []);
  options = { ...options, ...(opts || {}) };

  if (!clientRef) throw new Error('waitingTracker.init requires a Discord client');
  if (targetMasks.length === 0) {
    console.log('ℹ️ WaitingTracker: no target voice channels configured; tracker disabled.');
    return { enabled: false };
  }

  clientRef.on('voiceStateUpdate', (oldState, newState) => {
    try {
      const userId = newState?.id || oldState?.id;
      if (!userId) return;

      const oldCh = oldState?.channel;
      const newCh = newState?.channel;

      const oldTrack = getTrackForChannel(oldCh);
      const newTrack = getTrackForChannel(newCh);

      // If user moved within the same track (or stayed outside), do nothing
      if (oldTrack === newTrack) {
        // Update channelId in record if still in same track
        if (newTrack && waiting.has(userId)) {
          const rec = waiting.get(userId);
          rec.channelId = newCh?.id || rec.channelId;
        }
        return;
      }

      const now = Date.now();
      const member = newState?.member || oldState?.member || null;

      // Finalize old track
      if (oldTrack) {
        const rec = waiting.get(userId);
        if (rec && rec.trackName === oldTrack) {
          const seconds = Math.max(0, Math.floor((now - rec.joinedAt) / 1000));
          if (options.debug) console.log(`[WaitingTracker] leave ${oldTrack}: ${userId} after ${seconds}s`);
          recordTime(member, seconds, oldTrack);
          waiting.delete(userId);
        }
      }

      // Start new track - ONLY if session is active
      if (newTrack && isSessionActive()) {
        // Exempt checks
        if (member) {
          if (!options.trackBots && member.user?.bot) return;
          try { if (typeof options.exemptMembers === 'function' && options.exemptMembers(member)) return; } catch (_) { }
        }
        if (newCh) {
          try { if (typeof options.exemptChannels === 'function' && options.exemptChannels(newCh)) return; } catch (_) { }
        }

        if (options.debug) console.log(`[WaitingTracker] join ${newTrack}: ${userId} at ${now}`);
        waiting.set(userId, { joinedAt: now, trackName: newTrack, channelId: newCh.id, guildId: newState?.guild?.id });
      }
    } catch (e) {
      if (options.debug) console.error('[WaitingTracker] Error in voiceStateUpdate:', e);
    }
  });

  console.log(`✅ WaitingTracker: tracking voice masks [${targetMasks.join(', ')}]`);

  // Seed existing members currently in tracked channels if session is active
  seed();

  return { enabled: true };
}



function recordTime(member, seconds, trackName) {
  if (seconds <= 0 || !member) return;
  try {
    const userId = member.id;
    const discordName = getVoiceStateMemberName(member);
    
    // Find game name from squadron snapshots
    let gameName = '';
    const data = loadSquadronData();
    const rows = getSnapshotRows(data);
    if (Array.isArray(rows)) {
      const candidates = rows.map((row) => ({
        row,
        name: stripBrackets(String(row.Player || row.player || '')).trim(),
      })).filter(x => x.name);

      const found = fuseMatch(candidates, discordName, ['name']);
      if (found && found.item) {
        gameName = found.item.name;
      }
    }

    const result = addWaitTimeToStorage(userId, discordName, gameName, seconds, trackName);
    if (result && options.debug) {
      console.log(`[WaitingTracker] recorded ${seconds}s for '${discordName}' (${userId}) in track '${trackName}' (gameName: ${gameName || 'N/A'})`);
    }
  } catch (e) {
    console.warn(`[WaitingTracker] failed to update waiting_times.json for track ${trackName}:`, e.message);
  }
}

function loadSquadronData() {
  const file = path.join(process.cwd(), 'squadron_data.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function getSnapshotRows(data) {
  if (!data) return null;
  if (Array.isArray(data.squadronSnapshots)) {
    const snapshots = data.squadronSnapshots;
    if (!snapshots.length) return null;
    return snapshots[snapshots.length - 1]?.data?.rows || null;
  }
  return data?.data?.rows || null;
}

function loadWaitingTimes() {
  const file = path.join(process.cwd(), 'waiting_times.json');
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function saveWaitingTimes(data) {
  const file = path.join(process.cwd(), 'waiting_times.json');
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[WaitingTracker] failed to save waiting_times.json:', e && e.message ? e.message : e);
    return false;
  }
}

function addWaitTimeToStorage(userId, discordName, gameName, seconds, trackName) {
  const data = loadWaitingTimes();
  if (!data.players) data.players = {};
  
  if (!data.players[userId]) {
    data.players[userId] = {
      discordName: discordName,
      gameName: gameName || '',
      time: {}
    };
  } else {
    // Update names if they've changed or if we found a game name
    data.players[userId].discordName = discordName;
    if (gameName) data.players[userId].gameName = gameName;
  }

  const p = data.players[userId];
  
  // Update time object
  p.time[trackName] = (p.time[trackName] || 0) + seconds;

  return saveWaitingTimes(data);
}

function setTargetChannelId(channelId) {
  // Provided for backward compatibility; updates targetMasks to single ID
  targetMasks = channelId ? [String(channelId)] : [];
}

function getWaiting(channelName) {
  const trackName = String(channelName || '').trim();
  const now = Date.now();
  const arr = [];
  for (const [userId, rec] of waiting.entries()) {
    const seconds = Math.max(0, Math.floor((now - rec.joinedAt) / 1000));
    if (rec.trackName.toLowerCase().includes('trackName) && seconds > 0) {
      arr.push({ userId, seconds, trackName: rec.trackName, channelId: rec.channelId });
    }
  }
  // sort by longest waiting first
  arr.sort((a, b) => b.seconds - a.seconds);
  return arr;
}

function getVoiceStateMemberName(member) {
  if (!member) return '';
  const name = member.displayName || member.nickname || member.user?.globalName || member.user?.username || '';
  return stripBrackets(String(name)).trim();
}

function setTargetMasks(masks) {
  targetMasks = Array.isArray(masks) ? masks : (masks ? [String(masks)] : []);
}

module.exports = { init, setTargetChannelId, setTargetMasks, getWaiting, finalizeAll, seed };
