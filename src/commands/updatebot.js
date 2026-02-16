// src/commands/updatebot.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { isAuthorized } = require('../utils/permissions');

module.exports = {
  data: {
    name: 'updatebot',
    description: 'Runs update scripts to fetch git refs and update npm packages (admins or owner only)'
  },
  async execute(interaction) {
    if (!isAuthorized(interaction)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }
    try {
      await interaction.deferReply({ ephemeral: false });

      const isWindows = process.platform === 'win32';
      const scriptName = isWindows ? 'update-bot.bat' : 'update-bot.sh';
      const scriptPath = path.join(process.cwd(), scriptName);
      
      console.log('[updatebot] Starting update process...');      
      let child;
      if (isWindows) {
        child = spawn('cmd.exe', ['/c', scriptPath], {
          cwd: process.cwd(),
          windowsHide: true,
          env: { ...process.env },
        });
      } else {
        child = spawn('sh', [scriptPath], {
          cwd: process.cwd(),
          env: { ...process.env },
        });
      }
      console.log('[updatebot] Child process spawned');

      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        output += data.toString();
      });
      child.on('close', (code) => {
        console.log('[updatebot] Child process closed with code ' + code);
        interaction.editReply('```\n' + output + '```');
        if (code === 0) {
          if (!output.includes("Your branch is up to date")) {
            interaction.followUp('Update successful. Restarting bot...');
            console.log('[updatebot] Update successful, restarting bot...');


            setTimeout(() => {
              const flagPath = path.join(process.cwd(), 'restart.flag');
              console.log('[updatebot] Creating restart flag at ' + flagPath);
              fs.writeFileSync(flagPath, new Date().toISOString());
            }, 5000);
          } else {
            interaction.followUp('No updates available. Bot is up to date.');
            console.log('[updatebot] No updates available, bot is up to date.');
          }
        } else {
          interaction.followUp('Update process exited with code ' + code);
          console.log('[updatebot] Update process exited with code ' + code);
        }
      });

    } catch (e) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('There was an error executing this command.');
        } else {
          await interaction.editReply({ content: 'There was an an error executing this command.', ephemeral: true });
        }
      } catch (_) {}
    }
  }
};