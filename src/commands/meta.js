const { EmbedBuilder } = require('discord.js');
const metalistManager = require('../utils/metalistManager');
const { getTodaysBr } = require('../utils/brHelper');

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
      const requestedBR = interaction.options.getString('battle_rating');
      const availableBRs = metalistManager.getAvailableBRs();
      let br = requestedBR;
      let metaData;

      if (br) {
        // Try to find a matching BR, converting formats if necessary
        if (availableBRs.includes(br)) {
          metaData = metalistManager.getMetalist(br);
        } else {
          const alternativeBr = br.endsWith('.0')
            ? br.slice(0, -2)
            : (Number.isInteger(Number(br)) ? `${br}.0` : null);
          
          if (alternativeBr && availableBRs.includes(alternativeBr)) {
            br = alternativeBr;
            metaData = metalistManager.getMetalist(br);
          }
        }
      }

      // If no BR was requested, or if the requested one was not found, use the latest.
      if (!metaData) {
        const requestedBR = getTodaysBr() || metalistManager.getLatestBR();
        if (requestedBR) {
            br = requestedBR;
            metaData = metalistManager.getMetalist(br);
        }
      }

      if (!metaData) {
        return interaction.editReply(
          `❌ No metalist data found for BR ${requestedBR || 'any'}. ` +
          `Available BRs: ${availableBRs.join(', ') || 'None'}`
        );
      }

      // Create the embed
      const embed = new EmbedBuilder()
        .setTitle(`War Thunder Meta - ${br} BR`)
        .setColor(0x00AE86)
        .setTimestamp()

      // Add fields for each category
      const ratingColors = {
        'Meta': '36', // Blue
        'Good': '32', // Green
        'Okay': '33', // Yellow
        'Acceptable': '33', // Yellow
        'Skill Based': '31', // Red
        'Unrated': '37' // White
      };

      for (const [category, ratings] of Object.entries(metaData)) {
        let fieldValue = '';

        //check for max rating name length
        let maxRatingNameLength = 0;
        for (const [rating, code] of Object.entries(ratingColors)) {
          if (rating.length > maxRatingNameLength) {
            maxRatingNameLength = rating.length;
          }
        }
        
        // Add each rating (Meta, Good, etc.) and its vehicles
        for (const [rating, vehicles] of Object.entries(ratings)) {
          if (vehicles) {
            let colorCode = '37';
            let ratingName = rating;

            for (const [colorKey, code] of Object.entries(ratingColors)) {
              if (rating.toLowerCase().includes(colorKey.toLowerCase())) {
                colorCode = code;
                ratingName = colorKey;
                break;
              }
            }
            fieldValue += `\u001b[0;${colorCode}m${ratingName.padEnd(maxRatingNameLength, ' ')}: ${vehicles}\u001b[0m\n`;
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
