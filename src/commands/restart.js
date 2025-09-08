// src/commands/restart.js
const { PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { exec } = require("child_process");

module.exports = {
  data: {
    name: 'restart',
    description: 'Restarts the bot (owner/admin only)'
  },
  async execute(interaction) {
    try {
      // Security: allow only owner if configured, otherwise require Administrator
      const OWNER_ID = process.env.BOT_OWNER_ID || process.env.OWNER_ID || '';

      // If in a guild, we can check admin perms; in DMs this will be undefined
      const isAdmin = interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator);

      if (OWNER_ID) {
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: 'You are not allowed to run this command.', ephemeral: true });
        }
      } else {
        if (!isAdmin) {
          return interaction.reply({ content: 'Administrator permission required to run this command.', ephemeral: true });
        }
      }

      await interaction.reply({ content: 'Restarting bot...', ephemeral: true });

      const flagPath = path.join(process.cwd(), 'restart.flag');
      fs.writeFileSync(flagPath, new Date().toISOString());

      exec("pm2 restart LogBotDev", (error, stdout, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          interaction.followUp({ content: `stderr: ${error}`, ephemeral: true });
          return;
        }
        console.log(`stdout: ${stdout}`);
        console.error(`stderr: ${stderr}`);
        interaction.followUp({ content: `stderr: ${stderr}`, ephemeral: true });
      });

    } catch (e) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('There was an error executing this command.');
        } else {
          await interaction.reply({ content: 'There was an error executing this command.', ephemeral: true });
        }
      } catch (_) {}
    }
  }
};
