// src/commands/logbird.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const webhookManager = require('../webhookManager');
const { bestMatchPlayer, normalizeName } = require('../nameMatch');

// Static avatar URL from user request
const AVATAR_URL = 'https://media.discordapp.net/attachments/1404932126322851921/1406726689739903136/Ostrich-png.png?ex=68a383d2&is=68a23252&hm=501aef41f393f48dda0c20ad1db26b81c2cb624761712eb4f7ee179d8f05a20a&=&format=webp&quality=lossless';

function loadRawSettings() {
  try {
    const file = path.join(process.cwd(), 'settings.json');
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

// Encrypt arbitrary text with a key derived from the matched in-game name
function encryptWithPlayerName(plain, playerName) {
  try {
    const name = String(playerName || '').trim();
    if (!name) return null;
    const salt = 'logbird.namekey.v1';
    const key = crypto.scryptSync(name, salt, 32); // 256-bit key
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Prefix with version so clients can decode appropriately
    return 'n1:' + iv.toString('base64') + ':' + enc.toString('base64') + ':' + tag.toString('base64');
  } catch (_) { return null; }
}

function makeLogbirdNameForUser(interaction) {
  const uname = (interaction && interaction.member && interaction.member.displayName)
    || (interaction && interaction.user && (interaction.user.globalName || interaction.user.username))
    || 'User';
  // Discord webhook name max length is 80 chars
  const name = `Logbird-${String(uname)}`;
  return name.length > 80 ? name.slice(0, 80) : name;
}

function getInvokerDisplayName(interaction) {
  const uname = (interaction && interaction.member && interaction.member.displayName)
    || (interaction && interaction.user && (interaction.user.globalName || interaction.user.username))
    || '';
  return String(uname || '').trim();
}

function readLatestSquadronSnapshot() {
  try {
    const file = path.join(process.cwd(), 'squadron_data.json');
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (Array.isArray(obj.squadronSnapshots)) {
      const arr = obj.squadronSnapshots;
      return arr.length ? arr[arr.length - 1] : null;
    }
    return obj && typeof obj === 'object' && Object.keys(obj).length ? obj : null;
  } catch (_) { return null; }
}

function normalizeId(input) {
  return String(input || '').replace(/[^0-9]/g, '');
}

async function resolveLogsChannel(interaction, settings) {
  if (!interaction.guild) return null;
  const pref = settings && settings.discordLogsChannel;
  const raw = pref ? String(pref).trim() : '';
  if (!raw) return null;

  try {
    const byPair = raw.match(/^(\d{10,})\/(\d{10,})$/);
    if (byPair) {
      const [, gId, cId] = byPair;
      if (interaction.guild.id !== gId) return null; // restrict to invoking guild
      const ch = await interaction.guild.channels.fetch(cId).catch(() => null);
      if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) return ch;
    }
  } catch (_) {}

  try {
    const id = normalizeId(raw);
    if (id) {
      const ch = await interaction.guild.channels.fetch(id).catch(() => null);
      if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) return ch;
    }
  } catch (_) {}

  try {
    const name = raw.replace(/^#/, '').toLowerCase();
    await interaction.guild.channels.fetch();
    const ch = interaction.guild.channels.cache.find(c => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === name);
    if (ch) return ch;
  } catch (_) {}

  return null;
}

async function resolveDataChannel(interaction, settings) {
  if (!interaction.guild) return null;
  const raw = (settings && settings.discordDataChannel) ? String(settings.discordDataChannel).trim() : '';
  if (!raw) return null;
  try {
    const byPair = raw.match(/^(\d{10,})\/(\d{10,})$/);
    if (byPair) {
      const [, gId, cId] = byPair;
      if (interaction.guild.id !== gId) return null;
      const ch = await interaction.guild.channels.fetch(cId).catch(() => null);
      if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) return ch;
    }
  } catch (_) {}
  try {
    const id = normalizeId(raw);
    if (id) {
      const ch = await interaction.guild.channels.fetch(id).catch(() => null);
      if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) return ch;
    }
  } catch (_) {}
  try {
    const name = raw.replace(/^#/, '').toLowerCase();
    await interaction.guild.channels.fetch();
    const ch = interaction.guild.channels.cache.find(c => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === name);
    if (ch) return ch;
  } catch (_) {}
  return null;
}

