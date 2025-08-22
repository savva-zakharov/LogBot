// src/commands/logbirdpair.js
const { PermissionFlagsBits, ChannelType, EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const webhookManager = require('../webhookManager');

function loadRawSettings() {
  try {
    const file = path.join(process.cwd(), 'settings.json');
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

function hasAllowedRole(interaction, settings) {
  if (!interaction.guild) return false;
  // Admin is always allowed
  if (interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) return true;
  const roleIds = Array.isArray(settings.logbirdRoleIds) ? settings.logbirdRoleIds.map(String) : [];
  const roleNames = Array.isArray(settings.logbirdRoles) ? settings.logbirdRoles.map(s => String(s).toLowerCase()) : [];
  const roles = interaction.member && interaction.member.roles ? interaction.member.roles : null;
  const cache = roles && roles.cache ? roles.cache : new Map();
  for (const rid of roleIds) { if (cache.has(rid)) return true; }
  for (const [, role] of cache) { if (role && role.name && roleNames.includes(role.name.toLowerCase())) return true; }
  return false;
}

function normalizeId(input) { return String(input || '').replace(/[^0-9]/g, ''); }

async function resolveGuildTextChannelByRaw(interaction, raw) {
  if (!interaction.guild) return null;
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
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
    const id = normalizeId(raw.replace(/^#/, ''));
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('logbirdpair')
    .setDescription('Create paired webhooks (logs + data) and return a base64 bundle of URLs'),
  async execute(interaction) {
    try {
      const settings = loadRawSettings();
      if (!hasAllowedRole(interaction, settings)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
      }
      if (!interaction.guild) {
        return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      }
      // Resolve channels from settings
      const logsRaw = settings.discordWinLossChannell || settings.discordLogsChannel || '';
      const dataRaw = settings.discordDataChannel || '';
      const logsCh = await resolveGuildTextChannelByRaw(interaction, logsRaw);
      const dataCh = await resolveGuildTextChannelByRaw(interaction, dataRaw);
      if (!logsCh || !dataCh) {
        return interaction.reply({ content: 'Could not resolve both channels. Ensure discordWinLossChannell (or discordLogsChannel) and discordDataChannel are configured.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const baseName = `Logbird-${interaction.user.username || interaction.user.id}`;
      const res = await webhookManager.createPairedInChannels(logsCh, dataCh, baseName);
      const embed = new EmbedBuilder()
        .setTitle('Logbird Paired Webhooks Created')
        .setColor(0x00AE86)
        .addFields(
          { name: 'Pair ID', value: res.pairId, inline: false },
          { name: 'Logs URL', value: res.payload.logs, inline: false },
          { name: 'Data URL', value: res.payload.data, inline: false },
          { name: 'Base64 Bundle', value: '```\n' + res.b64 + '\n```', inline: false }
        );
      return interaction.editReply({ embeds: [embed], ephemeral: true });
    } catch (e) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('There was an error creating the paired webhooks.');
        } else {
          await interaction.reply({ content: 'There was an error creating the paired webhooks.', ephemeral: true });
        }
      } catch (_) {}
    }
  }
};
