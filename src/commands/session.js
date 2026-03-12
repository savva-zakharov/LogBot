// src/commands/session.js
const fs = require('fs');
const path = require('path');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { loadSettings } = require('../config');
const { ansiColour, formatTable, formatRowTable } = require('../utils/formatHelper');
const { getConfig: getLowPointsConfig } = require('../lowPointsIssuer');
const { sanitizeName } = require('../utils/nameSanitizer');
const { getSession } = require('../squadronTracker');

const useEmbed = true;
const embedColor = 0xd0463c;

function toNumber(val) {
    const cleaned = String(val ?? '').replace(/[^0-9]/g, '');
    return cleaned ? parseInt(cleaned, 10) : 0;
}

function readLeaderboardData() {
    try {
        const file = path.join(process.cwd(), 'leaderboard_data.json');
        if (!fs.existsSync(file)) {
            return null;
        }
        const raw = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : null;
    } catch (_) { return null; }
}

function readLatestSquadronSnapshot() {
    try {
        const file = path.join(process.cwd(), 'squadron_data.json');
        const raw = fs.readFileSync(file, 'utf8');
        const obj = JSON.parse(raw);
        // Legacy array format
        if (Array.isArray(obj.squadronSnapshots)) {
            const arr = obj.squadronSnapshots;
            return arr.length ? arr[arr.length - 1] : null;
        }
        // New single-snapshot format: the object itself is the snapshot
        return obj && typeof obj === 'object' && Object.keys(obj).length ? obj : null;
    } catch (_) {
        return null;
    }
}

