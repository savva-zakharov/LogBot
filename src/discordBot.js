// --- Events logging (mirror all Discord posts) ---
const fs = require('fs');
const path = require('path');
function ensureEventsFile() {
  const file = path.join(process.cwd(), 'squadron_events.json');
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8'); } catch (_) {}
  } else {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
        fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8');
      }
    } catch (_) {
      try { fs.writeFileSync(file, JSON.stringify({ events: [] }, null, 2), 'utf8'); } catch (_) {}
    }
  }
  return file;
}
function appendEvent(message, meta = {}) {
  try {
    const file = ensureEventsFile();
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(obj.events)) obj.events = [];
    obj.events.push({ ts: new Date().toISOString(), message, ...meta });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {}
}

// src/discordBot.js
const { Client, GatewayIntentBits, Partials, ChannelType, MessageFlags } = require('discord.js');
const state = require('./state');
const { loadSettings, OUTPUT_ORDER } = require('./config');
const waitingTracker = require('./waitingTracker');

let client = null;
let targetChannel = null;
let ready = false;
let desiredChannelName = null; // '#general', 'general', '1234567890', 'guildId/channelId', 'Server Name#channel'
let desiredGuildId = null; // Optional guild to scope operations
let appClientId = null; // Optional application client id
// Loaded command modules keyed by command name
const commands = new Map();
// Track per-game summary message IDs so we can edit instead of posting new
const summaryMessages = new Map(); // key: gameId (Number), value: messageId (String)
// Track merged summary last message to edit-if-recent
let mergedSummaryMessageId = null;
let mergedSummaryLastAt = 0; // ms epoch

function stripHash(name) {
  if (!name) return '';
  return name.startsWith('#') ? name.slice(1) : name;
}

function isSnowflake(str) {
  return typeof str === 'string' && /^\d{10,}$/.test(str);
}

async function resolveVoiceChannelId(raw) {
  if (!client || !raw) return null;
  const val = String(raw).trim();
  // Supports guildId/channelId
  if (/^\d{10,}\/\d{10,}$/.test(val)) {
    const [gId, cId] = val.split('/');
    try {
      const guild = await client.guilds.fetch(gId);
      if (guild) {
        const ch = await client.channels.fetch(cId);
        if (ch && (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) && ch.guild && ch.guild.id === guild.id) return ch.id;
      }
    } catch (_) {}
  }
  // Direct ID
  if (isSnowflake(val)) {
    try {
      const ch = await client.channels.fetch(val);
      if (ch && (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)) return ch.id;
    } catch (_) {}
  }
  // Name search within desired guild if set
  try {
    const name = val.toLowerCase();
    if (desiredGuildId && isSnowflake(desiredGuildId)) {
      try {
        const guild = await client.guilds.fetch(desiredGuildId);
        if (guild) {
          await guild.channels.fetch();
          const found = guild.channels.cache.find(c => c && (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) && c.name.toLowerCase() === name);
          if (found) return found.id;
        }
      } catch (_) {}
    }
    // Otherwise search across guilds
    for (const [, guild] of client.guilds.cache) {
      await guild.channels.fetch();
      const found = guild.channels.cache.find(c => c && (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) && c.name.toLowerCase() === name);
      if (found) return found.id;
    }
  } catch (_) {}
  return null;
}

function loadCommands() {
  commands.clear();
  try {
    const dir = path.join(__dirname, 'commands');
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      try {
        const mod = require(path.join(dir, file));
        if (!mod || !mod.data || !mod.data.name || typeof mod.execute !== 'function') {
          console.warn(`⚠️ Skipping command '${file}': missing data.name or execute()`);
          continue;
        }
        // Basic validation and helpful warnings
        const name = String(mod.data.name);
        const desc = String(mod.data.description || '');
        if (desc.length > 100) {
          console.warn(`⚠️ Command '${name}' description is ${desc.length} chars (>100). Discord will reject it.`);
        }
        if (!/^[\w-]{1,32}$/.test(name)) {
          console.warn(`⚠️ Command name '${name}' may be invalid. Must match ^[\\w-]{1,32}$.`);
        }
        commands.set(mod.data.name, mod);
      } catch (e) {
        console.warn(`⚠️ Failed to load command '${file}':`, e && e.message ? e.message : e);
      }
    }
    if (commands.size) {
      console.log(`✅ Loaded ${commands.size} command(s): ${[...commands.keys()].join(', ')}`);
    } else {
      console.log('ℹ️ No commands found in src/commands');
    }
  } catch (e) {
    console.warn('⚠️ Error loading commands:', e && e.message ? e.message : e);
  }
}

