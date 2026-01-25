// src/commands/missiles.js
const { EmbedBuilder } = require('discord.js');

module.exports = {
  data: {
    name: 'missiles',
    description: 'Link to the missiles spreadsheet',
  },
  async execute(interaction) {
    const url = 'https://docs.google.com/spreadsheets/d/1SsOpw9LAKOs0V5FBnv1VqAlu3OssmX7DJaaVAUREw78/edit?gid=1624345539#gid=1624345539';
    const embed = new EmbedBuilder()
      .setTitle('Missiles Spreadsheet')
      .setDescription(`[Open the sheet](${url})`)
      .setColor(0xd0463c);
    await interaction.reply({ embeds: [embed] });
  },
};
