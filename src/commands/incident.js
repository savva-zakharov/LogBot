// src/commands/incident.js
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { loadSettings } = require('../config');
const { formatRowTable, ansiColour } = require('../utils/formatHelper');

const embedColor = 0x3ba55d; // Discord green
const useEmbed = true;

module.exports = {
    data: {
        name: 'incident',
        description: 'Show days since the last incident was reported',
    },
    async execute(interaction) {
        console.log('[DEBUG incident.js] === execute() started ===');

        try {
            const settings = loadSettings();
            const incidentChannelId = settings.incidentChannel;

            console.log('[DEBUG incident.js] incidentChannel setting:', incidentChannelId || '(not configured)');

            if (!incidentChannelId) {
                await interaction.reply({
                    content: '⚠️ Incident channel is not configured. Please use `/settings` to set it up.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            // Get the channel
            const channel = await interaction.client.channels.fetch(incidentChannelId).catch((err) => {
                console.error('[DEBUG incident.js] Channel fetch error:', err.message);
                return null;
            });
            console.log('[DEBUG incident.js] Channel fetch result:', channel ? 'found' : 'not found');

            if (!channel) {
                await interaction.reply({
                    content: '⚠️ Incident channel not found. Please check the channel ID in `/settings`.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            // Check bot permissions
            const permissions = channel.permissionsFor(interaction.guild.members.me);
            console.log('[DEBUG incident.js] Bot permissions in channel:', permissions ? 'available' : 'unavailable');
            
            if (permissions) {
                const hasReadHistory = permissions.has('ReadMessageHistory');
                console.log('[DEBUG incident.js] Has ReadMessageHistory:', hasReadHistory);
                
                if (!hasReadHistory) {
                    await interaction.reply({
                        content: '⚠️ Missing permissions! The bot needs **Read Message History** permission in the incident channel.\n\nPlease grant the bot the following permissions in that channel:\n- Read Messages\n- Read Message History',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
            }

            // Fetch the latest message from the channel
            const messages = await channel.messages.fetch({ limit: 1 }).catch((err) => {
                console.error('[DEBUG incident.js] Messages fetch error:', err.message);
                console.error('[DEBUG incident.js] Error code:', err.code);
                return null;
            });
            console.log('[DEBUG incident.js] Messages fetch result:', messages ? messages.size : 'null');

            if (!messages || messages.size === 0) {
                // No messages yet - incident tracker hasn't started
                const rowData = {
                    "Status": ["No incidents recorded yet", ""],
                    "": ["Tracker is active. Start logging incidents!", ""]
                };
                const tableWidth = 55;
                const formattedTable = formatRowTable(rowData, '🛡️ Incident Tracker', tableWidth, true);

                const embed = new EmbedBuilder()
                    .setTitle('Incident Tracker')
                    .setDescription('```ansi\n' + formattedTable + '\n```')
                    .setColor(embedColor)
                    .setTimestamp(new Date());

                await interaction.reply({ embeds: [embed] });
                return;
            }

            const latestMessage = messages.first();
            const lastIncidentDate = latestMessage.createdAt;
            const now = new Date();
            const diffMs = now - lastIncidentDate;
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

            console.log('[DEBUG incident.js] Last incident:', lastIncidentDate.toISOString());
            console.log('[DEBUG incident.js] Days since:', diffDays, 'hours:', diffHours, 'minutes:', diffMinutes);

            // Build the output using formatRowTable
            const daysText = diffDays === 0 ? 'Today' : diffDays === 1 ? '1 day' : `${diffDays} days`;
            const timeAgoText = diffDays > 0
                ? `${daysText} ago`
                : diffHours > 0
                    ? `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`
                    : `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;

            const statusText = diffDays === 0 ? 'Bans will continue until morale improves' 
            : diffDays < 7 ? 'Number go up' 
            : diffDays < 14 ? 'Time to burry the bannhammer' 
            : diffDays < 21 ? '8easty has been notified' 
            : diffDays < 28 ? 'Back in my days, there used to be good drama' 
            : diffDays < 35 ? 'Reintroducing Zdevko as commander' 
            : diffDays < 42 ? 'DSV will come back at this rate' 
            : 'Unbelievable, the tracker must be broken';
            const statusColor = diffDays === 0 ? 'red' : diffDays < 7 ? 'yellow' : 'green';

            const rowData = {
                "Days Since": [`${ansiColour(diffDays.toString(), statusColor, diffDays > 0)}`],
                "Last Incident": [`${lastIncidentDate.toLocaleString()}`],
                "Time Ellapsed": [timeAgoText],
                "Status": [statusText]
            };

            // Calculate approximate width for the table
            const tableWidth = 55;
            const formattedTable = formatRowTable(rowData, 'Incident Tracker', tableWidth, true);

            console.log('[DEBUG incident.js] Formatted table:', formattedTable);

            if (useEmbed) {
                const embed = new EmbedBuilder()
                    .setTitle('Incident Tracker')
                    .setDescription('```ansi\n' + formattedTable + '\n```')
                    .setColor(diffDays === 0 ? 0xff0000 
                        : diffDays < 7 ? 0xffff00 
                        : 0x00ff00)
                    .setTimestamp(new Date());

                if (latestMessage.author) {
                    embed.setFooter({ text: `Last logged by: ${latestMessage.author.username}` });
                }

                console.log('[DEBUG incident.js] Sending embed reply...');
                await interaction.reply({ embeds: [embed] });
                console.log('[DEBUG incident.js] Embed reply sent successfully');
            } else {
                await interaction.reply({ content: `\`\`\`ansi\n${formattedTable}\n\`\`\`` });
            }

        } catch (error) {
            console.error('[ERROR incident.js] Uncaught error in execute():', error);
            console.error('[ERROR incident.js] Stack:', error.stack);

            const errorMsg = error?.message || 'Unknown error';
            console.error('[ERROR incident.js] Error message:', errorMsg);

            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: `⚠️ Error: ${errorMsg}\n\nCheck server logs for details.`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('[ERROR incident.js] Failed to send error reply:', replyError);
            }
        }
    }
};
