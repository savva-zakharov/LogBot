const fs = require('fs');
const path = require('path');
const { loadSettings } = require('../config');
const { MessageFlags, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { fuseMatch, toNumber } = require('../nameMatch');

function getSeasonRange(seasonInput = null) {
  if (seasonInput && /^\d{4}-[1-6]$/.test(seasonInput)) {
    const [year, s] = seasonInput.split('-').map(Number);
    const startMonth = (s - 1) * 2;
    const endMonth = s * 2 - 1;
    
    const start = new Date(year, startMonth, 2);
    // End is the 1st day of the month AFTER the end month.
    const end = new Date(year, endMonth + 1, 1, 23, 59, 59);
    
    return { start, end, label: `Season ${seasonInput}` };
  }

  const settings = loadSettings();
  const schedule = settings.seasonSchedule;
  if (schedule && typeof schedule === 'object') {
    const entries = Object.values(schedule);
    if (entries.length > 0) {
      let start = null;
      let end = null;
      for (const entry of entries) {
        if (entry.startDate) {
          const s = new Date(entry.startDate);
          if (!start || s < start) start = s;
        }
        if (entry.endDate) {
          const e = new Date(entry.endDate);
          if (!end || e > end) end = e;
        }
      }
      if (start && end) return { start, end, label: 'Current Season' };
    }
  }

  // Fallback to 2 months
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - 2);
  return { start, end, label: 'Past 2 Months' };
}

module.exports = {
  data: {
    name: 'season',
    description: 'Show graphs of squadron or player performance',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'graph',
        description: 'Generate a line graph of squadron points and rank',
        options: [
          {
            type: 3, // STRING
            name: 'season',
            description: 'Optional season in YYYY-S format (e.g., 2026-1 for Jan-Feb)',
            required: false,
          }
        ]
      },
      {
        type: 1, // SUB_COMMAND
        name: 'player',
        description: 'Generate a line graph of a player\'s points',
        options: [
          {
            type: 3, // STRING
            name: 'name',
            description: 'Player name to look up (optional, defaults to you)',
            required: false,
          },
          {
            type: 3, // STRING
            name: 'season',
            description: 'Optional season in YYYY-S format (e.g., 2026-1 for Jan-Feb)',
            required: false,
          }
        ]
      }
    ],
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const seasonInput = interaction.options.getString('season');
    
    await interaction.deferReply();

    try {
      const logsDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logsDir)) {
        return interaction.editReply('Logs directory not found.');
      }

      const files = fs.readdirSync(logsDir).filter(f => f.startsWith('squadron_data-') && f.endsWith('.json'));
      
      const range = getSeasonRange(seasonInput);
      const timeframeStr = range.label;

      if (sub === 'graph') {
        const dataPoints = [];

        for (const file of files) {
          const dateMatch = file.match(/squadron_data-(\d{4}-\d{2}-\d{2})/);
          if (!dateMatch) continue;

          const fileDate = new Date(dateMatch[1]);
          if (fileDate < range.start || fileDate > range.end) continue;

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
          return interaction.editReply(`Not enough data points found for the ${timeframeStr} to generate a graph.`);
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
                text: `Squadron Performance (${timeframeStr})`,
                color: '#ffffff',
                font: { size: 18 }
              }
            }
          }
        };

        const image = await chartJSNodeCanvas.renderToBuffer(configuration);
        const attachment = new AttachmentBuilder(image, { name: 'season-graph.png' });

        await interaction.editReply({
          content: `Season performance graph for the ${timeframeStr} (${dataPoints.length} data points).`,
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
          if (fileDate < range.start || fileDate > range.end) continue;

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
          return interaction.editReply(`Not enough data points found for \`${targetName}\` in the ${timeframeStr}.`);
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
                text: `Player Performance: ${resolvedPlayerName || targetName} (${timeframeStr})`,
                color: '#ffffff',
                font: { size: 18 }
              }
            }
          }
        };

        const image = await chartJSNodeCanvas.renderToBuffer(configuration);
        const attachment = new AttachmentBuilder(image, { name: `player-graph-${targetName}.png` });

        await interaction.editReply({
          content: `Points graph for **${resolvedPlayerName || targetName}** over the ${timeframeStr} (${dataPoints.length} data points).`,
          files: [attachment]
        });
      }

    } catch (e) {
      console.error('Failed to generate season graph:', e);
      await interaction.editReply('An error occurred while generating the graph.');
    }
  }
};
