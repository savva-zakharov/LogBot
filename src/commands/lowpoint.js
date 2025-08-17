// src/commands/lowpoint.js
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder } = require('discord.js');
const issuer = require('../lowPointsIssuer');

module.exports = {
  data: {
    name: 'lowpoint',
    description: 'Manage low-points role issuing',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'set',
        description: 'Set the low-points threshold (default 1300)',
        options: [
          { type: 4, name: 'value', description: 'Threshold value', required: false }, // INTEGER
        ],
      },
      {
        type: 1,
        name: 'issue',
        description: 'Issue the low-points role to members below threshold',
      },
      {
        type: 1,
        name: 'role',
        description: 'Configure the Discord role by name or ID',
        options: [
          { type: 3, name: 'value', description: 'Role name or ID', required: true }, // STRING
        ],
      },
      {
        type: 1,
        name: 'remove',
        description: 'Remove the low-points role from all members',
      },
      {
        type: 1,
        name: 'start',
        description: 'Enable automatic issuing after each snapshot',
      },
      {
        type: 1,
        name: 'stop',
        description: 'Disable automatic issuing',
      },
      {
        type: 1,
        name: 'list',
        description: 'List members below the threshold from the latest snapshot',
      },
      {
        type: 1,
        name: 'memberrole',
        description: 'Limit matching to members that already have this role',
        options: [
          { type: 3, name: 'value', description: 'Role name or ID', required: true }, // STRING
        ],
      },
      {
        type: 1,
        name: 'panel',
        description: 'Show Low Points control panel with interactive buttons',
      },
    ],
  },
  async buildPanel(guild) {
    const cfg = issuer.getConfig();
    const exclDisp = (cfg.excludeRoles && cfg.excludeRoles.length)
      ? cfg.excludeRoles.join(', ').slice(0, 256)
      : '(none)';
    const roleDisp = cfg.roleId || cfg.roleName || '(not set)';
    const limiterDisp = cfg.memberRoleId || cfg.memberRoleName || '(none)';
    const eligible = guild ? await issuer.computeEligibleCount(guild) : 0;
    const assigned = guild ? await issuer.countAssigned(guild) : 0;
    const em = new EmbedBuilder()
      .setTitle('Low Points Control Panel')
      .setDescription('Manage the low-points role. Use the buttons below to change settings, issue  or remove the roles or enable auto-issuing.')
      .setColor(cfg.enabled ? 0x3ba55d : 0x808080)
      .addFields(
        { name: 'Threshold', value: String(cfg.threshold), inline: true },
        { name: 'Role', value: roleDisp, inline: true },
        { name: 'Eligible Role', value: limiterDisp, inline: true },
        { name: 'Auto Enabled', value: String(!!cfg.enabled), inline: true },
        { name: 'Eligible Now', value: String(eligible), inline: true },
        { name: 'Assigned Now', value: String(assigned), inline: true },
        { name: 'Grace Days', value: String(cfg.graceDays ?? 30), inline: true },
        { name: 'Excluded Roles', value: exclDisp, inline: false },
      );
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('lp_issue').setLabel('Sync').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('lp_remove').setLabel('Remove All').setStyle(ButtonStyle.Danger),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('lp_set_thr').setLabel('Set Threshold').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('lp_set_role').setLabel('Set Role').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('lp_set_limiter').setLabel('Set Included Role').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('lp_set_grace').setLabel('Set Grace').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('lp_set_excluded').setLabel('Set Excluded Roles').setStyle(ButtonStyle.Primary),
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('lp_start').setLabel('Start Auto').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('lp_stop').setLabel('Stop Auto').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('lp_refresh').setLabel('Refresh ui').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('lp_list').setLabel('List Below').setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [em], components: [row1, row2, row3] };
  },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'panel') {
        const payload = await this.buildPanel(interaction.guild);
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === 'set') {
        const val = interaction.options.getInteger('value') ?? 1300;
        const thr = Number(val);
        if (!Number.isFinite(thr) || thr <= 0) {
          await interaction.reply({ content: 'Invalid threshold.', flags: MessageFlags.Ephemeral });
          return;
        }
        issuer.saveConfig({ threshold: thr });
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({ content: `Low-points threshold set to ${thr}. (No guild context to sync)`, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await issuer.issueRolesInGuild(guild);
        if (res.roleMissing) {
          await interaction.editReply({ content: `Threshold set to ${thr}. Role is not configured or could not be found. Use /lowpoint role.` });
          return;
        }
        await interaction.editReply({ content: `Threshold set to ${thr}. Synced low-points role. Added: ${res.added}. Removed: ${res.removed}. Candidates below threshold: ${res.totalCandidates}.` });
        return;
      }
      if (sub === 'role') {
        const value = interaction.options.getString('value');
        if (!value) {
          await interaction.reply({ content: 'Provide a role name or ID.', flags: MessageFlags.Ephemeral });
          return;
        }
        const isId = /^\d{10,}$/.test(value.trim());
        const payload = isId ? { roleId: value.trim(), roleName: null } : { roleName: value.trim(), roleId: null };
        issuer.saveConfig(payload);
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({ content: `Low-points role set to ${isId ? `ID ${payload.roleId}` : `name "${payload.roleName}"`}. (No guild context to sync)`, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await issuer.issueRolesInGuild(guild);
        if (res.roleMissing) {
          await interaction.editReply({ content: `Role set to ${isId ? `ID ${payload.roleId}` : `name "${payload.roleName}"`}, but it could not be fetched. Check permissions or role visibility.` });
          return;
        }
        await interaction.editReply({ content: `Role set to ${isId ? `ID ${payload.roleId}` : `name "${payload.roleName}"`}. Synced low-points role by matching Discord member names to snapshot players. Added: ${res.added}. Removed: ${res.removed}. Candidates below threshold: ${res.totalCandidates}.` });
        return;
      }
      if (sub === 'start') {
        issuer.saveConfig({ enabled: true });
        const cfg = issuer.getConfig();
        await interaction.reply({ content: `Auto-issuing enabled. Threshold=${cfg.threshold}, role=${cfg.roleId || cfg.roleName || '(not set)'}.`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === 'stop') {
        issuer.saveConfig({ enabled: false });
        await interaction.reply({ content: 'Auto-issuing disabled.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === 'issue') {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({ content: 'This command must be used in a guild.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await issuer.issueRolesInGuild(guild);
        if (res.roleMissing) {
          await interaction.editReply({ content: 'Role is not configured or could not be found. Use /lowpoint role.' });
          return;
        }
        await interaction.editReply({ content: `Synced low-points role. Added: ${res.added}. Removed: ${res.removed}. Candidates below threshold: ${res.totalCandidates}.` });
        return;
      }
      if (sub === 'remove') {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({ content: 'This command must be used in a guild.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await issuer.removeRoleInGuild(guild);
        if (res.roleMissing) {
          await interaction.editReply({ content: 'Role is not configured or could not be found. Use /lowpoint role.' });
          return;
        }
        await interaction.editReply({ content: `Removed role from ${res.removed} member(s).` });
        return;
      }
      if (sub === 'list') {
        const cfg = issuer.getConfig();
        const rows = issuer.getRowsBelowThreshold(cfg.threshold);
        if (!rows.length) {
          await interaction.reply({ content: `No members below ${cfg.threshold} in the latest snapshot.`, flags: MessageFlags.Ephemeral });
          return;
        }
        const toNum = (v) => { const s = String(v ?? '').replace(/[^0-9]/g, ''); return s ? parseInt(s, 10) : 0; };
        rows.sort((a,b) => toNum(a['Personal clan rating'] ?? a.rating) - toNum(b['Personal clan rating'] ?? b.rating));
        const lines = rows.map(r => `${r.Player || r.player || '(unknown)'} — ${toNum(r['Personal clan rating'] ?? r.rating)}`);
        // keep within limit
        let content = lines.join('\n');
        const wrapperOverhead = 8;
        const maxLen = 2000 - wrapperOverhead;
        if (content.length > maxLen) content = content.slice(0, maxLen);
        await interaction.reply({ content: '```\n' + content + '\n```' });
        return;
      }
      if (sub === 'memberrole') {
        const value = interaction.options.getString('value');
        if (!value) {
          await interaction.reply({ content: 'Provide a role name or ID.', flags: MessageFlags.Ephemeral });
          return;
        }
        const isId = /^\d{10,}$/.test(value.trim());
        const payload = isId ? { memberRoleId: value.trim(), memberRoleName: null } : { memberRoleName: value.trim(), memberRoleId: null };
        issuer.saveConfig(payload);
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({ content: `Member limiter role set to ${isId ? `ID ${payload.memberRoleId}` : `name "${payload.memberRoleName}"`}. (No guild context to sync)`, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await issuer.issueRolesInGuild(guild);
        if (res.roleMissing) {
          await interaction.editReply({ content: `Limiter set, but low-points role is not configured or could not be found. Use /lowpoint role.` });
          return;
        }
        await interaction.editReply({ content: `Member limiter set to ${isId ? `ID ${payload.memberRoleId}` : `name "${payload.memberRoleName}"`}. Synced low-points role using only members with that role. Added: ${res.added}. Removed: ${res.removed}. Candidates below threshold: ${res.totalCandidates}.` });
        return;
      }
      await interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
    } catch (e) {
      try {
        if (interaction.deferred && !interaction.replied) {
          await interaction.editReply({ content: 'Error executing command.' });
        } else {
          await interaction.reply({ content: 'Error executing command.', flags: MessageFlags.Ephemeral });
        }
      } catch (_) {}
    }
  },
  async handleComponent(interaction) {
    // Handle button clicks and modal submissions for low-points panel
    if (!(interaction.isButton() || interaction.isModalSubmit())) return false;
    const id = interaction.customId || '';
    if (!(id.startsWith('lp_') || id === 'lp_thr_modal')) return false;
    try {
      // Open modal to edit excluded roles
      if (interaction.isButton() && id === 'lp_set_excluded') {
        const cfg = issuer.getConfig();
        const modal = new ModalBuilder()
          .setCustomId('lp_excluded_modal')
          .setTitle('Set Excluded Roles');
        const input = new TextInputBuilder()
          .setCustomId('lp_excluded_value')
          .setLabel('Comma-separated role IDs or names')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder('e.g., 123456789012345678, Officer, Veteran')
          .setValue(Array.isArray(cfg.excludeRoles) && cfg.excludeRoles.length ? cfg.excludeRoles.join(', ') : '');
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      // Save excluded roles from modal
      if (interaction.isModalSubmit() && id === 'lp_excluded_modal') {
        const raw = (interaction.fields.getTextInputValue('lp_excluded_value') || '').trim();
        let list = [];
        if (raw.length) {
          list = raw.split(',').map(s => s.trim()).filter(s => s.length);
        }
        // De-dupe while preserving order
        const seen = new Set();
        const cleaned = [];
        for (const v of list) { const k = v.toLowerCase(); if (!seen.has(k)) { seen.add(k); cleaned.push(v); } }
        issuer.saveConfig({ excludeRoles: cleaned });
        const payload = await this.buildPanel(interaction.guild);
        await interaction.reply({ ...payload, content: `Excluded roles updated (${cleaned.length} item(s)).`, flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isButton() && id === 'lp_set_grace') {
        const cfg = issuer.getConfig();
        const modal = new ModalBuilder()
          .setCustomId('lp_grace_modal')
          .setTitle('Set Low-Points Grace Period');
        const input = new TextInputBuilder()
          .setCustomId('lp_grace_value')
          .setLabel('Grace period (days)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g., 30')
          .setValue(String(cfg.graceDays ?? 30));
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isModalSubmit() && id === 'lp_grace_modal') {
        const raw = (interaction.fields.getTextInputValue('lp_grace_value') || '').trim();
        const days = Number(raw);
        if (!Number.isFinite(days) || days <= 0) {
          await interaction.reply({ content: 'Invalid grace period. Please enter a positive integer number of days.', flags: MessageFlags.Ephemeral });
          return true;
        }
        issuer.saveConfig({ gracePeroid: Math.floor(days) });
        const payload = await this.buildPanel(interaction.guild);
        await interaction.reply({ ...payload, content: `Grace period set to ${Math.floor(days)} day(s).`, flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isButton() && id === 'lp_set_thr') {
        const cfg = issuer.getConfig();
        const modal = new ModalBuilder()
          .setCustomId('lp_thr_modal')
          .setTitle('Set Low-Points Threshold');
        const input = new TextInputBuilder()
          .setCustomId('lp_thr_value')
          .setLabel('Threshold (integer)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g., 1300')
          .setValue(String(cfg.threshold || 1300));
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isModalSubmit() && id === 'lp_thr_modal') {
        const raw = (interaction.fields.getTextInputValue('lp_thr_value') || '').trim();
        const thr = Number(raw);
        if (!Number.isFinite(thr) || thr <= 0) {
          await interaction.reply({ content: 'Invalid threshold. Please enter a positive integer.', flags: MessageFlags.Ephemeral });
          return true;
        }
        issuer.saveConfig({ threshold: Math.floor(thr) });
        await interaction.reply({ content: `Threshold set to ${Math.floor(thr)}. Use the panel\'s Refresh to update.`, flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isButton() && id === 'lp_set_role') {
        const cfg = issuer.getConfig();
        const modal = new ModalBuilder().setCustomId('lp_role_modal').setTitle('Set Low-Points Role');
        const input = new TextInputBuilder()
          .setCustomId('lp_role_value')
          .setLabel('Role name or ID')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g., 123456789012345678 or @RoleName')
          .setValue(String(cfg.roleId || cfg.roleName || ''));
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isModalSubmit() && id === 'lp_role_modal') {
        const raw = (interaction.fields.getTextInputValue('lp_role_value') || '').trim();
        const cleaned = raw.replace(/^<@&?(\d+)>$/, '$1');
        const isId = /^\d{10,}$/.test(cleaned);
        const payload = isId ? { roleId: cleaned, roleName: null } : { roleName: raw, roleId: null };
        issuer.saveConfig(payload);
        await interaction.reply({ content: `Low-points role set to ${isId ? `ID ${payload.roleId}` : `name "${payload.roleName}"`}. Use Issue Sync to apply, then Refresh.`, flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isButton() && id === 'lp_set_limiter') {
        const cfg = issuer.getConfig();
        const modal = new ModalBuilder().setCustomId('lp_limiter_modal').setTitle('Set Limiter Role');
        const input = new TextInputBuilder()
          .setCustomId('lp_limiter_value')
          .setLabel('Role name or ID (optional to clear)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('Leave empty to clear')
          .setValue(String(cfg.memberRoleId || cfg.memberRoleName || ''));
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isModalSubmit() && id === 'lp_limiter_modal') {
        const raw = (interaction.fields.getTextInputValue('lp_limiter_value') || '').trim();
        if (!raw) {
          issuer.saveConfig({ memberRoleId: null, memberRoleName: null });
          await interaction.reply({ content: 'Limiter role cleared. Use Refresh to update.', flags: MessageFlags.Ephemeral });
          return true;
        }
        const cleaned = raw.replace(/^<@&?(\d+)>$/, '$1');
        const isId = /^\d{10,}$/.test(cleaned);
        const payload = isId ? { memberRoleId: cleaned, memberRoleName: null } : { memberRoleName: raw, memberRoleId: null };
        issuer.saveConfig(payload);
        await interaction.reply({ content: `Limiter role set to ${isId ? `ID ${payload.memberRoleId}` : `name "${payload.memberRoleName}"`}. Use Issue Sync to apply, then Refresh.`, flags: MessageFlags.Ephemeral });
        return true;
      }
      if (id === 'lp_issue') {
        const res = await issuer.issueRolesInGuild(interaction.guild, { preferredChannelId: interaction.channelId });
        const payload = await this.buildPanel(interaction.guild);
        await interaction.update({ ...payload, content: `Synced. Added: ${res.added}. Removed: ${res.removed}.` });
        return true;
      }
      if (id === 'lp_remove') {
        const res = await issuer.removeRoleInGuild(interaction.guild, { preferredChannelId: interaction.channelId });
        const payload = await this.buildPanel(interaction.guild);
        await interaction.update({ ...payload, content: `Removed from ${res.removed} member(s).` });
        return true;
      }
      if (id === 'lp_start') {
        issuer.saveConfig({ enabled: true });
        const payload = await this.buildPanel(interaction.guild);
        await interaction.update({ ...payload, content: 'Auto-issuing enabled.' });
        return true;
      }
      if (id === 'lp_stop') {
        issuer.saveConfig({ enabled: false });
        const payload = await this.buildPanel(interaction.guild);
        await interaction.update({ ...payload, content: 'Auto-issuing disabled.' });
        return true;
      }
      if (id === 'lp_list') {
        const details = await issuer.listBelowDetails(interaction.guild);
        const fmtInc = (e) => `${e.display}${e.player ? ` -> ${e.player}` : ''} (${e.rating})`;
        const fmtExc = (e) => `${e.display}${e.player ? ` -> ${e.player}` : ''} (${e.rating}) [${e.reasons.join(', ')}]`;
        const lines = [];
        lines.push(`Matched below-threshold members in guild "${interaction.guild.name}":`);
        lines.push('');
        lines.push(`Included (candidates): ${details.included.length}`);
        lines.push(...(details.included.map(fmtInc)));
        lines.push('');
        lines.push(`Excluded: ${details.excluded.length}`);
        lines.push(...(details.excluded.map(fmtExc)));
        const fullText = lines.join('\n');
        const file = new AttachmentBuilder(Buffer.from(fullText, 'utf8'), { name: 'lowpoints_list.txt' });
        const payload = await this.buildPanel(interaction.guild);
        await interaction.update({ ...payload, content: `Attached full list. Included: ${details.included.length}. Excluded: ${details.excluded.length}.`, files: [file] });
        return true;
      }
      if (id === 'lp_refresh') {
        const payload = await this.buildPanel(interaction.guild);
        await interaction.update({ ...payload, content: 'Refreshed.' });
        return true;
      }
    } catch (e) {
      try { await interaction.reply({ content: 'Error handling action.', flags: MessageFlags.Ephemeral }); } catch (_) {}
    }
    return false;
  }
};
