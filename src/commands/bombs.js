// src/commands/bombs.js
const { EmbedBuilder } = require('discord.js');

module.exports = {
  data: {
    name: 'bombs',
    description: 'Link to the bombs spreadsheet',
  },
  async execute(interaction) {
    const url = 'https://docs.google.com/spreadsheets/u/0/d/1MRIUI0kbGzS3-qvJGZGWk-BN4crV_z8uHzug82ho4Sg/htmlview';
    const embed = new EmbedBuilder()
      .setTitle('Bombs Spreadsheet')
      .setDescription(`[Open the sheet](${url})`)
      .setColor(0x00AE86);
    await interaction.reply({ embeds: [embed] });
  },
};
