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

function makeSeparator(str) {
  const settings = loadSettings();
  if (settings.tableStyle === 'light') {
    return str.replace(/[^│]/g, '─').replace(/(?<=.)\|(?=.)/g, '┼').replace(/^\|/, '├').replace(/\|$/, '┤');
  } else {
    return str.replace(/[^│]/g, '═').replace(/(?<=.)\|(?=.)/g, '╪').replace(/^\|/, '╞').replace(/\|$/, '╡');
  }
}
exports.makeSeparator = makeSeparator;

function makeStarter(str) {
  return str.replace(/[^│]/g, '─').replace(/│/g, '┬').replace(/^(.)(.*)(.)$/, "┌$2┐");
}
exports.makeStarter = makeStarter;

function makeCloser(str) {
  return str.replace(/[^│]/g, '─').replace(/│/g, '┴').replace(/^(.)(.*)(.)$/, "└$2┘");
}
exports.makeCloser = makeCloser;

function padCenter(str, length, pad = ' ') {
  const totalPadding = length - str.length;
  if (totalPadding <= 0) return str;

  const padStart = Math.floor(totalPadding / 2);
  const padEnd = Math.ceil(totalPadding / 2);

  return pad.repeat(padStart) + str + pad.repeat(padEnd);
}
exports.padCenter = padCenter;

function ansiColour(str, colour, bold = false) {
  return `\u001b[${bold ? 1 : 0};${colour}m${str}\u001b[0m`;
}
exports.ansiColour = ansiColour;

function makeTitle(str, header) {
  let title = header.replace(/[^│]/g, '─').replace(/│/g, '─').replace(/^(.)(.*)(.)$/, "┌$2┐") + "\n";
  title += `│` + padCenter(str, header.length - 2, ' ') + `│\n`;
  title += header.replace(/[^│]/g, '─').replace(/│/g, '┬').replace(/^(.)(.*)(.)$/, "├$2┤");

  return title;
}
exports.makeTitle = makeTitle;

function makeTitleLight(str, header) {
  title += `│` + padCenter(str, header.length - 2, ' ') + `│\n`;
  title += header.replace(/[^│]/g, '─').replace(/│/g, '┬').replace(/^(.)(.*)(.)$/, "├$2┤");

  return title;
}
exports.makeTitleLight = makeTitleLight;

function formatTableLight(data, title = null, header = null, order = null, compact = false) {
  if (!header) {
    header = Object.keys(data[0]);
  }

  let matrix = [header, ...data.map(obj => order.map(f => String(obj[f])))];

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
    starter = makeTitleLight(title, body.split("\n")[0]);
    separator = makeSeparator(body.split("\n")[0]);
    body = starter + '\n' + separator + '\n' + body;
  }

  return body;
}
exports.formatTableLight = formatTableLight;

function formatTableHeavy(data, title = null, header = null, order = null, compact = false) {
  if (!header) {
    header = Object.keys(data[0]);
  }

  let matrix = [header, ...data.map(obj => order.map(f => String(obj[f])))];

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
  let divider = compact ? '│' : '│ ';

  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    matrix[i] = row.map((s, j) => padCell(s, colMaxLengths[j], 'left'));
    body += divider + matrix[i].join(divider) + divider + '\n';
  }

  let starter = makeStarter(body.split("\n")[0]);
  let separator = makeSeparator(body.split("\n")[0]);
  let closer = makeCloser(body.split("\n")[0]);

  body = starter + '\n' + body + closer;

  return body;
}
exports.formatTableHeavy = formatTableHeavy;

function formatTable(data, title = null, header = null, order = null, compact = false) {
  const settings = loadSettings();
  if (settings.tableStyle === 'light') {
    return formatTableLight(data, title, header, order, compact);
  }
  return formatTableHeavy(data, title, header, order, compact);
}
exports.formatTable = formatTable;

function visibleLength(str) {
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  return str.replace(ansiRegex, "").length;
}

exports.visibleLength = visibleLength;
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
exports.isNumeric = isNumeric;

function sanitizeUsername(name) {
    return name
      .replace(/@(psn|live)\b/gi, "")
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, "")
      .trim();
}
exports.sanitizeUsername = sanitizeUsername;
