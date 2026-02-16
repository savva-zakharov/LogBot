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
        const leaderboard = readLeaderboardData();
        const snap = readLatestSquadronSnapshot();
        if (!leaderboard || !leaderboard.length) {
            await interaction.reply({ content: 'Leaderboard data is not available yet. Please try again later.', flags: MessageFlags.Ephemeral });
            return;
        }
        if (!snap || !snap.data || !Array.isArray(snap.data.rows) || snap.data.rows.length === 0) {
            await interaction.reply({ content: 'No squadron data available yet. Please try again later.', flags: MessageFlags.Ephemeral });
            return;
        }

        const cfg = getLowPointsConfig ? getLowPointsConfig() : { threshold: 1300 };
        const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 1300;

        const settings = loadSettings();
        const primaryTag = Object.keys(settings.squadrons || {})[0] || '';
        const needle = primaryTag.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();

        const squadronInfo = leaderboard.find(s => {
            const stag = String(s.tagl || s.tag || '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
            return stag === needle;
        });



        const rows = (snap && snap.data && Array.isArray(snap.data.rows) && snap.data.rows.length)
            ? snap.data.rows
            : (Array.isArray(snap?.rows) ? snap.rows : []); // legacy fallback

        const top = [...rows]
            .map(r => ({
                r,
                points: toNumber(r['Points'] ?? r.points),
                name: sanitizeName(r.Player || r.player || 'Unknown'),
                pointsStart: toNumber(r['PointsStart'] ?? r.pointsStart),
                pointsDelta: toNumber(r['Points'] ?? r.points) - toNumber(r['PointsStart'] ?? r.pointsStart)
            }))
            .sort((a, b) => b.points - a.points);

        top.forEach((row, index) => {
            row.position = index + 1;
            row.contribution = row.position < 20 ? row.points : Math.round((row.points / 20));
        });

        const topFiltered = top.filter(row => row.pointsDelta !== 0);

        let playerTable = '';
        let firstLineLength = 35;

        if (topFiltered.length > 0) {
            const tableData = topFiltered.map((x, i) => ({
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
        }

        // console.log('[DEBUG] playerTable', playerTable);

        // console.log('[DEBUG] firstLineLength:', firstLineLength);

        let squadronSummary = '';
        if (squadronInfo) {
            const curPts = squadronInfo.points || 0;
            const startPts = squadronInfo.pointsStart || curPts;
            const ptsDelta = curPts - startPts;
            const ptsDeltaStr = ptsDelta >= 0 ? `+${ptsDelta}` : `${ptsDelta}`;

            const curPos = (squadronInfo.pos || 0) + 1;
            const startPos = (squadronInfo.posStart || curPos) + 1;
            const posDelta = startPos - curPos;
            const posDeltaStr = posDelta >= 0 ? `+${posDelta}` : `${posDelta}`;

            let session = '';

            try {
                console.log(typeof getSession);
                session = getSession();
                console.log('[DEBUG] session', session);
            } catch (error) {
                console.error('[ERROR] Failed to get session:', error);
            }

            const ratio = session.wins / session.losses;
            const ratioStr = Math.round(ratio * 100) / 100;
            const windowKey = session.windowKey || '';

            const ptsString = (startPos === curPos) ? `${curPts}` : `${startPts} → ${curPts}`;
            const posString = (startPos === curPos) ? `${curPos}` : `${startPos} → ${curPos}`;

            const rowData = {
                // "Squadron": [primaryTag],
                // "Session": [session.windowKey],          
                "Points": [ptsString, `${ansiColour(ptsDeltaStr, ptsDelta > 0 ? 'green' : ptsDelta < 0 ? 'red' : 'white')}`],
                "Place": [posString, `${ansiColour(posDeltaStr, posDelta > 0 ? 'green' : posDelta < 0 ? 'red' : 'white')}`],
                "W/L": [`${session.wins || "N/A"} / ${session.losses || "N/A"}`, ansiColour(ratioStr, ratio >= 1 ? 'green' : 'red')]
            };
            squadronSummary = formatRowTable(rowData, windowKey.replace(/\|/g, ' | '), firstLineLength, true) + "\n";
        }

        // console.log('[DEBUG] squadronSummary', squadronSummary);


        if (useEmbed) {
            const embed = new EmbedBuilder()
                .setTitle(primaryTag + ' Session Summary')
                .setDescription('```ansi\n' + squadronSummary + playerTable + '\n```')
                .setColor(embedColor)
                .setTimestamp(new Date());

            await interaction.reply({ embeds: [embed] });
        } else {
            await interaction.reply({ content: `\`\`\`ansi\n${squadronSummary}${playerTable}\n\`\`\`` });
        }
    }
};


