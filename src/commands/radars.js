// src/commands/radars.js
const { EmbedBuilder } = require('discord.js');

module.exports = {
  data: {
    name: 'radars',
    description: 'Link to the radars spreadsheet',
  },
  async execute(interaction) {
    const url = 'https://docs.google.com/spreadsheets/u/0/d/1BsKs7X5Lx2eG292maWZizNiXC_AJ5YZGlEitjUSEbZE/htmlview#gid=1505987574';
    const embed = new EmbedBuilder()
      .setTitle('Radars Spreadsheet')
      .setDescription(`[Open the sheet](${url})`)
      .setColor(0xd0463c);
    await interaction.reply({ embeds: [embed] });
  },
};
