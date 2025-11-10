// src/commands/marco.js
const { MessageFlags, EmbedBuilder } = require('discord.js');

module.exports = {
  data: {
    name: 'marco',
    description: 'Responds with Polo!',
  },
  async execute(interaction) {
    //await interaction.reply('Polo!');


    let body = 'This is a test of colours \n';
    for (let p = 0; p < 10; p++) {
      for (let o = 3; o < 5; o++) {
        for (let i = 0; i < 8; i++) {
          body += `\u001b[${p};${o}${i}m` + p + ':' + o + i + '\u001b[0m  ';
        }
        body += '\n';
      }
    }
    
    // for (let o = 0; o < 10; o++) {
    //   for (let i = 0; i < 8; i++) {
    //     body += `\u001b[1;${o}${i}m` +'1:' + o + i + '\u001b[0m  ';
    //   }
    //   body += '\n';
    // }
    
    const embed = new EmbedBuilder()
      .setTitle('Marcos Test')
      .setDescription('```ansi\n' + body + '\n```')
      .setColor(0x57F287)
      .setTimestamp(new Date());

    await interaction.reply({ embeds: [embed] });
  },
};