async function resolveChannel() {
  if (!client) return null;
  const desiredRaw = (desiredChannelName || 'general').trim();
  const desiredName = stripHash(desiredRaw).toLowerCase();
  let desiredGuildName = null;
  if (desiredRaw.includes('#') && !desiredRaw.startsWith('#') && !isSnowflake(desiredRaw)) {
    const idx = desiredRaw.lastIndexOf('#');
    desiredGuildName = desiredRaw.slice(0, idx).trim().toLowerCase();
  }
  try {
    // 1) If input looks like a channel ID, try direct fetch first
    if (isSnowflake(stripHash(desiredRaw))) {
      try {
        const byId = await client.channels.fetch(stripHash(desiredRaw));
        if (byId && (byId.type === ChannelType.GuildText || byId.type === ChannelType.GuildAnnouncement || typeof byId.send === 'function')) return byId;
      } catch (e) {
        console.warn('⚠️ Discord: Channel fetch by ID failed:', e && e.message ? e.message : e);
      }
    }

    // 1b) If input looks like guildId/channelId, try that explicitly
    if (/^\d{10,}\/[0-9]{10,}$/.test(desiredRaw)) {
      const [gId, cId] = desiredRaw.split('/');
      try {
        const guild = await client.guilds.fetch(gId);
        if (guild) {
          const channel = await client.channels.fetch(cId);
          if (channel && channel.guild && channel.guild.id === guild.id && channel.type === ChannelType.GuildText) return channel;
        }
      } catch (_) {}
    }

    // 2) If a guildId is provided, resolve only within that guild
    if (desiredGuildId && isSnowflake(desiredGuildId)) {
      try {
        const guild = await client.guilds.fetch(desiredGuildId);
        if (guild) {
          await guild.channels.fetch();
          // Try exact id inside this guild
          let found = guild.channels.cache.get(desiredRaw);
          if (found && (found.type === ChannelType.GuildText || found.type === ChannelType.GuildAnnouncement || typeof found.send === 'function')) return found;
          // Try by name
          found = guild.channels.cache.find(c => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === desiredName);
          if (found) return found;
        }
      } catch (_) {}
    }

    // 3) Otherwise, search by name across guilds
    for (const [, guild] of client.guilds.cache) {
      await guild.channels.fetch();
      // If a guild name was provided, skip others
      if (desiredGuildName && guild.name.toLowerCase() !== desiredGuildName) continue;
      // Match by name
      let found = guild.channels.cache.find(c => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === desiredName);
      if (found) return found;
      // Match by channel ID inside this guild
      found = guild.channels.cache.get(desiredRaw);
      if (found && (found.type === ChannelType.GuildText || found.type === ChannelType.GuildAnnouncement || typeof found.send === 'function')) return found;
    }
  } catch (_) {}
  return null;
}

