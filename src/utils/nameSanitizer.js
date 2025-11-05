// src/utils/nameSanitizer.js

function sanitizeName(name) {
  if (typeof name !== 'string') return name;
  return name.replace(/[^\p{Script=Latin}\p{Script=Cyrillic}\p{N}_\-\.\s]/gu, '');
}

module.exports = { sanitizeName };
