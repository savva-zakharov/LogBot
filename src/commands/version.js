// src/commands/version.js
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = {
  data: {
    name: 'version',
    description: 'Replies with the bot\'s version, latest commit hash, and message.'
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

      exec('git log -1 --pretty=format:"%H%n%s"', (error, stdout, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          interaction.reply({ content: 'Error getting version information.', ephemeral: true });
          return;
        }
        const lines = stdout.trim().split('\n');
        const commitHash = lines[0];
        const commitMessage = lines.slice(1).join('\n');
        interaction.reply({ content: `\`\`\`Version: ${version}\nCommit: ${commitHash}\nMessage: ${commitMessage}\`\`\``, ephemeral: true });
      });
    });
  }
};

