const { EmbedBuilder } = require('discord.js');
const metalistManager = require('../utils/metalistManager');
const { getTodaysBr } = require('../brHelper');

module.exports = {
  data: {
    name: 'meta',
    description: 'Show the current meta vehicles for a specific battle rating',
    options: [
      {
        name: 'battle_rating',
        type: 3, // STRING
        description: 'The battle rating to show meta for (e.g., 13.0)',
        required: false,
      },
    ],
  },
  
  async execute(interaction) {
    await interaction.deferReply();

    try {
      // Get the requested BR or use the latest available
      const requestedBR = interaction.options.getString('battle_rating');
      const br = requestedBR || getTodaysBr() || metalistManager.getLatestBR();
      
      if (!br) {
        return interaction.editReply('❌ No metalist data available. Please check if the metalist file exists and is properly formatted.');
      }

      const metaData = metalistManager.getMetalist(br);
      
      if (!metaData) {
        const availableBRs = metalistManager.getAvailableBRs().join(', ');
        return interaction.editReply(
          `❌ No metalist data found for BR ${br}. ` +
          `Available BRs: ${availableBRs || 'None'}`
        );
      }

      // Create the embed
      const embed = new EmbedBuilder()
        .setTitle(`War Thunder Meta - ${br} BR`)
        .setColor(0x00AE86)
        .setTimestamp()

      // Add fields for each category
      const ratingColors = {
        'Meta': '34', // Blue
        'Good': '32', // Green
        'Okay': '33', // Yellow
        'Acceptable': '33', // Yellow
        'Situational': '31', // Red (for Orange)
        'Unrated': '37' // White
      };

      for (const [category, ratings] of Object.entries(metaData)) {
        let fieldValue = '';
        
        // Add each rating (Meta, Good, etc.) and its vehicles
        for (const [rating, vehicles] of Object.entries(ratings)) {
          if (vehicles) {
            const colorCode = ratingColors[rating] || '37';
            fieldValue += `\u001b[0;${colorCode}m${rating}: ${vehicles}\u001b[0m\n`;
          }
        }

        if (fieldValue) {
          embed.addFields({
            name: `
${category}`,
            value: '```ansi\n' + fieldValue + '```',
          });
        }
      }

      // Add a note if no specific BR was requested
      if (!requestedBR) {
        const availableBRs = metalistManager.getAvailableBRs();
        if (availableBRs.length > 1) {
          embed.setFooter({
            text: `${embed.data.footer?.text || ''} • Use /meta battle_rating:X.X to see other BRs`,
          });
        }
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Error in /meta command:', error);
      await interaction.editReply('❌ An error occurred while processing your request.');
    }
  },
};
