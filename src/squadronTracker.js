// src/squadronTracker.js
// Backward compatibility wrapper - re-exports from new modular structure
// New code should import directly from './tracker'

const tracker = require('./tracker');

module.exports = {
  startSquadronTracker: tracker.startSquadronTracker,
  getSession: tracker.getSession,
};
