// src/utils/nameSanitizer.js

function sanitizeName(name) {
  if (typeof name !== 'string') return name;
  return name.replace(/[^\p{Script=Latin}\p{Script=Cyrillic}\p{N}_\-\.\s]/gu, '');
}

function stripBrackets(name) {
  if (typeof name !== 'string') return name;
  return name.replace(/\[[^\]]*\]|\([^\)]*\)|\{[^\}]*\}/g, '').replace(/\s+/g, ' ').trim();
}

module.exports = { sanitizeName, stripBrackets };
