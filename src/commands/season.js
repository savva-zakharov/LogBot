const fs = require('fs');
const path = require('path');
const { MessageFlags, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { fuseMatch, toNumber } = require('../nameMatch');

module.exports = {
  data: {
    name: 'season',
    description: 'Show graphs of squadron or player performance for the past 2 months',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'graph',
        description: 'Generate a line graph of squadron points and rank for the past 2 months',
      },
      {
        type: 1, // SUB_COMMAND
        name: 'player',
        description: 'Generate a line graph of a player\'s points for the past 2 months',
        options: [
          {
            type: 3, // STRING
            name: 'name',
            description: 'Player name to look up (optional, defaults to you)',
            required: false,
          }
        ]
      }
    ],
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    
    await interaction.deferReply();

    try {
      const logsDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logsDir)) {
        return interaction.editReply('Logs directory not found.');
      }

      const files = fs.readdirSync(logsDir).filter(f => f.startsWith('squadron_data-') && f.endsWith('.json'));
      
      const twoMonthsAgo = new Date();
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

      if (sub === 'graph') {
        const dataPoints = [];

        for (const file of files) {
          const dateMatch = file.match(/squadron_data-(\d{4}-\d{2}-\d{2})/);
          if (!dateMatch) continue;

          const fileDate = new Date(dateMatch[1]);
          if (fileDate < twoMonthsAgo) continue;

          try {
            const raw = fs.readFileSync(path.join(logsDir, file), 'utf8');
            const json = JSON.parse(raw);
            
            if (json.totalPoints !== undefined && json.squadronPlace !== undefined) {
              dataPoints.push({
                date: dateMatch[1],
                points: json.totalPoints,
                rank: json.squadronPlace
              });
            }
          } catch (e) {
            console.error(`Failed to parse ${file}:`, e);
          }
        }

        if (dataPoints.length < 2) {
          return interaction.editReply('Not enough data points found in the last 2 months to generate a graph.');
        }

        dataPoints.sort((a, b) => a.date.localeCompare(b.date));

        const labels = dataPoints.map(d => d.date);
        const pointsData = dataPoints.map(d => d.points);
        const rankData = dataPoints.map(d => d.rank);

        const width = 800;
        const height = 400;
        const chartJSNodeCanvas = new ChartJSNodeCanvas({ 
          width, 
          height, 
          backgroundColour: '#2b2d31' 
        });

        const configuration = {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Total Points',
                data: pointsData,
                borderColor: '#5865f2',
                backgroundColor: 'rgba(88, 101, 242, 0.2)',
                yAxisID: 'yPoints',
                tension: 0.3,
                fill: true,
                pointRadius: dataPoints.length > 30 ? 0 : 3,
              },
              {
                label: 'Squadron Rank',
                data: rankData,
                borderColor: '#f04747',
                backgroundColor: 'rgba(240, 71, 71, 0.2)',
                yAxisID: 'yRank',
                tension: 0.3,
                fill: false,
                pointRadius: dataPoints.length > 30 ? 0 : 3,
              }
            ]
          },
          options: {
            responsive: false,
            animation: false,
            scales: {
              x: {
                ticks: { color: '#ffffff', maxRotation: 45, minRotation: 45 },
                grid: { color: 'rgba(255, 255, 255, 0.1)' }
              },
              yPoints: {
                type: 'linear',
                display: true,
                position: 'left',
                title: { display: true, text: 'Points', color: '#ffffff' },
                ticks: { color: '#5865f2' },
                grid: { color: 'rgba(255, 255, 255, 0.1)' }
              },
              yRank: {
                type: 'linear',
                display: true,
                position: 'right',
                reverse: true,
                title: { display: true, text: 'Rank', color: '#ffffff' },
                ticks: { color: '#f04747', stepSize: 1 },
                grid: { drawOnChartArea: false }
              }
            },
            plugins: {
              legend: {
                labels: { color: '#ffffff' }
              },
              title: {
                display: true,
                text: 'Squadron Performance (Past 2 Months)',
                color: '#ffffff',
                font: { size: 18 }
              }
            }
          }
        };

        const image = await chartJSNodeCanvas.renderToBuffer(configuration);
        const attachment = new AttachmentBuilder(image, { name: 'season-graph.png' });

        await interaction.editReply({
          content: `Season performance graph for the past 2 months (${dataPoints.length} data points).`,
          files: [attachment]
        });

      } else if (sub === 'player') {
        const queryInput = interaction.options.getString('name');
        const targetName = queryInput && queryInput.trim() ? queryInput.trim() : (interaction.member?.nickname || interaction.user?.username);
        
        const dataPoints = [];
        let resolvedPlayerName = null;

        for (const file of files) {
          const dateMatch = file.match(/squadron_data-(\d{4}-\d{2}-\d{2})/);
          if (!dateMatch) continue;

          const fileDate = new Date(dateMatch[1]);
          if (fileDate < twoMonthsAgo) continue;

          try {
            const raw = fs.readFileSync(path.join(logsDir, file), 'utf8');
            const json = JSON.parse(raw);
            
            const rows = (json.data && Array.isArray(json.data.rows)) ? json.data.rows : (Array.isArray(json.rows) ? json.rows : []);
            if (!rows.length) continue;

            const mapped = rows.map(r => ({
              r,
              name: r.Player || r.player || 'Unknown',
              points: toNumber(r['Points'] ?? r['Personal clan rating'] ?? r.points ?? r.rating)
            }));

            const found = fuseMatch(mapped, targetName);
            if (found && found.item) {
              if (!resolvedPlayerName) resolvedPlayerName = found.item.name;
              dataPoints.push({
                date: dateMatch[1],
                points: found.item.points
              });
            }
          } catch (e) {
            console.error(`Failed to parse ${file}:`, e);
          }
        }

        if (dataPoints.length < 2) {
          return interaction.editReply(`Not enough data points found for \`${targetName}\` in the last 2 months.`);
        }

        dataPoints.sort((a, b) => a.date.localeCompare(b.date));

        const labels = dataPoints.map(d => d.date);
        const pointsData = dataPoints.map(d => d.points);

        const width = 800;
        const height = 400;
        const chartJSNodeCanvas = new ChartJSNodeCanvas({ 
          width, 
          height, 
          backgroundColour: '#2b2d31' 
        });

        const configuration = {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: `${resolvedPlayerName || targetName} Points`,
                data: pointsData,
                borderColor: '#5865f2',
                backgroundColor: 'rgba(88, 101, 242, 0.2)',
                tension: 0.3,
                fill: true,
                pointRadius: dataPoints.length > 30 ? 0 : 3,
              }
            ]
          },
          options: {
            responsive: false,
            animation: false,
            scales: {
              x: {
                ticks: { color: '#ffffff', maxRotation: 45, minRotation: 45 },
                grid: { color: 'rgba(255, 255, 255, 0.1)' }
              },
              y: {
                title: { display: true, text: 'Points', color: '#ffffff' },
                ticks: { color: '#ffffff' },
                grid: { color: 'rgba(255, 255, 255, 0.1)' }
              }
            },
            plugins: {
              legend: {
                labels: { color: '#ffffff' }
              },
              title: {
                display: true,
                text: `Player Performance: ${resolvedPlayerName || targetName} (Past 2 Months)`,
                color: '#ffffff',
                font: { size: 18 }
              }
            }
          }
        };

        const image = await chartJSNodeCanvas.renderToBuffer(configuration);
        const attachment = new AttachmentBuilder(image, { name: `player-graph-${targetName}.png` });

        await interaction.editReply({
          content: `Points graph for **${resolvedPlayerName || targetName}** over the past 2 months (${dataPoints.length} data points).`,
          files: [attachment]
        });
      }

    } catch (e) {
      console.error('Failed to generate season graph:', e);
      await interaction.editReply('An error occurred while generating the graph.');
    }
  }
};
