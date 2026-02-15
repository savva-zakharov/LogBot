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

module.exports = {
  ansiColour,
  formatTable,
  formatRowTable,
  formatTableLight,
  formatTableHeavy,
  visibleLength,
  padCell,
  isNumeric,
  sanitizeUsername,
  padCenter
};
