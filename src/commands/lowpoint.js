// src/commands/lowpoint.js
const { MessageFlags } = require('discord.js');
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
    ],
  },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    try {
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
  }
};
