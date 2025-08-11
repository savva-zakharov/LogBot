// src/discordBot.js
const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const state = require('./state');

let client = null;
let targetChannel = null;
let ready = false;
let desiredChannelName = null; // '#general', 'general', '1234567890', 'guildId/channelId', 'Server Name#channel'
let desiredGuildId = null; // Optional guild to scope operations
let appClientId = null; // Optional application client id
// Loaded command modules keyed by command name
const commands = new Map();

function stripHash(name) {
  if (!name) return '';
  return name.startsWith('#') ? name.slice(1) : name;
}

function isSnowflake(str) {
  return typeof str === 'string' && /^\d{10,}$/.test(str);
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
      try { if (interaction.isRepliable()) await interaction.reply({ content: 'There was an error executing that command.', ephemeral: true }); } catch (_) {}
    }
  });

  client.once('ready', async () => {
    ready = true;
    try { await client.guilds.fetch(); } catch (_) {}
    // Register loaded slash commands; scope to desired guild if provided
    try {
      const commandDefs = [...commands.values()].map(c => ({ name: c.data.name, description: c.data.description || 'No description' }));
      if (desiredGuildId && isSnowflake(desiredGuildId)) {
        try {
          const guild = await client.guilds.fetch(desiredGuildId);
          if (guild) {
            for (const def of commandDefs) { try { await guild.commands.create(def); } catch (_) {} }
          }
        } catch (_) {}
      } else {
        for (const [, guild] of client.guilds.cache) {
          for (const def of commandDefs) { try { await guild.commands.create(def); } catch (_) {} }
        }
      }
      if (commandDefs.length) console.log(`✅ Registered ${commandDefs.length} command(s)`);
    } catch (_) {}
    targetChannel = await resolveChannel();
    if (targetChannel) {
      console.log(`🤖 Discord bot ready. Posting to ${targetChannel.name} (${targetChannel.id})`);
      // Send a hello message on startup to verify connectivity
      try {
        await targetChannel.send({ content: '```\nHello world from LogBot!\n```' });
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
  if (!summaries.length) {
    lines.push('(no entries)');
  } else {
    summaries.filter(s => s.game === Number(gameId)).forEach(s => lines.push(s.line));
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

async function postGameSummary(gameId) {
  if (!client) return;
  if (!ready) {
    // Wait a bit and try again
    try { await new Promise(r => setTimeout(r, 1000)); } catch(_){}
  }
  if (!targetChannel) {
    try { targetChannel = await resolveChannel(); } catch(_){}
  }
  if (!targetChannel) {
    console.warn('⚠️ Discord: No target channel resolved; skipping post.');
    return;
  }
  try {
    const blocks = formatSummary(gameId);
    for (const b of blocks) {
      await targetChannel.send({ content: b });
    }
  } catch (e) {
    console.error('❌ Discord: Failed to post summary:', e && e.message ? e.message : e);
  }
}

module.exports = { init, postGameSummary };