async function init(settings) {
  const token = settings.discordBotToken;
  desiredChannelName = settings.discordChannel || '#general';
  appClientId = settings.clientId || process.env.CLIENT_ID || null;
  desiredGuildId = settings.guildId || process.env.GUILD_ID || null;
  if (!token || typeof token !== 'string' || token.trim() === '') {
    console.log('ℹ️ Discord: No token provided; Discord integration disabled.');
    return { enabled: false };
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel]
  });

  // Load command modules from src/commands
  loadCommands();

  // Generic command dispatcher
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      const cmd = commands.get(interaction.commandName);
      if (!cmd) return;
      await cmd.execute(interaction);
    } catch (e) {
      console.warn('⚠️ Discord: interaction error:', e && e.message ? e.message : e);
      try {
        if (!interaction.isRepliable()) return;
        const payload = { content: 'There was an error executing that command.', flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload);
        } else {
          await interaction.reply(payload);
        }
      } catch (_) {}
    }
  });

  client.once('ready', async () => {
    ready = true;
    try { await client.guilds.fetch(); } catch (_) {}
    // Start waiting tracker if configured
    try {
      const settings = loadSettings();
      const waitChanRaw = settings.waitingVoiceChannel || settings.waitingVoiceChannelId || process.env.WAITING_VOICE_CHANNEL || null;
      if (waitChanRaw) {
        const resolvedId = await resolveVoiceChannelId(waitChanRaw);
        if (resolvedId) {
          let chName = resolvedId;
          try { const chObj = await client.channels.fetch(resolvedId); if (chObj) chName = `${chObj.name} (${chObj.id})`; } catch (_) {}
          console.log(`ℹ️ WaitingTracker: initializing for voice channel ${chName}`);
          waitingTracker.init(client, resolvedId, { debug: true });
        } else {
          console.log(`ℹ️ Discord: waitingVoiceChannel '${waitChanRaw}' could not be resolved to a voice channel ID; /waiting will show empty list.`);
        }
      } else {
        console.log('ℹ️ Discord: waitingVoiceChannel not configured; /waiting will show empty list.');
      }
    } catch (e) { console.warn('⚠️ WaitingTracker init failed:', e && e.message ? e.message : e); }
    // Register loaded slash commands; scope to desired guild if provided
    try {
      const commandDefs = [...commands.values()].map(c => ({
        name: c.data.name,
        description: c.data.description || 'No description',
        options: Array.isArray(c.data.options) ? c.data.options : undefined,
      }));
      if (desiredGuildId && isSnowflake(desiredGuildId)) {
        try {
          const guild = await client.guilds.fetch(desiredGuildId);
          if (guild) {
            for (const def of commandDefs) {
              try { await guild.commands.create(def); }
              catch (e) { console.warn(`⚠️ Failed to register /${def.name} in guild ${guild.id}:`, e && e.message ? e.message : e); }
            }
          }
        } catch (_) {}
      } else {
        for (const [, guild] of client.guilds.cache) {
          for (const def of commandDefs) {
            try { await guild.commands.create(def); }
            catch (e) { console.warn(`⚠️ Failed to register /${def.name} in guild ${guild.id}:`, e && e.message ? e.message : e); }
          }
        }
      }
      if (commandDefs.length) console.log(`✅ Registered ${commandDefs.length} command(s)`);
    } catch (_) {}
    targetChannel = await resolveChannel();
    if (targetChannel) {
      console.log(`🤖 Discord bot ready. Posting to ${targetChannel.name} (${targetChannel.id})`);
      // Send a hello message on startup to verify connectivity
      try {
        await targetChannel.send({ content: '```\nLogBot started!\n```' });
      } catch (e) {
        console.warn('⚠️ Discord: Failed to send hello message:', e && e.message ? e.message : e);
      }
    } else {
      console.warn(`⚠️ Discord: Could not find channel '${desiredChannelName}'.`);
      try {
        // Helpful debug: list some visible text channels
        const guildInfos = [];
        const guildsToInspect = [];
        if (desiredGuildId && isSnowflake(desiredGuildId)) {
          try { const g = await client.guilds.fetch(desiredGuildId); if (g) guildsToInspect.push(g); } catch (_) {}
        } else {
          for (const [, g] of client.guilds.cache) guildsToInspect.push(g);
        }
        for (const guild of guildsToInspect) {
          await guild.channels.fetch();
          const texts = guild.channels.cache
            .filter(c => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
            .map(c => `#${c.name} (${c.id})`)
            .slice(0, 8)
            .join(', ');
          guildInfos.push(`${guild.name} (${guild.id}): ${texts}`);
        }
        if (guildInfos.length) {
          console.warn('⚠️ Discord: Guilds and some visible text channels:');
          guildInfos.forEach(info => console.warn('  -', info));
          console.warn('ℹ️ Tip: You can set discordChannel to a channel ID (recommended), "guildId/channelId", or "Server Name#channel".');
        }
      } catch (_) {}
      // Retry resolution a few times in case caches warm up slowly
      try {
        for (let i = 0; i < 5 && !targetChannel; i++) {
          await new Promise(r => setTimeout(r, 1500));
          targetChannel = await resolveChannel();
        }
        if (targetChannel) {
          console.log(`🤖 Discord channel resolved after retry: ${targetChannel.name} (${targetChannel.id})`);
          try { await targetChannel.send({ content: '```\nHello world from LogBot!\n```' }); } catch (_) {}
        }
      } catch (_) {}
    }
  });

  client.on('error', (e) => {
    console.error('❌ Discord client error:', e);
  });

  try {
    await client.login(token);
    return { enabled: true };
  } catch (e) {
    console.error('❌ Discord login failed:', e && e.message ? e.message : e);
    return { enabled: false, error: e };
  }
}

