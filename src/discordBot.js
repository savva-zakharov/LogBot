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

// Generic channel resolver by raw input (ID, guildId/channelId, name, or Server Name#channel)
async function resolveChannelByRaw(desiredRaw) {
  if (!client) return null;
  const desired = (desiredRaw || 'general').trim();
  const desiredName = stripHash(desired).toLowerCase();
  let desiredGuildName = null;
  if (desired.includes('#') && !desired.startsWith('#') && !isSnowflake(desired)) {
    const idx = desired.lastIndexOf('#');
    desiredGuildName = desired.slice(0, idx).trim().toLowerCase();
  }
  try {
    // 1) Direct channel ID
    if (isSnowflake(stripHash(desired))) {
      try {
        const byId = await client.channels.fetch(stripHash(desired));
        if (byId && (byId.type === ChannelType.GuildText || byId.type === ChannelType.GuildAnnouncement || typeof byId.send === 'function')) return byId;
      } catch (_) {}
    }
    // 1b) guildId/channelId
    if (/^\d{10,}\/[0-9]{10,}$/.test(desired)) {
      const [gId, cId] = desired.split('/');
      try {
        const guild = await client.guilds.fetch(gId);
        if (guild) {
          const channel = await client.channels.fetch(cId);
          if (channel && channel.guild && channel.guild.id === guild.id && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)) return channel;
        }
      } catch (_) {}
    }
    // 2) If a guildId is provided, try restricting there first
    if (desiredGuildId && isSnowflake(desiredGuildId)) {
      try {
        const guild = await client.guilds.fetch(desiredGuildId);
        if (guild) {
          await guild.channels.fetch();
          // Try exact id inside this guild
          let found = guild.channels.cache.get(desired);
          if (found && (found.type === ChannelType.GuildText || found.type === ChannelType.GuildAnnouncement || typeof found.send === 'function')) return found;
          // Try by name
          found = guild.channels.cache.find(c => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === desiredName);
          if (found) return found;
        }
      } catch (_) {}
    }
    // 3) Otherwise search across guilds (optionally filtered by desiredGuildName)
    for (const [, guild] of client.guilds.cache) {
      await guild.channels.fetch();
      if (desiredGuildName && guild.name.toLowerCase() !== desiredGuildName) continue;
      let found = guild.channels.cache.find(c => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === desiredName);
      if (found) return found;
      found = guild.channels.cache.get(desired);
      if (found && (found.type === ChannelType.GuildText || found.type === ChannelType.GuildAnnouncement || typeof found.send === 'function')) return found;
    }
  } catch (_) {}
  return null;
}

// Hot-reload: change target text channel at runtime
async function setDiscordChannel(raw) {
  try {
    desiredChannelName = raw || desiredChannelName || '#general';
    // Force re-resolve on next send; also attempt immediate resolve
    targetChannel = null;
    targetChannel = await resolveChannel();
    if (targetChannel) return targetChannel.id;
  } catch (_) {}
  return null;
}

// Hot-reload: change waiting voice channel at runtime
async function reconfigureWaitingVoiceChannel(raw) {
  try {
    const id = await resolveVoiceChannelId(raw);
    if (id) {
      waitingTracker.setTargetChannelId(id);
      return id;
    }
  } catch (_) {}
  return null;
}

// src/discordBot.js
const { Client, GatewayIntentBits, Partials, ChannelType, MessageFlags } = require('discord.js');
const state = require('./state');
const { loadSettings, OUTPUT_ORDER } = require('./config');
const { buildMergedSummary } = require('./summaryFormatter');
const waitingTracker = require('./waitingTracker');

let client = null;
let targetChannel = null;
let logsChannel = null;
let winLossChannel = null;
let ready = false;
let desiredChannelName = null; // '#general', 'general', '1234567890', 'guildId/channelId', 'Server Name#channel'
let desiredLogsChannelName = null; // same formats as above
let desiredWinLossChannelName = null; // same formats as above
let desiredGuildId = null; // Optional guild to scope operations
let appClientId = null; // Optional application client id
// Loaded command modules keyed by command name
const commands = new Map();
// Track merged summary last message to edit-if-recent
let mergedSummaryMessageId = null;
let mergedSummaryLastAt = 0; // ms epoch
// Persisted reference to allow editing across restarts
const SUMMARY_REF_FILE = path.join(process.cwd(), '.merged_summary_ref.json');

