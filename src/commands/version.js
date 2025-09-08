// src/commands/version.js
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = {
  data: {
    name: 'version',
    description: 'Replies with the bot\'s version and latest commit hash.'
  },
  async execute(interaction) {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    fs.readFile(packageJsonPath, 'utf8', (err, data) => {
      if (err) {
        console.error(`readFile error: ${err}`);
        interaction.reply({ content: 'Error getting version information.', ephemeral: true });
        return;
      }
      const packageJson = JSON.parse(data);
      const version = packageJson.version;

      exec('git rev-parse HEAD', (error, stdout, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          interaction.reply({ content: 'Error getting version information.', ephemeral: true });
          return;
        }
        interaction.reply({ content: `Version: ${version}\nCommit: ${stdout.trim()}`, ephemeral: true });
      });
    });
  }
};

