// src/commands/uploadmetalist.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const metalistManager = require('../utils/metalistManager');
const https = require('https');
const { loadSettings } = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('metamanage')
    .setDescription('Upload a new metalist CSV file.')
    .addAttachmentOption(option =>
      option.setName('csvfile')
        .setDescription('The .csv file to upload.')
        .setRequired(true)),
  async execute(interaction) {
    try {
      const settings = loadSettings();
      const allowedRoles = settings.metalistManager?.roles || [];

      // Security check
      const isOwner = (process.env.BOT_OWNER_ID || process.env.OWNER_ID) === interaction.user.id;
      const isAdmin = interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
      const hasRole = allowedRoles.length === 0 ? true : interaction.member.roles.cache.some(role => allowedRoles.includes(role.id) || allowedRoles.includes(role.name));

      if (!isOwner && !isAdmin && !hasRole) {
        return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
      }

      await interaction.deferReply();

      const attachment = interaction.options.getAttachment('csvfile');

      if (!attachment.name.endsWith('.csv')) {
        return interaction.editReply({ content: 'Please upload a .csv file.', ephemeral: true });
      }

      // Download the file
      const tempDir = path.join(process.cwd(), '.tmp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempFilePath = path.join(tempDir, attachment.name);
      const file = fs.createWriteStream(tempFilePath);

      https.get(attachment.url, (response) => {
        response.pipe(file);
        file.on('finish', async () => {
          file.close();

          // Process the new file
          const result = await metalistManager.loadFromNewFile(tempFilePath);

          // Clean up the temp file
          fs.unlinkSync(tempFilePath);

          await interaction.editReply({ content: result.message, ephemeral: !result.success });
        });
      }).on('error', (err) => {
        fs.unlinkSync(tempFilePath);
        console.error('Error downloading attachment:', err);
        interaction.editReply({ content: 'Failed to download the attachment.', ephemeral: true });
      });

    } catch (e) {
      console.error('Error executing uploadmetalist command:', e);
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: 'An error occurred while executing the command.', ephemeral: true });
      } else {
        await interaction.reply({ content: 'An error occurred while executing the command.', ephemeral: true });
      }
    }
  }
};