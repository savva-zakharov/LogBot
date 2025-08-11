// src/commands/marco.js
module.exports = {
  data: {
    name: 'marco',
    description: 'Responds with Polo!',
  },
  async execute(interaction) {
    await interaction.reply('Polo!');
  },
};
