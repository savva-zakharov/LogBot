// src/commands/version.js
const { exec } = require('child_process');

module.exports = {
  data: {
    name: 'version',
    description: 'Replies with the latest commit hash.'
  },
  async execute(interaction) {
    exec('git rev-parse HEAD', (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        interaction.reply({ content: 'Error getting version information.', ephemeral: true });
        return;
      }
      interaction.reply({ content: `${stdout.trim()}`, ephemeral: true });
    });
  }
};
