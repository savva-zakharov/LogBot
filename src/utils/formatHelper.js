const { loadSettings } = require('../config');

// Text Colors

//     30: Gray
//     31: Red
//     32: Green
//     33: Yellow
//     34: Blue
//     35: Pink
//     36: Cyan
//     37: White

// Background Colors

//     40: Firefly dark blue
//     41: Orange
//     42: Marble blue
//     43: Grayish turquoise
//     44: Gray
//     45: Indigo
//     46: Light gray
//     47: White

const ansiColors = {
  black: 30,
  grey: 30,
  gray: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  reset: 0,
};

function ansiColour(str, colour, bold = false) {
  if (typeof colour == 'string') {
    colour = ansiColors[colour];
  }
  return `\u001b[${bold ? 1 : 0};${colour}m${str}\u001b[0m`;
}



//table functions

// ┌─┬───┐
// ├─┼─┬─┤
// └─┴─┴─┘



// ├─┼─┼─┤
function makeSeparator(str) {
  const settings = loadSettings();
  if (settings.tableStyle === 'light') {
    return str.replace(/[^│]/g, '─').replace(/^│/, '├').replace(/│$/, '┤').replace(/(?<=.)│(?=.)/g, '┼');
  } else {
    return str.replace(/[^│]/g, '═').replace(/^│/, '╞').replace(/│$/, '╡').replace(/(?<=.)│(?=.)/g, '╪');
  }
}


//┌─┬─┬─┐
function makeStarter(str) {
  str = visibleString(str);
  return str.replace(/[^│]/g, '─').replace(/^│/, '┌').replace(/│$/, '┐').replace(/│/g, '┬');
}


// └─┴─┴─┘
function makeCloser(str) {
  str = visibleString(str);
  return str.replace(/[^│]/g, '─').replace(/^│/, '└').replace(/│$/, '┘').replace(/│/g, '┴');
}


// ┌────────┐
// │ Title │
// ├──┬──┬──┤
function makeTitle(str, header) {
  header = visibleString(header);
  let title = header.replace(/[^│]/g, '─').replace(/^│/, '┌').replace(/│$/, '┐').replace(/│/g, '─') + "\n";
  title += `│` + padCenter(str, header.length - 2, ' ') + `│\n`;
  title += header.replace(/[^│]/g, '─').replace(/^│/, '├').replace(/│$/, '┤').replace(/│/g, '┬');

  return title;
}

// Title 
// ──┬──┬──
//   │ │ │
function formatTableLight(data, title = null, header = null, order = null, compact = false) {
  if (!header) {
    header = Object.keys(data[0]);
  }
  let matrix;
  if (order) {
    matrix = [header, ...data.map(obj => order.map(f => String(obj[f])))];
  } else {
    matrix = [header, ...data.map(obj => Object.values(obj).map(v => String(v)))];
  }

  let colCount = matrix[0].length;
  let colMaxLengths = Array(colCount).fill(0);

  for (const row of matrix) {
    row.forEach((cell, i) => {
      if (visibleLength(cell) > colMaxLengths[i]) {
        colMaxLengths[i] = visibleLength(cell);
      }
    });
  }

  let body = '';
  let divider = compact ? ' ' : ' │ ';

  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    matrix[i] = row.map((s, j) => padCell(s, colMaxLengths[j], 'left'));
    body += matrix[i].join(divider) + '\n';
    if (i === 0) {
      separator = makeSeparator(body.split("\n")[0]);
      body = body + separator + '\n';
    }
  }

  let starter;
  if (title) {
    const titleLine = padCenter(title, body.split("\n")[0].length, ' ');
    starter = makeStarter(body.split("\n")[0]);
    body = titleLine + '\n' + starter + '\n' + body;
  }

  return body;
}

// ┌────────┐
// │ Title │
// ├──┬──┬──┤
// │  │  │  │
// └──┴──┴──┘


function formatTableHeavy(data, title = null, header = null, order = null, compact = false) {
  if (!header) {
    header = Object.keys(data[0]);
  }

  let matrix;
  if (order) {
    matrix = [header, ...data.map(obj => order.map(f => String(obj[f])))];
  } else {
    matrix = [header, ...data.map(obj => Object.values(obj).map(v => String(v)))];
  }

  let colCount = matrix[0].length;
  let colMaxLengths = Array(colCount).fill(0);

  for (const row of matrix) {
    row.forEach((cell, i) => {
      if (visibleLength(cell) > colMaxLengths[i]) {
        colMaxLengths[i] = visibleLength(cell);
      }
    });
  }

  let body = '';
  let divider = compact ? '│' : ' │ ';

  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    matrix[i] = row.map((s, j) => padCell(s, colMaxLengths[j], 'left'));
    body += (compact ? '│' : '│ ') + matrix[i].join(divider) + (compact ? '│' : ' │') + '\n';
    if (i === 0) {
      const separator = makeSeparator(body.split("\n")[0]);
      body = body + separator + '\n';
    }
  }
  let closer = makeCloser(body.split("\n")[0]);
  let starter = ``;
  if (title) {
    starter = makeTitle(title, body.split("\n")[0]);
    body = starter + `\n` + body;
  } else {
    starter = makeStarter(body.split("\n")[0]);
    body = starter + '\n' + body;
  }

  body = body + closer;

  return body;
}