function formatSummary(gameId) {
  const lines = [];
  lines.push(`Game ${gameId} summary:`);
  const summaries = state.getSquadronSummaries(gameId) || [];
  // Exclude only the FIRST configured squadron from settings.json
  let excludeSquadrons = new Set();
  try {
    const settings = loadSettings();
    const keys = Object.keys(settings.squadrons || {});
    const first = keys.length ? String(keys[0]) : '';
    const cleanedFirst = first ? first.replace(/[^A-Za-z0-9]/g, '') : '';
    if (cleanedFirst) excludeSquadrons = new Set([cleanedFirst]);
  } catch (_) {}
  if (!summaries.length) {
    lines.push('(no entries)');
  } else {
    summaries
      .filter(s => s.game === Number(gameId))
      .filter(s => !excludeSquadrons.has(s.squadron))
      .forEach(s => lines.push(s.line));
  }
  const content = lines.join('\n');
  // Split into blocks where EACH block is wrapped in ``` to ensure proper formatting per message
  const blocks = [];
  const maxLen = 1900; // conservative limit under Discord's 2000
  const wrapperOverhead = 8; // length of "```\n" + "\n```"
  let current = '';
  for (const line of content.split('\n')) {
    const candidate = (current ? current + '\n' : '') + line;
    if (candidate.length + wrapperOverhead > maxLen) {
      if (current) {
        blocks.push('```\n' + current + '\n```');
        current = line;
      } else {
        // Single line too long, hard-split it
        let remaining = line;
        while (remaining.length + wrapperOverhead > maxLen) {
          const slice = remaining.slice(0, maxLen - wrapperOverhead);
          blocks.push('```\n' + slice + '\n```');
          remaining = remaining.slice(maxLen - wrapperOverhead);
        }
        current = remaining;
      }
    } else {
      current = candidate;
    }
  }
  if (current) blocks.push('```\n' + current + '\n```');
  return blocks;
}

// Build a single text block for merged summary across all games
function formatMergedSummaryText() {
  const lines = [];
  try {
    // Meta header lines from current game's meta
    try {
      const currentGame = state.getCurrentGame();
      const meta = state.getGameMeta(currentGame) || { squadNo: '', gc: '', ac: '' };
      lines.push(`Squad: ${meta.squadNo || ''}`);
      lines.push(`AC: ${meta.ac || ''}`);
      lines.push(`GC: ${meta.gc || ''}`);
    } catch (_) {}

    // Build exactly like index.html's allGamesSummaryBody
    // Group per game: totals across squadrons for each game (excluding excluded squadrons)
    const isExcluded = (sqName) => {
      try {
        const settings = loadSettings();
        const h = (settings.squadrons || {})[sqName];
        if (h && typeof h === 'object' && h.exclude === true) return true;
      } catch (_) {}
      return false;
    };

    const grouped = new Map(); // game -> { totals, squads }
    const all = state.getSquadronSummaries(null) || [];
    for (const item of all) {
      if (!item || !item.counts || item.game == null) continue;
      const game = Number(item.game);
      const sq = item.squadron;
      if (!sq || isExcluded(sq)) continue;
      if (!grouped.has(game)) {
        const totals = {}; OUTPUT_ORDER.forEach(k => { totals[k] = 0; });
        grouped.set(game, { totals, squads: new Set() });
      }
      const g = grouped.get(game);
      g.squads.add(sq);
      OUTPUT_ORDER.forEach(label => {
        g.totals[label] = (g.totals[label] || 0) + (item.counts[label] || 0);
      });
    }

    const games = Array.from(grouped.keys()).sort((a,b) => a - b);
    if (games.length === 0) {
      lines.push('No data');
    } else {
      for (const gm of games) {
        const g = grouped.get(gm);
        const sqName = (g.squads.size <= 1) ? (Array.from(g.squads)[0] || '') : 'MULT.';
        const parts = OUTPUT_ORDER.map(label => `${g.totals[label] || 0} ${label}`);
        const namePad = String(sqName).replace(/[^A-Za-z0-9]/g,'').padEnd(6,' ').slice(0,6);
        const line = `${namePad} | ${parts.join(' | ')} |`;
        lines.push(line);
      }
    }
  } catch (e) {
    lines.push('(error building summary)');
  }

  // Keep within Discord 2000 char limit (code block wrapped)
  let content = lines.join('\n');
  const wrapperOverhead = 8; // ``` + ```
  const maxLen = 2000 - wrapperOverhead;
  if (content.length > maxLen) {
    content = content.slice(content.length - maxLen);
    const cutIdx = content.indexOf('\n');
    if (cutIdx > 0) content = content.slice(cutIdx + 1);
  }
  return '```\n' + content + '\n```';
}

