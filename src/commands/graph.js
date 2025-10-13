const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');

// Re-introducing core Chart.js imports and registration
const { Chart, registerables } = require('chart.js');
Chart.register(...registerables);

// Temporarily removed adapter imports
const { DateTime } = require('luxon');
const LuxonAdapter = require('chartjs-adapter-luxon');
Chart.defaults.adapters.date = LuxonAdapter;
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const fs = require('fs/promises');
const path = require('path');

// Re-introducing ChartJSNodeCanvas setup
const width = 800;
const height = 400;

console.log('Attempting to instantiate ChartJSNodeCanvas...');
const chartJSNodeCanvas = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: 'white',
    chart: Chart,
});
console.log('ChartJSNodeCanvas instantiated successfully.');

async function createGraph(data) {
    const configuration = {
        type: 'line',
        data: {
            datasets: [{
                label: 'Squadron Points',
                data: data,
                borderColor: 'rgb(75, 192, 192)',
                tension: 0.1,
                pointRadius: data.length < 100 ? 3 : 0,
            }],
        },
        options: {
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'day',
                        tooltipFormat: 'MMM d, yyyy HH:mm',
                    },
                    title: {
                        display: true,
                        text: 'Date',
                    },
                },
                y: {
                    beginAtZero: false,
                    title: {
                        display: true,
                        text: 'Points',
                    },
                },
            },
            plugins: {
                legend: {
                    position: 'top',
                },
                title: {
                    display: true,
                    text: 'Squadron Points History',
                },
            },
        },
    };

    const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
    return imageBuffer;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('graph')
        .setDescription('Displays a graph of the squadron points history.'),
    async execute(interaction) {
        await interaction.deferReply();

        try {
            const logsDir = path.join(process.cwd(), 'old_logs');
            const files = await fs.readdir(logsDir);

            const squadronDataFiles = files.filter(file => file.startsWith('squadron_data-') && file.endsWith('.json'));

            if (squadronDataFiles.length === 0) {
                await interaction.editReply('No squadron data files found to generate a graph.');
                return;
            }

            const pointsData = [];
            const dateRegex = /squadron_data-(\d{4}-\d{2}-\d{2})\.json/;

            for (const file of squadronDataFiles) {
                const dateMatch = file.match(dateRegex);
                if (!dateMatch) continue;

                const dateString = dateMatch[1]; // YYYY-MM-DD
                const date = new Date(dateString);

                const filePath = path.join(logsDir, file);
                const fileContent = await fs.readFile(filePath, 'utf-8');
                const data = JSON.parse(fileContent);

                if (data && data.squadronSnapshots && data.squadronSnapshots.length > 0 && typeof data.squadronSnapshots[0].totalPoints === 'number') {
                    const points = data.squadronSnapshots[0].totalPoints;
                    pointsData.push({ x: date, y: points });
                }
            }

            if (pointsData.length === 0) {
                await interaction.editReply('Could not parse any points data from the log files.');
                return;
            }

            // Sort data chronologically
            pointsData.sort((a, b) => a.x - b.x);

            const graphImage = await createGraph(pointsData);
            const attachment = new AttachmentBuilder(graphImage, { name: 'squadron-graph.png' });

            await interaction.editReply({ files: [attachment] });

        } catch (error) {
            console.error('Failed to generate squadron graph:', error);
            await interaction.editReply('An error occurred while generating the graph.');
        }
    },
};