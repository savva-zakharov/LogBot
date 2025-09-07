// src/commands/restart.js
const { SlashCommandBuilder } = require('discord.js');
const { isAuthorized } = require('../utils/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restarts the bot (admins or owner only).'),
  async execute(interaction) {
    if (!isAuthorized(interaction)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }
    await interaction.reply({ content: 'Restarting...', ephemeral: true });
    // This is a simple way to restart; for more complex setups, consider process managers
    process.exit(1);
  },
};
