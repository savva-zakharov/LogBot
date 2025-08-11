// src/setup.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadSettings } = require('./config');

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer)));
}

function coerceNumber(input, fallback) {
  const n = Number(input);
  if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  return fallback;
}

async function runSetupWizard() {
  // Start with current settings as defaults if available
  const current = loadSettings();
  const cfgPath = path.join(process.cwd(), 'settings.json');
  const envPath = path.join(process.cwd(), 'settings.env');
  const hasSettingsFile = fs.existsSync(cfgPath);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('🛠  LogBot setup wizard');
  console.log('Press Enter to accept the shown default in [brackets].\n');

  try {
    const telemetryUrl = (await ask(rl, `Telemetry URL [${current.telemetryUrl || 'http://localhost:8111'}]: `)).trim() || current.telemetryUrl || 'http://localhost:8111';
    const squadronPageUrl = (await ask(rl, `War Thunder Squadron Page URL (optional) [${current.squadronPageUrl || ''}]: `)).trim() || current.squadronPageUrl || '';

    const portAns = (await ask(rl, `HTTP Port [${current.port || 3000}]: `)).trim();
    const port = coerceNumber(portAns, current.port || 3000);

    const wsPortAns = (await ask(rl, `WebSocket Port [${current.wsPort || 3001}]: `)).trim();
    const wsPort = coerceNumber(wsPortAns, current.wsPort || 3001);

    const discordBotToken = (await ask(rl, `Discord Bot Token (leave empty to skip) [${current.discordBotToken ? '*****' : ''}]: `)).trim() || current.discordBotToken || '';
    const discordChannel = (await ask(rl, `Discord Channel (ID, name, or guildId/channelId) [${current.discordChannel || '#general'}]: `)).trim() || current.discordChannel || '#general';
    const clientId = (await ask(rl, `Discord Application Client ID (optional) [${current.clientId || ''}]: `)).trim() || current.clientId || '';
    const guildId = (await ask(rl, `Default Discord Guild ID (optional) [${current.guildId || ''}]: `)).trim() || current.guildId || '';
    const waitingVoiceChannel = (await ask(rl, `Waiting Voice Channel ID (optional) [${current.waitingVoiceChannel || process.env.WAITING_VOICE_CHANNEL || ''}]: `)).trim() || current.waitingVoiceChannel || process.env.WAITING_VOICE_CHANNEL || '';

    // Determine previous single-value defaults for user and squad
    const currentPlayers = current.players && typeof current.players === 'object' ? current.players : {};
    const currentPlayerKeys = Object.keys(currentPlayers).filter(k => currentPlayers[k]);
    const defaultUser = hasSettingsFile && currentPlayerKeys.length === 1 ? currentPlayerKeys[0] : '';

    const currentSquadrons = current.squadrons && typeof current.squadrons === 'object' ? current.squadrons : {};
    const currentSquadKeys = Object.keys(currentSquadrons).filter(k => currentSquadrons[k]);
    const defaultSquad = hasSettingsFile && currentSquadKeys.length === 1 ? currentSquadKeys[0] : '';

    const userName = (await ask(rl, `Your in-game name (for highlights) [${defaultUser}]: `)).trim() || defaultUser;
    const squadronTag = (await ask(rl, `Your squadron tag (e.g., ABCD) [${defaultSquad}]: `)).trim() || defaultSquad;

    // Keep existing players/squadrons and ensure provided values are set using default colors
    const players = { ...(current.players || {}) };
    const squadrons = { ...(current.squadrons || {}) };
    if (userName) {
      players[userName] = players[userName] && typeof players[userName] === 'object'
        ? players[userName]
        : { bg: '#48430E', fg: '#FFB74D' };
    }
    if (squadronTag) {
      squadrons[squadronTag] = squadrons[squadronTag] && typeof squadrons[squadronTag] === 'object'
        ? squadrons[squadronTag]
        : { bg: '#0F3011', fg: '#9CCC65' };
    }

    // Persist players/squadrons (non-secrets) in settings.json
    const jsonCfg = { players, squadrons };
    fs.writeFileSync(cfgPath, JSON.stringify(jsonCfg, null, 2), 'utf8');
    console.log(`\n✅ Settings (players/squadrons) saved to ${cfgPath}`);

    // Persist secrets and ports in settings.env
    const envLines = [
      `# LogBot settings (secrets and ports)`,
      `TELEMETRY_URL=${telemetryUrl}`,
      `SQUADRON_PAGE_URL=${squadronPageUrl}`,
      `PORT=${port}`,
      `WS_PORT=${wsPort}`,
      `DISCORD_BOT_TOKEN=${discordBotToken}`,
      `DISCORD_CHANNEL=${discordChannel}`,
      `CLIENT_ID=${clientId}`,
      `GUILD_ID=${guildId}`,
      `WAITING_VOICE_CHANNEL=${waitingVoiceChannel}`,
      ''
    ];
    fs.writeFileSync(envPath, envLines.join('\n'), 'utf8');
    console.log(`✅ Secrets and ports saved to ${envPath}`);
    // Return merged view (as loadSettings would)
    return { ...current, ...jsonCfg, telemetryUrl, squadronPageUrl, port, wsPort, discordBotToken, discordChannel, clientId, guildId, waitingVoiceChannel };
  } finally {
    rl.close();
  }
}

module.exports = { runSetupWizard };