function loadMergedSummaryRef() {
  try {
    const raw = fs.readFileSync(SUMMARY_REF_FILE, 'utf8');
    const j = JSON.parse(raw || '{}');
    if (j && j.channelId && j.messageId) {
      return { channelId: String(j.channelId), messageId: String(j.messageId) };
    }
  } catch (_) {}
  return null;
}

function saveMergedSummaryRef(ref) {
  try {
    fs.writeFileSync(SUMMARY_REF_FILE, JSON.stringify({ channelId: ref.channelId, messageId: ref.messageId }, null, 2), 'utf8');
  } catch (_) {}
}

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
  // Initialize optional channels from settings
  desiredLogsChannelName = settings.discordLogsChannel || desiredLogsChannelName || '';
  desiredWinLossChannelName = settings.discordWinLossChannell || desiredWinLossChannelName || '';
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
      // Route component interactions for lowpoint/settings panels (buttons + modals)
      if (interaction.isButton() || interaction.isModalSubmit()) {
        const id = interaction.customId || '';
        if (id.startsWith('lp_') || id === 'lp_thr_modal') {
          const lowpoint = commands.get('lowpoint');
          if (lowpoint && typeof lowpoint.handleComponent === 'function') {
            const handled = await lowpoint.handleComponent(interaction);
            if (handled) return;
          }
        }
        if (id.startsWith('cfg_') || id === 'cfg_modal_dc' || id === 'cfg_modal_wvc' || id === 'cfg_modal_url') {
          const settingsCmd = commands.get('settings');
          if (settingsCmd && typeof settingsCmd.handleComponent === 'function') {
            const handled = await settingsCmd.handleComponent(interaction);
            if (handled) return;
          }
        }
      }
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
  try {
    const { meta, lines } = buildMergedSummary();
    const out = [];
    out.push(`Squad: ${meta.squadNo || ''}`);
    out.push(`AC: ${meta.ac || ''}`);
    out.push(`GC: ${meta.gc || ''}`);
    if (!lines || lines.length === 0) out.push('No data'); else out.push(...lines);
    // Keep within Discord 2000 char limit (code block wrapped)
    let content = out.join('\n');
    const wrapperOverhead = 8; // ``` + ```
    const maxLen = 2000 - wrapperOverhead;
    if (content.length > maxLen) {
      content = content.slice(content.length - maxLen);
      const cutIdx = content.indexOf('\n');
      if (cutIdx > 0) content = content.slice(cutIdx + 1);
    }
    return '```\n' + content + '\n```';
  } catch (e) {
    return '```\n(error building summary)\n```';
  }
}

// Post or edit the merged summary message (always try edit; persist ref across restarts)
async function postMergedSummary() {
  // Prefer logs channel; fallback to default target channel
  let ch = await ensureLogsChannel();
  if (!ch) ch = await ensureTargetChannel();
  if (!ch) {
    console.warn('⚠️ Discord: No channel available for merged summary.');
    return null;
  }
  const content = formatMergedSummaryText();
  try {
    // Try persisted reference first (survives restarts and channel switches)
    const persisted = loadMergedSummaryRef();
    if (persisted && persisted.channelId === ch.id) {
      try {
        const existing = await ch.messages.fetch(persisted.messageId);
        if (existing) {
          const edited = await existing.edit({ content });
          mergedSummaryMessageId = existing.id;
          mergedSummaryLastAt = Date.now();
          return edited;
        }
      } catch (_) { /* proceed to try in-memory or send new */ }
    }
    // Try in-memory id next (same-process subsequent calls)
    if (mergedSummaryMessageId) {
      try {
        const msg = await ch.messages.fetch(mergedSummaryMessageId);
        if (msg) {
          const edited = await msg.edit({ content });
          mergedSummaryLastAt = Date.now();
          // Ensure persisted ref is up to date
          saveMergedSummaryRef({ channelId: ch.id, messageId: msg.id });
          return edited;
        }
      } catch (_) { /* fallthrough to send */ }
    }
    // Otherwise, send a new message and persist reference
    const sent = await ch.send({ content });
    mergedSummaryMessageId = sent.id;
    mergedSummaryLastAt = Date.now();
    saveMergedSummaryRef({ channelId: ch.id, messageId: sent.id });
    return sent;
  } catch (e) {
    console.error('❌ Discord: Failed to post merged summary:', e && e.message ? e.message : e);
    return null;
  }
}