function formatTable(data, title = null, header = null, order = null, compact = false) {
  const settings = loadSettings();
  if (settings.tableStyle === 'light') {
    return formatTableLight(data, title, header, order, compact);
  }
  return formatTableHeavy(data, title, header, order, compact);
}

function formatRowTable(data, title = null, width = null, closer = false) {
  const settings = loadSettings();
  const isHeavy = settings.tableStyle !== 'light';

  // Convert all values to arrays for uniform multi-column processing
  const entries = Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]);
  
  const keyMaxLength = Math.max(...entries.map(([k]) => visibleLength(k)));
  const maxValCols = Math.max(...entries.map(([_, v]) => v.length));
  const valMaxLengths = Array(maxValCols).fill(0);

  for (const [_, vals] of entries) {
    vals.forEach((v, i) => {
      const len = visibleLength(String(v));
      if (len > valMaxLengths[i]) valMaxLengths[i] = len;
    });
  }

  const divider = " │ ";
  let body = "";
  for (const [k, vals] of entries) {
    let line = isHeavy ? "│ " : "";
    line += padCell(k, keyMaxLength);
    for (let i = 0; i < maxValCols; i++) {
      line += divider + padCell(String(vals[i] || ""), valMaxLengths[i]);
    }
    if (isHeavy) {
      line = padRight(line, width - 2);
      line += " │";
    } else {
      line = padRight(line, width);
    }
    
    body += line + "\n";
  }

  const sampleLine = body.split("\n")[0];

  let result = "";
  if (isHeavy) {
    const starter = makeStarter(sampleLine);
    const closer = makeCloser(sampleLine);
    if (title) {
      result += makeTitle(title, sampleLine) + "\n";
    } else {
      result += starter + "\n";
    }
    result += body + closer;
  } else {
    if (title) {
      const titleWidth = visibleLength(sampleLine);
      result += padCenter(title, width) + "\n" + makeStarter(sampleLine) + "\n";
      
    }
    result += body;
    if (closer) result += makeCloser(sampleLine);
  }
  return result;
}

function visibleLength(str) {
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  return str.replace(ansiRegex, "").length;
}

function visibleString(str) {
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  return str.replace(ansiRegex, "");
}

