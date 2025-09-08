// src/commands/logbirdmanage.js
const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const webhookManager = require('../webhookManager');
const { isAuthorized } = require('../utils/permissions');

function loadRawSettings() {
  try {
    const file = path.join(process.cwd(), 'settings.json');
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

function saveRawSettings(obj) {
  try {
    const file = path.join(process.cwd(), 'settings.json');
    fs.writeFileSync(file, JSON.stringify(obj || {}, null, 2), 'utf8');
    return true;
  } catch (_) { return false; }
}



function fmtId(id) { return id ? (String(id).slice(0, 6) + '...' + String(id).slice(-4)) : ''; }
function fmtCh(id) { return id ? ('#' + String(id).slice(-4)) : ''; }

function buildPanel(userId) {
  const items = webhookManager.list();
  const count = items.length;
  const settings = loadRawSettings();
  const enabled = settings.logbirdEnabled !== false; // default enabled unless explicitly false
  const roles = Array.isArray(settings.logbirdRoles) ? settings.logbirdRoles : [];
  const minutes = (() => {
    let m = Number(settings.logbirdAutoDeleteMinutes);
    if (!Number.isFinite(m) || m <= 0) m = 60;
    m = Math.max(1, Math.min(10080, Math.floor(m)));
    return m;
  })();
  const embed = new EmbedBuilder()
    .setTitle('Logbird Webhook Manager')
    .setDescription(count ? 'Manage Logbird' : 'No webhooks found.')
    .setColor(count ? 0x00AE86 : 0x808080)
    .addFields(
      count
        ? [
            {
              name: `Current Webhooks (${Math.min(25, count)} shown)`,
              value: items
                .slice(0, 25)
                .map((w) => `• ${w.name || 'Logbird'} — ${fmtId(w.id)} in ${fmtCh(w.channelId)}`)
                .join('\n'),
            },
          ]
        : []
    )
    .addFields(
      {
        name: 'Issuing Status',
        value: enabled ? 'Enabled' : 'Disabled',
        inline: true,
      },
      {
        name: 'Allowed Roles (/logbird)',
        value: roles.length ? roles.map(r => `@${r}`).join(', ').slice(0, 1024) : '(none set) — Admins always allowed',
        inline: false,
      },
      { name: 'discordLogsChannel', value: String(settings.discordLogsChannel || '(not set)'), inline: false },
      { name: 'discordDataChannel', value: String(settings.discordDataChannel || '(not set)'), inline: false }
    )
    .setFooter({ text: `${count > 25 ? `+${count - 25} more not shown  •  ` : ''}Auto-delete: ${minutes}m` });

  let select;
  if (count > 0) {
    const shown = items.slice(0, 25);
    select = new StringSelectMenuBuilder()
      .setCustomId(`lbm_select:${userId}`)
      .setPlaceholder('Select webhook(s) to delete')
      .setMinValues(1)
      .setMaxValues(Math.min(25, shown.length))
      .addOptions(shown.map(w => ({
        label: (w.name || 'Logbird').slice(0, 80),
        description: `Delete ${fmtId(w.id)} in ${fmtCh(w.channelId)}`,
        value: String(w.id),
      })));
  } else {
    // Discord requires 1-25 options; provide a disabled placeholder
    select = new StringSelectMenuBuilder()
      .setCustomId(`lbm_select:${userId}`)
      .setPlaceholder('No webhooks available')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions([{ label: 'No webhooks', description: 'Nothing to select', value: 'none' }])
      .setDisabled(true);
  }

  const rows = [];
  rows.push(new ActionRowBuilder().addComponents(select));
  // Settings control: open modal for TTL entry
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lbm_open_ttl:${userId}`).setLabel('Set Auto-delete (minutes)').setStyle(ButtonStyle.Primary)
  ));

  // Enable/Disable and Roles controls
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lbm_enable_webhooks:${userId}`).setLabel('Enable Issuing').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`lbm_disable_webhooks:${userId}`).setLabel('Disable Issuing').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`lbm_set_roles:${userId}`).setLabel('Set /logbird Roles').setStyle(ButtonStyle.Secondary),
  ));

  // Channel configuration controls
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lbm_set_logs_channel:${userId}`).setLabel('Set Logs Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`lbm_set_data_channel:${userId}`).setLabel('Set Data Channel').setStyle(ButtonStyle.Secondary),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lbm_refresh:${userId}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`lbm_delete_all:${userId}`).setLabel('Delete All').setStyle(ButtonStyle.Danger).setDisabled(count === 0),
    new ButtonBuilder().setCustomId(`lbm_close:${userId}`).setLabel('Close').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components: rows };
}

function notYourPanel(interaction) {
  try {
    const id = (interaction.customId || '').split(':')[1];
    return id && id !== interaction.user.id;
  } catch (_) { return false; }
}

module.exports = {
  data: {
    name: 'logbirdmanage',
    description: 'Manage Logbird webhooks (admins or owner only)',
  },
  async execute(interaction) {
    if (!isAuthorized(interaction)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }
    const panel = buildPanel(interaction.user.id);
    return interaction.reply({ ...panel, ephemeral: true });
  },
  async handleComponent(interaction) {
    if (!isAuthorized(interaction)) {
      try {
        await interaction.reply({ content: 'You do not have permission to use this component.', ephemeral: true });
      } catch (e) {
        // ignore if we cannot reply
      }
      return;
    }
    try {
      if (!interaction || !interaction.customId || notYourPanel(interaction)) return false;
      const [key, ownerId] = interaction.customId.split(':');
      if (!key || !ownerId) return false;

      if (key === 'lbm_select') {
        const values = interaction.values || [];
        let ok = 0; let fail = 0;
        for (const id of values) {
          try { const res = await webhookManager.deleteById(id, `manage by ${interaction.user.id}`); if (res) ok++; else fail++; }
          catch (_) { fail++; }
        }
        const panel = buildPanel(ownerId);
        const msg = `Deleted ${ok} webhook(s).${fail ? ' Failed: ' + fail : ''}`;
        try { await interaction.update({ content: panel.content + `\n\n${msg}`, components: panel.components }); } catch (_) {}
        return true;
      }

      if (key === 'lbm_delete_all') {
        try { await webhookManager.endSessionDeleteAll(`manage delete all by ${interaction.user.id}`); } catch (_) {}
        const panel = buildPanel(ownerId);
        try { await interaction.update(panel); } catch (_) {}
        return true;
      }

      if (key === 'lbm_open_ttl') {
        const modal = new ModalBuilder()
          .setCustomId(`lbm_setttl_modal:${ownerId}`)
          .setTitle('Set Auto-delete (minutes)');
        const input = new TextInputBuilder()
          .setCustomId('lbm_ttl_input')
          .setLabel('Minutes (1 to 10080)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 60')
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        try { await interaction.showModal(modal); } catch (_) {}
        return true;
      }

      if (key === 'lbm_setttl_modal') {
        const v = interaction.fields && interaction.fields.getTextInputValue ? interaction.fields.getTextInputValue('lbm_ttl_input') : '';
        const sel = Number(v);
        const settings = loadRawSettings();
        if (Number.isFinite(sel) && sel > 0) {
          settings.logbirdAutoDeleteMinutes = Math.max(1, Math.min(10080, Math.floor(sel)));
          saveRawSettings(settings);
        }
        const panel = buildPanel(ownerId);
        try { await interaction.reply({ ...panel, ephemeral: true }); } catch (_) {}
        return true;
      }

      // Open modal to set discordLogsChannel
      if (key === 'lbm_set_logs_channel') {
        const modal = new ModalBuilder()
          .setCustomId(`lbm_logs_modal:${ownerId}`)
          .setTitle('Set discordLogsChannel');
        const input = new TextInputBuilder()
          .setCustomId('lbm_logs_input')
          .setLabel('Logs channel (ID, #name, or guildId/channelId)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 123456789012345678 or #logs or 123.../456...')
          .setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        try { await interaction.showModal(modal); } catch (_) {}
        return true;
      }

      // Open modal to set discordDataChannel
      if (key === 'lbm_set_data_channel') {
        const modal = new ModalBuilder()
          .setCustomId(`lbm_data_modal:${ownerId}`)
          .setTitle('Set discordDataChannel');
        const input = new TextInputBuilder()
          .setCustomId('lbm_data_input')
          .setLabel('Data channel (ID, #name, or guildId/channelId)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 123456789012345678 or #data or 123.../456...')
          .setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        try { await interaction.showModal(modal); } catch (_) {}
        return true;
      }

      // Open modal to set roles
      if (key === 'lbm_set_roles') {
        const modal = new ModalBuilder()
          .setCustomId(`lbm_roles_modal:${ownerId}`)
          .setTitle('Set /logbird Roles');
        const input = new TextInputBuilder()
          .setCustomId('lbm_roles_input')
          .setLabel('Role names (comma-separated)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('e.g. Moderators, Staff, Logbird')
          .setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        try { await interaction.showModal(modal); } catch (_) {}
        return true;
      }

      // Enable issuing of webhooks
      if (key === 'lbm_enable_webhooks') {
        const settings = loadRawSettings();
        settings.logbirdEnabled = true;
        saveRawSettings(settings);
        const panel = buildPanel(ownerId);
        try { await interaction.update(panel); } catch (_) {}
        return true;
      }

      // Disable issuing of webhooks
      if (key === 'lbm_disable_webhooks') {
        const settings = loadRawSettings();
        settings.logbirdEnabled = false;
        saveRawSettings(settings);
        const panel = buildPanel(ownerId);
        try { await interaction.update(panel); } catch (_) {}
        return true;
      }

      

      if (key === 'lbm_roles_modal') {
        const raw = interaction.fields && interaction.fields.getTextInputValue ? interaction.fields.getTextInputValue('lbm_roles_input') : '';
        const list = String(raw || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        const settings = loadRawSettings();
        settings.logbirdRoles = list;
        saveRawSettings(settings);
        const panel = buildPanel(ownerId);
        try { await interaction.reply({ ...panel, ephemeral: true }); } catch (_) {}
        return true;
      }

      // Save discordLogsChannel from modal
      if (key === 'lbm_logs_modal') {
        const raw = interaction.fields && interaction.fields.getTextInputValue ? interaction.fields.getTextInputValue('lbm_logs_input') : '';
        const settings = loadRawSettings();
        settings.discordLogsChannel = String(raw || '').trim();
        saveRawSettings(settings);
        const panel = buildPanel(ownerId);
        try { await interaction.reply({ ...panel, ephemeral: true }); } catch (_) {}
        return true;
      }

      // Save discordDataChannel from modal
      if (key === 'lbm_data_modal') {
        const raw = interaction.fields && interaction.fields.getTextInputValue ? interaction.fields.getTextInputValue('lbm_data_input') : '';
        const settings = loadRawSettings();
        settings.discordDataChannel = String(raw || '').trim();
        saveRawSettings(settings);
        const panel = buildPanel(ownerId);
        try { await interaction.reply({ ...panel, ephemeral: true }); } catch (_) {}
        return true;
      }

      if (key === 'lbm_refresh') {
        const panel = buildPanel(ownerId);
        try { await interaction.update(panel); } catch (_) {}
        return true;
      }

      if (key === 'lbm_close') {
        try { await interaction.update({ content: 'Closed.', components: [] }); } catch (_) {}
        return true;
      }

      return false;
    } catch (_) { return false; }
  }
};