module.exports = {
    data: {
        name: 'session',
        description: 'Show the current squadron session summary',
    },
    async execute(interaction) {
        console.log('[DEBUG session.js] === execute() started ===');
        
        try {
            console.log('[DEBUG session.js] Reading leaderboard data...');
            const leaderboard = readLeaderboardData();
            console.log('[DEBUG session.js] Leaderboard result:', leaderboard ? `array with ${leaderboard.length} items` : 'null');
            
            console.log('[DEBUG session.js] Reading squadron snapshot...');
            const snap = readLatestSquadronSnapshot();
            console.log('[DEBUG session.js] Snapshot result:', snap ? 'object received' : 'null');
            
            if (!leaderboard || !leaderboard.length) {
                console.log('[DEBUG session.js] No leaderboard data, sending ephemeral reply');
                await interaction.reply({ content: 'Leaderboard data is not available yet. Please try again later.', flags: MessageFlags.Ephemeral });
                return;
            }
            if (!snap || !snap.data || !Array.isArray(snap.data.rows) || snap.data.rows.length === 0) {
                console.log('[DEBUG session.js] No squadron data, sending ephemeral reply');
                await interaction.reply({ content: 'No squadron data available yet. Please try again later.', flags: MessageFlags.Ephemeral });
                return;
            }

            console.log('[DEBUG session.js] Loading config...');
            const cfg = getLowPointsConfig ? getLowPointsConfig() : { threshold: 1300 };
            const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 1300;
            console.log('[DEBUG session.js] Threshold:', threshold);

            console.log('[DEBUG session.js] Loading settings...');
            const settings = loadSettings();
            const primaryTag = Object.keys(settings.squadrons || {})[0] || '';
            const needle = primaryTag.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
            console.log('[DEBUG session.js] Primary tag:', primaryTag, '| Needle:', needle);

            const squadronInfo = leaderboard.find(s => {
                const stag = String(s.tagl || s.tag || '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
                return stag === needle;
            });
            console.log('[DEBUG session.js] Squadron info found:', squadronInfo ? 'yes' : 'no');

            const rows = (snap && snap.data && Array.isArray(snap.data.rows) && snap.data.rows.length)
                ? snap.data.rows
                : (Array.isArray(snap?.rows) ? snap.rows : []); // legacy fallback
            console.log('[DEBUG session.js] Rows count:', rows.length);

            const top = [...rows]
                .map(r => ({
                    r,
                    points: toNumber(r['Points'] ?? r.points),
                    name: sanitizeName(r.Player || r.player || 'Unknown'),
                    pointsStart: toNumber(r['PointsStart'] ?? r.pointsStart),
                    pointsDelta: toNumber(r['Points'] ?? r.points) - toNumber(r['PointsStart'] ?? r.pointsStart)
                }))
                .sort((a, b) => b.points - a.points);
            console.log('[DEBUG session.js] Top players processed:', top.length);

            top.forEach((row, index) => {
                row.position = index + 1;
                row.contribution = row.position < 20 ? row.points : Math.round((row.points / 20));
            });

            const topFiltered = top.filter(row => row.pointsDelta !== 0);
            console.log('[DEBUG session.js] Top filtered (delta != 0):', topFiltered.length);

            // Discord embed description limit is 4096 characters
            // Each row with ANSI codes is ~70-80 chars, header/footer ~200 chars
            // Reserve ~600 chars for squadron summary, leaving ~3400 for player table
            const maxRows = 40; // Safe limit to avoid exceeding Discord's 4096 char limit

            console.log('[DEBUG session.js] Limiting player table to max', maxRows, 'rows');

            let playerTable = '';
            let firstLineLength = 35;

            if (topFiltered.length > 0) {
                console.log('[DEBUG session.js] Building player table...');
                const tableData = topFiltered.slice(0, maxRows).map((x, i) => ({
                    position: x.position < 21 ? ansiColour(x.position, 'cyan') : x.position,
                    name: x.name,
                    points: x.points < threshold ? ansiColour(x.points, 'yellow') : x.points,
                    pointsDelta: x.pointsDelta < 0 ? ansiColour(x.pointsDelta, 'red') : x.pointsDelta > 0 ? ansiColour('+' + x.pointsDelta, 'green') : x.pointsDelta,
                }));

                const titleText = 'Player Summary';
                const fieldHeaders = ["Pos", "Name", "Points", "Δ"];
                const fieldOrder = ["position", "name", "points", "pointsDelta"];
                playerTable = formatTable(tableData, titleText, fieldHeaders, fieldOrder);

                firstLineLength = playerTable.split('\n')[1].length;
                
                // Add truncation notice if we hid some rows
                if (topFiltered.length > maxRows) {
                    const hiddenCount = topFiltered.length - maxRows;
                    playerTable += `\n... and ${hiddenCount} more players (not shown)\n`;
                }
                
                console.log('[DEBUG session.js] Player table built, firstLineLength:', firstLineLength);
                console.log('[DEBUG session.js] Player table character count:', playerTable.length);
            } else {
                console.log('[DEBUG session.js] No players with delta, skipping player table');
            }

            let squadronSummary = '';
            if (squadronInfo) {
                console.log('[DEBUG session.js] Building squadron summary...');
                const curPts = squadronInfo.points || 0;
                const startPts = squadronInfo.pointsStart || curPts;
                const ptsDelta = curPts - startPts;
                const ptsDeltaStr = ptsDelta > 0 ? `+${ptsDelta}` : `${ptsDelta}`;

                const curPos = (squadronInfo.pos || 0) + 1;
                const startPos = (squadronInfo.posStart || curPos) + 1;
                const posDelta = startPos - curPos;
                const posDeltaStr = posDelta >0 ? `+${posDelta}` : `${posDelta}`;

                console.log('[DEBUG session.js] curPts:', curPts, 'startPts:', startPts, 'ptsDelta:', ptsDelta);
                console.log('[DEBUG session.js] curPos:', curPos, 'startPos:', startPos, 'posDelta:', posDelta);

                let session = null;

                try {
                    console.log('[DEBUG session.js] Calling getSession()...');
                    console.log('[DEBUG session.js] getSession type:', typeof getSession);
                    session = getSession();
                    console.log('[DEBUG session.js] getSession result:', JSON.stringify(session));
                } catch (error) {
                    console.error('[ERROR session.js] Failed to get session:', error);
                    session = { wins: 0, losses: 1, windowKey: 'error' };
                }

                // Handle case where session is null/undefined
                if (!session) {
                    console.warn('[WARN session.js] session is null/undefined, using defaults');
                    session = { wins: 0, losses: 1, windowKey: 'no-data' };
                }

                const ratio = session.losses !== 0 ? session.wins / session.losses : session.wins;
                const ratioStr = (session.wins) ? Math.round(ratio * 100) / 100 : " ";
                const windowKey = session.windowKey || '';
                console.log('[DEBUG session.js] ratio:', ratio, 'ratioStr:', ratioStr, 'windowKey:', windowKey);

                const ptsString = (startPos === curPos) ? `${curPts}` : `${startPts} → ${curPts}`;
                const posString = (startPos === curPos) ? `${curPos}` : `${startPos} → ${curPos}`;
                const wlString = (session.wins) ? `${session.wins} / ${session.losses}` : "N/A";
                console.log('[DEBUG session.js] ptsString:', ptsString, 'posString:', posString, 'wlString:', wlString);

                const rowData = {
                    // "Squadron": [primaryTag],
                    // "Session": [session.windowKey],
                    "Points": [ptsString, `${ansiColour(ptsDeltaStr, ptsDelta > 0 ? 'green' : ptsDelta < 0 ? 'red' : 'white')}`],
                    "Place": [posString, `${ansiColour(posDeltaStr, posDelta > 0 ? 'green' : posDelta < 0 ? 'red' : 'white')}`],
                    "W/L": [wlString, ansiColour(ratioStr, ratio > 1 ? 'green' : 'red')]
                };
                squadronSummary = formatRowTable(rowData, windowKey.replace(/\|/g, ' | '), firstLineLength, true) + "\n";
                console.log('[DEBUG session.js] Squadron summary built');
            } else {
                console.log('[DEBUG session.js] No squadron info, skipping squadron summary');
            }

            console.log('[DEBUG session.js] Final output - squadronSummary length:', squadronSummary.length, 'playerTable length:', playerTable.length);

            // Build the full description and check length
            const fullDescription = '```ansi\n' + squadronSummary + playerTable + '\n```';
            console.log('[DEBUG session.js] Full description length:', fullDescription.length);

            let finalDescription = fullDescription;
            if (fullDescription.length > 4096) {
                console.warn('[WARN session.js] Description exceeds 4096 chars, truncating...');
                // Truncate player table more aggressively
                const maxPlayerLength = 4096 - squadronSummary.length - 20; // 20 for markdown wrappers
                playerTable = playerTable.substring(0, maxPlayerLength);
                // Find last complete line
                const lastNewline = playerTable.lastIndexOf('\n');
                if (lastNewline > 0) {
                    playerTable = playerTable.substring(0, lastNewline);
                }
                playerTable += '\n... (truncated to fit Discord limits)\n';
                finalDescription = '```ansi\n' + squadronSummary + playerTable + '\n```';
                console.log('[DEBUG session.js] Truncated description length:', finalDescription.length);
            }

            if (useEmbed) {
                console.log('[DEBUG session.js] Sending embed reply...');
                const embed = new EmbedBuilder()
                    .setTitle(primaryTag + ' Session Summary')
                    .setDescription(finalDescription)
                    .setColor(embedColor)
                    .setTimestamp(new Date());

                await interaction.reply({ embeds: [embed] });
                console.log('[DEBUG session.js] Embed reply sent successfully');
            } else {
                console.log('[DEBUG session.js] Sending text reply...');
                await interaction.reply({ content: finalDescription });
                console.log('[DEBUG session.js] Text reply sent successfully');
            }
        } catch (error) {
            console.error('[ERROR session.js] Uncaught error in execute():', error);
            console.error('[ERROR session.js] Stack:', error.stack);
            
            const errorMsg = error?.message || 'Unknown error';
            console.error('[ERROR session.js] Error message:', errorMsg);
            
            // Try to reply with error if interaction hasn't been replied to yet
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: `⚠️ Error: ${errorMsg}\n\nCheck server logs for details.`, 
                        flags: MessageFlags.Ephemeral 
                    });
                }
            } catch (replyError) {
                console.error('[ERROR session.js] Failed to send error reply:', replyError);
            }
        }
    }
};