function padCell(str, width) {
  const align = isNumeric(str) ? "right" : "left";
  const len = str.replace(/\x1b\[[0-9;]*m/g, "").length;

  if (align === "right") return " ".repeat(width - len) + str;
  return str + " ".repeat(width - len);
}

function isNumeric(str) {
  // strip ANSI codes first if your string has colors
  const clean = str.replace(/\x1b\[[0-9;]*m/g, "");
  // allow negative numbers, decimals, commas
  return /^[-+]?[0-9,]*\.?[0-9]*$/.test(clean);
}

function sanitizeUsername(name) {
  return name
    .replace(/@(psn|live)\b/gi, "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

function padCenter(str, length, pad = ' ') {
  const totalPadding = length - visibleLength(str);
  if (totalPadding <= 0) return str;

  const paddingStart = Math.floor(totalPadding / 2);
  const paddingEnd = totalPadding - paddingStart;

  return pad.repeat(paddingStart) + str + pad.repeat(paddingEnd);
}

function padRight(str, length, pad = ' ') {
  const totalPadding = length - visibleLength(str);
  if (totalPadding <= 0) return str;

  return str + pad.repeat(totalPadding);
}

function padLeft(str, length, pad = ' ') {
  const totalPadding = length - visibleLength(str);
  if (totalPadding <= 0) return str;

  return pad.repeat(totalPadding) + str;
}

/**
 * Format a session summary for Discord display
 * @param {Object} session - Session object with wins, losses, windowKey, etc.
 * @param {number} startingPoints - Starting points value
 * @param {number} endingPoints - Ending points value
 * @param {number} startingPos - Starting position (1-based)
 * @param {number} endingPos - Ending position (1-based)
 * @param {boolean} useAnsi - Whether to include ANSI color codes
 * @returns {string} Formatted session summary
 */
function formatSessionSummary(session, startingPoints, endingPoints, startingPos, endingPos, width = 50, useAnsi = true) {
  const pointsDelta = endingPoints != null && startingPoints != null
    ? endingPoints - startingPoints
    : null;
  const posDelta = startingPos != null && endingPos != null
    ? startingPos - endingPos  // Positive means gained positions
    : null;

  const ptsDeltaStr = pointsDelta != null
    ? (pointsDelta > 0 ? `+${pointsDelta}` : `${pointsDelta}`)
    : 'N/A';
  const ptsDeltaColor = pointsDelta > 0 ? 'green' : pointsDelta < 0 ? 'red' : 'white';

  const posDeltaStr = posDelta != null
    ? (posDelta > 0 ? `+${posDelta}` : `${posDelta}`)
    : 'N/A';
  const posDeltaColor = posDelta > 0 ? 'green' : posDelta < 0 ? 'red' : 'white';

  const ptsString = (startingPos === endingPos)
    ? `${endingPoints}`
    : `${startingPoints} → ${endingPoints}`;
  const posString = (startingPos === endingPos)
    ? `#${endingPos}`
    : `#${startingPos} → #${endingPos}`;
  const wlString = session.wins > 0 || session.losses > 0
    ? `${session.wins}W / ${session.losses}L`
    : 'N/A';

  const ratio = session.losses > 0 ? (session.wins / session.losses) : session.wins;
  const ratioStr = (session.wins > 0 || session.losses > 0)
    ? Math.round(ratio * 100) / 100
    : 'N/A';
  const wlColor = ratio > 1 ? 'green' : ratio < 1 ? 'red' : 'white';

  // Build row data for formatRowTable
  const rowData = {
    "Points": [ptsString, useAnsi ? ansiColour(ptsDeltaStr, ptsDeltaColor) : ptsDeltaStr],
    "Place": [posString, useAnsi ? ansiColour(posDeltaStr, posDeltaColor) : posDeltaStr],
    "W/L": [wlString, useAnsi ? ansiColour(ratioStr, wlColor) : ratioStr]
  };

  // Get window key formatted (e.g., "2026-02-17 | EU")
  const windowKey = session.windowKey ? session.windowKey.replace(/\|/g, ' | ') : 'Session Summary';

  // Format using formatRowTable with specified width
  const summary = formatRowTable(rowData, windowKey, width, true);

  return summary;
}

/**
 * Format complete session summary including player table
 * @param {Object} session - Session object
 * @param {number} startingPoints - Starting points
 * @param {number} endingPoints - Ending points
 * @param {number} startingPos - Starting position
 * @param {number} endingPos - Ending position
 * @param {Array} playerData - Array of player data for the table
 * @param {number} width - Width of the tables
 * @param {boolean} useAnsi - Whether to use ANSI colors
 * @returns {string} Complete formatted session summary
 */
function formatFullSessionSummary(session, startingPoints, endingPoints, startingPos, endingPos, playerData, width = 50, useAnsi = true) {
  // Format the session summary header
  const sessionSummary = formatSessionSummary(
    session,
    startingPoints,
    endingPoints,
    startingPos,
    endingPos,
    width,
    useAnsi
  );

  // Format the player table if data provided
  let playerTable = '';
  if (playerData && playerData.length > 0) {
    const tableData = playerData.map((x, i) => ({
      position: x.position < 21 ? ansiColour(x.position, 'cyan') : x.position,
      name: x.name,
      points: x.points < x.threshold ? ansiColour(x.points, 'yellow') : x.points,
      pointsDelta: x.pointsDelta < 0
        ? ansiColour(x.pointsDelta, 'red')
        : x.pointsDelta > 0
          ? ansiColour('+' + x.pointsDelta, 'green')
          : x.pointsDelta,
    }));

    const titleText = 'Player Summary';
    const fieldHeaders = ["Pos", "Name", "Points", "Δ"];
    const fieldOrder = ["position", "name", "points", "pointsDelta"];
    playerTable = formatTable(tableData, titleText, fieldHeaders, fieldOrder);
  }

  return sessionSummary + '\n' + playerTable;
}

module.exports = {
  ansiColour,
  formatTable,
  formatRowTable,
  formatTableLight,
  formatTableHeavy,
  formatSessionSummary,
  formatFullSessionSummary,
  visibleLength,
  padCell,
  isNumeric,
  sanitizeUsername,
  padCenter,
  padRight,
  padLeft,
};
