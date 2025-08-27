// src/commands/settings.js
const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { loadSettings } = require('../config');
const { setDiscordChannel, reconfigureWaitingVoiceChannel, setLogsChannel, setWinLossChannel } = require('../discordBot');

function readJsonSettings() {
  const file = path.join(process.cwd(), 'settings.json');
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (_) { return {}; }
}

function writeJsonSettings(patch) {
  const file = path.join(process.cwd(), 'settings.json');
  const base = readJsonSettings();
  const next = { ...base, ...patch };
  try { fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8'); } catch (_) {}
}

function cleanChannelInput(raw) {
  const s = String(raw || '').trim();
  // Extract raw ID from <#123> or <@123>
  const mention = s.match(/^<[#@&]?(\d{10,})>$/);
  if (mention) return mention[1];
  return s;
}

async function buildPanel() {
  const cfg = loadSettings();
  const em = new EmbedBuilder()
    .setTitle('Settings Control Panel')
    .setDescription('Manage bot settings, determining the location of output messages.')
    .setColor(0x3ba55d)
    .addFields(
      { name: 'discordChannel (bot technical messages)', value: String(cfg.discordChannel || ''), inline: false },
      { name: 'waitingVoiceChannel', value: String(cfg.waitingVoiceChannel || ''), inline: false },
      { name: 'squadronPageUrl', value: String(cfg.squadronPageUrl || ''), inline: false },
      { name: 'discordLogsChannel (player logs)', value: String(cfg.discordLogsChannel || ''), inline: false },
      { name: 'discordWinLossChannell (win/loss logs)', value: String(cfg.discordWinLossChannell || ''), inline: false },
      { name: 'metalistManager (allowed roles)', value: String(cfg.metalistManager?.roles?.join(', ') || '@everyone'), inline: false },
    );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_set_dc').setLabel('Set discordChannel').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cfg_set_wvc').setLabel('Set waitingVoiceChannel').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_set_url').setLabel('Set squadronPageUrl').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cfg_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_set_logs').setLabel('Set discordLogsChannel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg_set_wl').setLabel('Set discordWinLossChannell').setStyle(ButtonStyle.Secondary),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_set_mr').setLabel('Set Metalist Roles').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [em], components: [row1, row2, row3, row4] };
}

module.exports = {
  data: {
    name: 'settings',
    description: 'View and edit core settings (channel, waiting voice, squadron URL)',
    options: [
      { type: 1, name: 'panel', description: 'Show Settings control panel with interactive buttons' },
    ],
  },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub !== 'panel') {
      await interaction.reply({ content: 'Use /settings panel', flags: MessageFlags.Ephemeral });
      return;
    }
    const payload = await buildPanel();
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  },
  async handleComponent(interaction) {
    if (!(interaction.isButton() || interaction.isModalSubmit())) return false;
    const id = interaction.customId || '';
    if (!(id.startsWith('cfg_') || id === 'cfg_modal_dc' || id === 'cfg_modal_wvc' || id === 'cfg_modal_url')) return false;
    try {
      if (interaction.isButton() && id === 'cfg_set_dc') {
        const modal = new ModalBuilder().setCustomId('cfg_modal_dc').setTitle('Set DISCORD_CHANNEL');
        const input = new TextInputBuilder()
          .setCustomId('cfg_dc_value')
          .setLabel('Channel ID or mention (e.g., #channel)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isModalSubmit() && id === 'cfg_modal_dc') {
        const raw = (interaction.fields.getTextInputValue('cfg_dc_value') || '').trim();
        const val = cleanChannelInput(raw);
        writeJsonSettings({ discordChannel: val });
        await setDiscordChannel(val);
        const payload = await buildPanel();
        await interaction.reply({ ...payload, content: 'DISCORD_CHANNEL updated and applied.', flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isButton() && id === 'cfg_set_wvc') {
        const modal = new ModalBuilder().setCustomId('cfg_modal_wvc').setTitle('Set WAITING_VOICE_CHANNEL');
        const input = new TextInputBuilder()
          .setCustomId('cfg_wvc_value')
          .setLabel('Voice channel ID or mention')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isModalSubmit() && id === 'cfg_modal_wvc') {
        const raw = (interaction.fields.getTextInputValue('cfg_wvc_value') || '').trim();
        const val = cleanChannelInput(raw);
        writeJsonSettings({ waitingVoiceChannel: val });
        await reconfigureWaitingVoiceChannel(val);
        const payload = await buildPanel();
        await interaction.reply({ ...payload, content: 'WAITING_VOICE_CHANNEL updated and applied.', flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isButton() && id === 'cfg_set_url') {
        const modal = new ModalBuilder().setCustomId('cfg_modal_url').setTitle('Set SQUADRON_PAGE_URL');
        const input = new TextInputBuilder()
          .setCustomId('cfg_url_value')
          .setLabel('URL (https://...)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isButton() && id === 'cfg_set_logs') {
        const modal = new ModalBuilder().setCustomId('cfg_modal_logs').setTitle('Set discordLogsChannel');
        const input = new TextInputBuilder()
          .setCustomId('cfg_logs_value')
          .setLabel('Channel ID or mention (e.g., #logs)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isModalSubmit() && id === 'cfg_modal_logs') {
        const raw = (interaction.fields.getTextInputValue('cfg_logs_value') || '').trim();
        const val = cleanChannelInput(raw);
        writeJsonSettings({ discordLogsChannel: val });
        await setLogsChannel(val);
        const payload = await buildPanel();
        await interaction.reply({ ...payload, content: 'discordLogsChannel updated and applied.', flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isButton() && id === 'cfg_set_wl') {
        const modal = new ModalBuilder().setCustomId('cfg_modal_wl').setTitle('Set discordWinLossChannell');
        const input = new TextInputBuilder()
          .setCustomId('cfg_wl_value')
          .setLabel('Channel ID or mention (e.g., #wins-losses)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isModalSubmit() && id === 'cfg_modal_wl') {
        const raw = (interaction.fields.getTextInputValue('cfg_wl_value') || '').trim();
        const val = cleanChannelInput(raw);
        writeJsonSettings({ discordWinLossChannell: val });
        await setWinLossChannel(val);
        const payload = await buildPanel();
        await interaction.reply({ ...payload, content: 'discordWinLossChannell updated and applied.', flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isModalSubmit() && id === 'cfg_modal_url') {
        const raw = (interaction.fields.getTextInputValue('cfg_url_value') || '').trim();
        writeJsonSettings({ squadronPageUrl: raw });
        const payload = await buildPanel();
        await interaction.reply({ ...payload, content: 'SQUADRON_PAGE_URL updated.', flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isButton() && id === 'cfg_refresh') {
        const payload = await buildPanel();
        await interaction.update({ ...payload, content: 'Refreshed.' });
        return true;
      }

      if (interaction.isButton() && id === 'cfg_set_mr') {
        const modal = new ModalBuilder().setCustomId('cfg_modal_mr').setTitle('Set Metalist Roles');
        const input = new TextInputBuilder()
          .setCustomId('cfg_mr_value')
          .setLabel('Role IDs or names, comma-separated')
          .setStyle(TextInputStyle.Short)
          .setRequired(false); // Allow empty to clear
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isModalSubmit() && id === 'cfg_modal_mr') {
        const raw = (interaction.fields.getTextInputValue('cfg_mr_value') || '').trim();
        const roles = raw.split(',').map(r => r.trim()).filter(Boolean);
        writeJsonSettings({ metalistManager: { roles } });
        const payload = await buildPanel();
        await interaction.reply({ ...payload, content: 'Metalist roles updated.', flags: MessageFlags.Ephemeral });
        return true;
      }
    } catch (e) {
      try { await interaction.reply({ content: 'Error handling action.', flags: MessageFlags.Ephemeral }); } catch (_) {}
    }
    return false;
  }
};
