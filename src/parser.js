// src/parser.js

/**
 * Parses a raw log line to extract game entities.
 * Rules:
 * - Data can appear before or after keywords like 'destroyed', 'shot down', etc.
 * - Entity format: [SQ] Player (Vehicle) or SQ Player (Vehicle) or Player (Vehicle)
 * @param {string} line The raw log line from the game.
 * @returns {Array<Object>} An array of parsed entity objects.
 */
function parseLogLine(line) {
  const lower = String(line).toLowerCase();
  const kwList = ['destroyed', 'has achieved', 'has crashed', 'shot down', 'has been wrecked', 'set afire'];
  let earliest = { idx: -1, kw: '' };
  for (const kw of kwList) {
    const i = lower.indexOf(kw);
    if (i !== -1 && (earliest.idx === -1 || i < earliest.idx)) {
      earliest = { idx: i, kw };
    }
  }

  const original = String(line).trim();
  const segments = [];
  if (earliest.idx !== -1) {
    // For certain keywords, parse segments on both sides
    if (['destroyed', 'shot down', 'set afire'].includes(earliest.kw)) {
      let after = original.slice(earliest.idx + earliest.kw.length).trim();
      after = after.replace(/^(:|-|–|—|by)\s+/i, '');
      if (after) segments.push(after);
    }
    const before = original.slice(0, earliest.idx).trim();
    if (before) segments.push(before);
  } else {
    // No keywords, parse the whole line
    segments.push(original);
  }

  const VEH = '([^()]*?(?:\\([^()]*\\)[^()]*)*)'; // Balanced parentheses approximation
  const reBracketed = new RegExp(
    '^\\s*\\[(?<sq>[^\\[\\]]{1,5})\\]\\s*[-–—:]?\\s+(?<player>[^()]+?)\\s+\\((?<vehicle>' + VEH + ')\\)'
  );
  const reUnbrSquad = new RegExp(
    '^\\s*(?<sqraw>\\S{1,12})\\s*[-–—:]?\\s+(?<player>[^()]+?)\\s+\\((?<vehicle>' + VEH + ')\\)'
  );
  const reNoSquad = new RegExp(
    '^\\s*(?<player>[^()]+?)\\s+\\((?<vehicle>' + VEH + ')\\)'
  );

  const tryParse = (seg) => {
    const norm = String(seg)
      // Replace HUD separator glyphs with spaces
      .replace(/╖/g, ' ')
      // Strip leading timestamp (hh:mm[:ss]) and common delimiters
      .replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*[-–—: ]?\s*/, '')
      // Collapse excessive whitespace
      .replace(/\s+/g, ' ')
      .trim();
    let m = norm.match(reBracketed);
    if (m) {
      const sqClean = (m.groups.sq || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 5);
      if (sqClean.length >= 1) {
        return { squadron: sqClean, player: m.groups.player.trim(), vehicle: m.groups.vehicle.trim() };
      }
      const mNoB = norm.match(reNoSquad);
      if (mNoB) {
        return { squadron: 'none', player: mNoB.groups.player.trim(), vehicle: mNoB.groups.vehicle.trim() };
      }
    }
    m = norm.match(reUnbrSquad);
    if (m) {
      const cleanedSq = (m.groups.sqraw || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 5);
      if (cleanedSq.length >= 1) {
        return { squadron: cleanedSq, player: m.groups.player.trim(), vehicle: m.groups.vehicle.trim() };
      }
      const mNo = norm.match(reNoSquad);
      if (mNo) {
        return { squadron: 'none', player: mNo.groups.player.trim(), vehicle: mNo.groups.vehicle.trim() };
      }
    }
    m = norm.match(reNoSquad);
    if (m) {
      return { squadron: 'none', player: m.groups.player.trim(), vehicle: m.groups.vehicle.trim() };
    }
    // Non-anchored fallbacks
    const anyBracketed = new RegExp("\\[(?<sq>[^\\[\\]]{1,5})\\]\\s*[-–—:]?\\s+(?<player>[^()]+?)\\s+\\((?<vehicle>" + VEH + ")\\)");
    m = norm.match(anyBracketed);
    if (m && m.groups) {
      const sqClean2 = (m.groups.sq || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 5);
      return { squadron: sqClean2 || 'none', player: (m.groups.player || '').trim(), vehicle: (m.groups.vehicle || '').trim() };
    }
    const anyNoSquad = new RegExp("(?<!\\S)(?<player>[^()]+?)\\s+\\((?<vehicle>" + VEH + ")\\)");
    m = norm.match(anyNoSquad);
    if (m && m.groups) {
      return { squadron: 'none', player: (m.groups.player || '').trim(), vehicle: (m.groups.vehicle || '').trim() };
    }
    return null;
  };

  const results = [];
  for (const seg of segments) {
    const parsed = tryParse(seg);
    if (parsed) {
        // Determine status from the original line context
        const vehicleText = `(${parsed.vehicle})`;
        const vehicleIdx = original.indexOf(vehicleText);
        const isDestroyed = vehicleIdx !== -1 && (
            original.lastIndexOf(' destroyed ', vehicleIdx) !== -1 ||
            original.indexOf(' has crashed', vehicleIdx + vehicleText.length) !== -1 ||
            original.indexOf(' has been wrecked', vehicleIdx + vehicleText.length) !== -1 ||
            original.lastIndexOf(' shot down ', vehicleIdx) !== -1
        );
        parsed.status = isDestroyed ? 'destroyed' : 'active';
        parsed.originalLine = original;
        results.push(parsed);
    }
  }
  return results;
}

module.exports = {
    parseLogLine,
};