// Post or edit the merged summary message (edit if recently posted)
async function postMergedSummary() {
  const ch = await ensureTargetChannel();
  if (!ch) {
    console.warn('⚠️ Discord: No target channel for merged summary.');
    return null;
  }
  const content = formatMergedSummaryText();
  const now = Date.now();
  const RECENT_MS = 10 * 60 * 1000; // 10 minutes window
  try {
    if (mergedSummaryMessageId && (now - mergedSummaryLastAt) <= RECENT_MS) {
      try {
        const msg = await ch.messages.fetch(mergedSummaryMessageId);
        if (msg) {
          await msg.edit({ content });
          mergedSummaryLastAt = now;
          return msg;
        }
      } catch (_) { /* fallthrough to send new */ }
    }
    const sent = await ch.send({ content });
    mergedSummaryMessageId = sent.id;
    mergedSummaryLastAt = now;
    return sent;
  } catch (e) {
    console.error('❌ Discord: Failed to post merged summary:', e && e.message ? e.message : e);
    return null;
  }
}

// Build a single text block for editing an existing message
function formatSummaryText(gameId) {
  const lines = [];
  lines.push(`Game ${gameId} summary:`);
  const summaries = state.getSquadronSummaries(gameId) || [];
  // Exclude only the FIRST configured squadron from settings.json
  let excludeSquadrons = new Set();
  try {
    const settings = loadSettings();
    const keys = Object.keys(settings.squadrons || {});
    const first = keys.length ? String(keys[0]) : '';
    const cleanedFirst = first ? first.replace(/[^A-Za-z0-9]/g, '') : '';
    if (cleanedFirst) excludeSquadrons = new Set([cleanedFirst]);
  } catch (_) {}
  if (!summaries.length) {
    lines.push('(no entries)');
  } else {
    summaries
      .filter(s => s.game === Number(gameId))
      .filter(s => !excludeSquadrons.has(s.squadron))
      .forEach(s => lines.push(s.line));
  }
  let content = lines.join('\n');
  const wrapperOverhead = 8; // length of "```\n" + "\n```"
  const maxLen = 2000 - wrapperOverhead;
  if (content.length > maxLen) {
    // Keep tail (most recent updates)
    content = content.slice(content.length - maxLen);
    const cutIdx = content.indexOf('\n');
    if (cutIdx > 0) content = content.slice(cutIdx + 1);
  }
  return '```\n' + content + '\n```';
}

// Post or update a single message per game id
async function ensureTargetChannel() {
  if (!client) return null;
  if (!ready) {
    try { await new Promise(r => setTimeout(r, 200)); } catch (_) {}
  }
  if (!targetChannel) {
    try { targetChannel = await resolveChannel(); } catch (_) {}
  }
  return targetChannel;
}

async function sendMessage(content) {
  const ch = await ensureTargetChannel();
  if (!ch) {
    console.warn('⚠️ Discord: sendMessage called but no target channel resolved.');
    return null;
  }
  try {
    let text = String(content == null ? '' : content);
    const trimmed = text.trim();
    if (!trimmed.startsWith('```')) {
      text = '```\n' + text + '\n```';
    }
    const sent = await ch.send({ content: text, allowedMentions: { parse: [] } });
    // Do not mirror raw Discord messages into squadron_events.json anymore
    return sent;
  } catch (e) {
    console.warn('⚠️ Discord: failed to send message:', e && e.message ? e.message : e);
    // Do not mirror failed message content into event log either
    return null;
  }
}

async function postGameSummary(gameId) {
  if (!client) return;
  const ch = await ensureTargetChannel();
  if (!ch) {
    console.warn('⚠️ Discord: No target channel resolved; skipping post.');
    return;
  }
  try {
    const text = formatSummaryText(gameId);
    const key = Number(gameId);
    const existingId = summaryMessages.get(key);
    if (existingId) {
      try {
        const msg = await ch.messages.fetch(existingId);
        if (msg) {
          await msg.edit({ content: text });
          return;
        }
      } catch (_) {
        // If edit fails, fall through to sending a new message
      }
    }
    const sent = await ch.send({ content: text });
    summaryMessages.set(key, sent.id);
  } catch (e) {
    console.error('❌ Discord: Failed to post summary:', e && e.message ? e.message : e);
  }
}

module.exports = { init, postGameSummary, postMergedSummary, sendMessage };
