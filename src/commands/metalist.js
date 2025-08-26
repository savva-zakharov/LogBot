// src/commands/metalist.js
const { EmbedBuilder } = require('discord.js');

module.exports = {
  data: {
    name: 'metalist',
    description: 'Link to the Metalist spreadsheet',
  },
  async execute(interaction) {
    const url = 'https://docs.google.com/spreadsheets/d/1rC94xj1APaSr8DzcR2FXYN-SW8TY7ZgQqS6nNIJCYU4/htmlview#gid=1164085364';
    const embed = new EmbedBuilder()
      .setTitle('Metalist Spreadsheet')
      .setDescription(`[Open the sheet](${url})`)
      .setColor(0x00AE86);
    await interaction.reply({ embeds: [embed] });
  },
};
