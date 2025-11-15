
function makeSeparator(str) {
  return str.replace(/[^│]/g, '═').replace(/│/g, '╪').replace(/^(.)(.*)(.)$/, "╞$2╡");
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
  let title = header.replace(/[^│]/g, '─').replace(/│/g, '─').replace(/^(.)(.*)(.)$/, "┌$2┐")+"\n";
  title += `│` + padCenter(str, header.length - 2, ' ') + `│\n`;
  title += header.replace(/[^│]/g, '─').replace(/│/g, '┬').replace(/^(.)(.*)(.)$/, "├$2┤");

  return title;
}
exports.makeTitle = makeTitle;

