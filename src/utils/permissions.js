const { PermissionFlagsBits } = require('discord.js');
const { OWNER_ID } = require('../config');

function isAuthorized(interaction) {
  const member = interaction.member;
  if (!member) return false; // Should not happen in a guild command

  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
  const isOwner = interaction.user.id === OWNER_ID;

  return isAdmin || isOwner;
}

module.exports = { isAuthorized };