function hasAllowedRole(interaction, settings) {
  if (!interaction.guild) return false;
  // Admin is always allowed
  if (interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) return true;

  const roleIds = Array.isArray(settings.logbirdRoleIds) ? settings.logbirdRoleIds.map(String) : [];
  const roleNames = Array.isArray(settings.logbirdRoles) ? settings.logbirdRoles.map(s => String(s).toLowerCase()) : [];

  const roles = interaction.member && interaction.member.roles ? interaction.member.roles : null;
  const cache = roles && roles.cache ? roles.cache : new Map();

  // ID check
  for (const rid of roleIds) {
    if (cache.has(rid)) return true;
  }
  // Name check
  for (const [, role] of cache) {
    if (role && role.name && roleNames.includes(role.name.toLowerCase())) return true;
  }
  return false;
}

async function nextLogbirdName(channel) {
  try {
    const hooks = await channel.fetchWebhooks();
    let maxIdx = 0;
    for (const [, hook] of hooks) {
      const m = /^Logbird-(\d+)$/.exec(hook.name || '');
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > maxIdx) maxIdx = n;
      }
    }
    return `Logbird-${maxIdx + 1}`;
  } catch (_) {
    return 'Logbird-1';
  }
}

module.exports = {
  data: {
    name: 'logbird',
    description: 'Create paired webhooks (logs + data) and return a base64 bundle (role-restricted)',
  },
  async execute(interaction) {
    try {
      const settings = loadRawSettings();
      if (!hasAllowedRole(interaction, settings)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
      }
      if (!interaction.guild) {
        return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      }

      // Respect enable/disable flag from settings.json (default: enabled)
      if (settings.logbirdEnabled === false) {
        return interaction.reply({ content: 'Issuing of webhooks is currently disabled by an admin.', ephemeral: true });
      }

      // Security: require invoker's name to match a player in squadron_data.json
      const snap = readLatestSquadronSnapshot();
      const rows = (snap && snap.data && Array.isArray(snap.data.rows) && snap.data.rows.length)
        ? snap.data.rows
        : (Array.isArray(snap?.rows) ? snap.rows : []);
      if (!rows || rows.length === 0) {
        return interaction.reply({ content: 'Cannot verify identity: no squadron data available yet.', ephemeral: true });
      }
      const invokerName = getInvokerDisplayName(interaction);
      const match = bestMatchPlayer(rows, invokerName);
      const invNorm = normalizeName(invokerName);
      const exact = match && match.row && normalizeName(match.row.Player || match.row.player || '') === invNorm;
      const acceptable = !!match && (exact || match.tier <= 3 && match.normD <= 0.5);
      if (!acceptable) {
        return interaction.reply({ content: `Access denied: your name "${invokerName}" could not be matched to any player in the latest squadron data. Please set your server nickname to your in-game name and try again.`, ephemeral: true });
      }
      const matchedPlayerName = (match && match.row && (match.row.Player || match.row.player)) ? String(match.row.Player || match.row.player) : invokerName;

      // Resolve channels
      const logsChannel = await resolveLogsChannel(interaction, settings);
      const dataChannel = await resolveDataChannel(interaction, settings);
      if (!logsChannel || !dataChannel) {
        return interaction.reply({ content: 'Could not resolve both channels. Ensure discordLogsChannel and discordDataChannel are configured in settings.json.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      // Create paired webhooks managed together
      let pair;
      try {
        pair = await webhookManager.createPairedInChannels(
          logsChannel,
          dataChannel,
          makeLogbirdNameForUser(interaction)
        );
      } catch (e) {
        return interaction.editReply(`Failed to create paired webhooks: ${e && e.message ? e.message : e}`);
      }

      // Determine TTL minutes from settings
      let ttl = Number((settings && settings.logbirdAutoDeleteMinutes));
      if (!Number.isFinite(ttl) || ttl <= 0) ttl = 60;
      ttl = Math.max(5, Math.min(10080, Math.floor(ttl)));

      // Build keyed bundle using matched in-game name
      const plainJson = JSON.stringify(pair.payload);
      const keyedToken = encryptWithPlayerName(plainJson, matchedPlayerName);
      if (!keyedToken) {
        return interaction.editReply('Failed to encode bundle with player key.');
      }

      const embed = new EmbedBuilder()
        .setTitle('Logbird Paired Webhooks Created')
        .setColor(0x00AE86)
        .addFields(
          { name: 'Pair ID', value: pair.pairId, inline: false },
          { name: 'Matched Player', value: matchedPlayerName, inline: false },
          { name: 'Keyed Bundle', value: '```\n' + keyedToken + '\n```', inline: false }
        )
        .setFooter({ text: `Auto-deletes after ${ttl} minutes of inactivity.` });

      return interaction.editReply({ embeds: [embed], ephemeral: true });
    } catch (e) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('There was an error creating the webhook.');
        } else {
          await interaction.reply({ content: 'There was an error creating the webhook.', ephemeral: true });
        }
      } catch (_) {}
    }
  }
};
