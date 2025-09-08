// src/commands/restart.js

const { PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { exec } = require("child_process");
const { isAuthorized } = require('../utils/permissions');


module.exports = {
  data: new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restarts the bot (admins or owner only).'),
  async execute(interaction) {

    try {
      // Security: allow only owner if configured, otherwise require Administrator
    if (!isAuthorized(interaction)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

      await interaction.reply({ content: 'Restarting bot...', ephemeral: true });

      const flagPath = path.join(process.cwd(), 'restart.flag');
      fs.writeFileSync(flagPath, new Date().toISOString());

      exec("pm2 restart LogBot", (error, stdout, stderr) => {
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
    await interaction.reply({ content: 'Restarting...', ephemeral: true });
    // This is a simple way to restart; for more complex setups, consider process managers
    process.exit(1);
  },
};
