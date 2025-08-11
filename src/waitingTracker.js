// src/waitingTracker.js
// Tracks how long members have been in a specified voice channel.

let clientRef = null;
let targetChannelId = null;
const waiting = new Map(); // userId -> { joinedAt: number (ms), channelId: string }

function init(client, channelId) {
  clientRef = client;
  targetChannelId = channelId || null;
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

      const now = Date.now();
      // Joined target channel
      if (after === targetChannelId && before !== targetChannelId) {
        if (!waiting.has(userId)) {
          waiting.set(userId, { joinedAt: now, channelId: after });
        }
      }
      // Left target channel
      if (before === targetChannelId && after !== targetChannelId) {
        waiting.delete(userId);
      }
      // Moved within same target channel -> ignore
    } catch (_) {}
  });

  console.log(`✅ WaitingTracker: tracking voice channel ${targetChannelId}`);
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