// (per-game summary formatting removed)

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

// Optional secondary channels: logs and win/loss
async function ensureLogsChannel() {
  if (!client) return null;
  // If no desired name has been set yet, attempt to read from settings.json lazily
  if (!desiredLogsChannelName) {
    try {
      const s = loadSettings();
      if (s && typeof s.discordLogsChannel === 'string' && s.discordLogsChannel.trim()) {
        desiredLogsChannelName = s.discordLogsChannel;
      }
    } catch (_) {}
  }
  if (!logsChannel && desiredLogsChannelName) {
    try { logsChannel = await resolveChannelByRaw(desiredLogsChannelName); } catch (_) {}
  }
  return logsChannel;
}

async function ensureWinLossChannel() {
  if (!client) return null;
  if (!winLossChannel && desiredWinLossChannelName) {
    try { winLossChannel = await resolveChannelByRaw(desiredWinLossChannelName); } catch (_) {}
  }
  return winLossChannel;
}

// Hot-apply setters for optional channels
async function setLogsChannel(raw) {
  try {
    desiredLogsChannelName = raw || desiredLogsChannelName || '';
    logsChannel = null;
    logsChannel = await resolveChannelByRaw(desiredLogsChannelName);
    return logsChannel ? logsChannel.id : null;
  } catch (_) { return null; }
}

async function setWinLossChannel(raw) {
  try {
    desiredWinLossChannelName = raw || desiredWinLossChannelName || '';
    winLossChannel = null;
    winLossChannel = await resolveChannelByRaw(desiredWinLossChannelName);
    return winLossChannel ? winLossChannel.id : null;
  } catch (_) { return null; }
}

// (per-game summary posting removed)

// Post a compact win/loss notice to the dedicated win/loss channel, if configured
async function postWinLossNotice(type, gameId) {
  const ch = await ensureWinLossChannel();
  if (!ch) return null;
  try {
    const t = (type || '').toLowerCase() === 'win' ? 'WIN' : 'LOSS';
    const text = `Game ${Number(gameId)}: ${t}`;
    return await ch.send({ content: '```\n' + text + '\n```' });
  } catch (e) {
    console.warn('⚠️ Discord: failed to post win/loss notice:', e && e.message ? e.message : e);
    return null;
  }
}

// Send arbitrary content to the dedicated win/loss channel, if configured
async function sendWinLossMessage(content) {
  const ch = await ensureWinLossChannel();
  if (!ch) {
    console.warn('⚠️ Discord: sendWinLossMessage called but no win/loss channel resolved.');
    return null;
  }
  try {
    let text = String(content == null ? '' : content);
    const trimmed = text.trim();
    if (!trimmed.startsWith('```')) {
      text = '```\n' + text + '\n```';
    }
    return await ch.send({ content: text, allowedMentions: { parse: [] } });
  } catch (e) {
    console.warn('⚠️ Discord: failed to send win/loss message:', e && e.message ? e.message : e);
    return null;
  }
}

// (per-game summary posting removed)

function getClient() { return client; }

module.exports = { init, postMergedSummary, postWinLossNotice, sendMessage, sendWinLossMessage, getClient, setDiscordChannel, reconfigureWaitingVoiceChannel, setLogsChannel, setWinLossChannel };
