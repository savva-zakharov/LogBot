// src/squadron/index.js
// Central export point for all squadron tracking modules

const windowManager = require('./windowManager');
const sessionManager = require('./sessionManager');
const dataFetcher = require('./dataFetcher');
const eventLogger = require('./eventLogger');
const snapshotManager = require('./snapshotManager');
const discordIntegration = require('./discordIntegration');
const playerSessionStore = require('./playerSessionStore');
const squadronSessionStore = require('./squadronSessionStore');
const fileLock = require('./fileLock');

module.exports = {
  // Window management
  ...windowManager,

  // Session management
  ...sessionManager,

  // Data fetching
  ...dataFetcher,

  // Event logging
  ...eventLogger,

  // Snapshot management
  ...snapshotManager,

  // Discord integration
  ...discordIntegration,

  // Player session store
  ...playerSessionStore,

  // Squadron session store
  ...squadronSessionStore,

  // File locking
  ...fileLock,

  // Module exports for direct access
  windowManager,
  sessionManager,
  dataFetcher,
  eventLogger,
  snapshotManager,
  discordIntegration,
  playerSessionStore,
  squadronSessionStore,
  fileLock,
};
