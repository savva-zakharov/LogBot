// src/commands/logbird.js
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const webhookManager = require('../webhookManager');

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

function makeLogbirdNameForUser(interaction) {
  const uname = (interaction && interaction.member && interaction.member.displayName)
    || (interaction && interaction.user && (interaction.user.globalName || interaction.user.username))
    || 'User';
  // Discord webhook name max length is 80 chars
  const name = `Logbird-${String(uname)}`;
  return name.length > 80 ? name.slice(0, 80) : name;
}

function normalizeId(input) {
  return String(input || '').replace(/[^0-9]/g, '');
}

async function resolveLogsChannel(interaction, settings) {
  if (!interaction.guild) return null;
  const raw = (settings && settings.discordLogsChannel) ? String(settings.discordLogsChannel).trim() : '';
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
    description: 'Create a temporary webhook in the logs channel (role-restricted)',
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

      const channel = await resolveLogsChannel(interaction, settings);
      if (!channel) {
        return interaction.reply({ content: 'Logs channel is not configured or could not be resolved.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const name = makeLogbirdNameForUser(interaction);
      let hook;
      try {
        hook = await channel.createWebhook({ name, avatar: AVATAR_URL, reason: 'Logbird request' });
      } catch (e) {
        return interaction.editReply(`Failed to create webhook: ${e && e.message ? e.message : e}`);
      }

      try { await webhookManager.registerCreated({
        id: hook.id,
        token: hook.token,
        url: hook.url,
        name: hook.name,
        channelId: hook.channelId,
        guildId: hook.guildId,
      }); } catch (_) {}

      // Determine TTL minutes from settings
      let ttl = Number((settings && settings.logbirdAutoDeleteMinutes));
      if (!Number.isFinite(ttl) || ttl <= 0) ttl = 60;
      ttl = Math.max(5, Math.min(10080, Math.floor(ttl)));

      const embed = new EmbedBuilder()
        .setTitle('Logbird Webhook Created')
        .setColor(0x00AE86)
        .addFields(
          { name: 'Name', value: hook.name || '—', inline: true },
          { name: 'ID', value: String(hook.id), inline: true },
          { name: 'Channel', value: `<#${hook.channelId}>`, inline: true },
          { name: 'URL', value: hook.url || '—' },
          { name: 'Token', value: hook.token ? `||${hook.token}||` : '(no token)' }
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
