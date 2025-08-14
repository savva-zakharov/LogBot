// src/waitingTracker.js
// Tracks how long members have been in a specified voice channel.

let clientRef = null;
let targetChannelId = null;
const waiting = new Map(); // userId -> { joinedAt: number (ms), channelId: string }
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

function init(client, channelId, opts = {}) {
  clientRef = client;
  targetChannelId = channelId || null;
  options = { ...options, ...(opts || {}) };
  if (!clientRef) throw new Error('waitingTracker.init requires a Discord client');
  if (!targetChannelId) {
    console.log('ℹ️ WaitingTracker: no target voice channel configured; tracker disabled.');
    return { enabled: false };
  }

  clientRef.on('voiceStateUpdate', (oldState, newState) => {
    try {
      const userId = newState?.id || oldState?.id;
      if (!userId) return;
      const before = oldState?.channelId || null;
      const after = newState?.channelId || null;
      const member = newState?.member || oldState?.member || null;
      const joinedChannelIsTarget = after === targetChannelId;
      const leftChannelIsTarget = before === targetChannelId;

      // Exempt checks
      if (member) {
        if (!options.trackBots && member.user?.bot) return;
        try { if (typeof options.exemptMembers === 'function' && options.exemptMembers(member)) return; } catch (_) {}
      }
      // Exempt target channel entirely if configured
      if (joinedChannelIsTarget || leftChannelIsTarget) {
        try {
          const ch = joinedChannelIsTarget ? newState?.channel : oldState?.channel;
          if (ch && typeof options.exemptChannels === 'function' && options.exemptChannels(ch)) {
            // If channel exempt, ensure user is not tracked
            if (waiting.has(userId)) waiting.delete(userId);
            return;
          }
        } catch (_) {}
      }

      const now = Date.now();
      // Joined target channel
      if (joinedChannelIsTarget && before !== targetChannelId) {
        if (options.debug) console.log(`[WaitingTracker] join target: ${userId} at ${now}`);
        if (!waiting.has(userId)) {
          waiting.set(userId, { joinedAt: now, channelId: after });
        }
      }
      // Left target channel
      if (leftChannelIsTarget && after !== targetChannelId) {
        if (options.debug) console.log(`[WaitingTracker] leave target: ${userId} at ${now}`);
        waiting.delete(userId);
      }
      // Moved within same target channel -> ignore
    } catch (_) {}
  });

  console.log(`✅ WaitingTracker: tracking voice channel ${targetChannelId}`);
  // Seed existing members currently in the target voice channel (best-effort, async)
  ;(async () => {
    try {
      const ch = await clientRef.channels.fetch(targetChannelId).catch(() => null);
      if (!ch || !ch.members) return;
      try { if (ch.guild && ch.guild.members) await ch.guild.members.fetch(); } catch (_) {}
      let added = 0;
      for (const [, gm] of ch.members) {
        try {
          if (!options.trackBots && gm.user?.bot) continue;
          if (typeof options.exemptMembers === 'function' && options.exemptMembers(gm)) continue;
          if (!waiting.has(gm.id)) {
            waiting.set(gm.id, { joinedAt: Date.now(), channelId: targetChannelId });
            added++;
          }
        } catch (_) {}
      }
      if (options.debug || added) console.log(`ℹ️ WaitingTracker: seeded ${added} member(s) currently in channel.`);
    } catch (_) {}
  })();
  return { enabled: true };
}

function setTargetChannelId(channelId) {
  targetChannelId = channelId || null;
}

function getWaiting() {
  const now = Date.now();
  const arr = [];
  for (const [userId, rec] of waiting.entries()) {
    const seconds = Math.max(0, Math.floor((now - rec.joinedAt) / 1000));
    arr.push({ userId, seconds, channelId: rec.channelId });
  }
  // sort by longest waiting first
  arr.sort((a, b) => b.seconds - a.seconds);
  return arr;
}

module.exports = { init, setTargetChannelId, getWaiting };
