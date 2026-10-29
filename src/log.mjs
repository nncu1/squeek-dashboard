// Terminal output: raw ANSI, UTC+7 timestamps, dot leaders at width 52.
const C = { reset: "\x1b[0m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m" };
const WIDTH = 52;

function ts() {
  const d = new Date(Date.now() + 7 * 3600e3);
  return d.toISOString().replace("T", " ").slice(0, 19);
}
function line(color, label, value = "") {
  const lead = label.length >= WIDTH ? " " : " " + ".".repeat(WIDTH - label.length - 1) + " ";
  console.log(`${C.dim}[${ts()}]${C.reset} ${label}${C.dim}${lead}${C.reset}${color}${value}${C.reset}`);
}

export const log = {
  info: (label, value) => line(C.cyan, label, value),
  ok: (label, value) => line(C.green, label, value),
  warn: (label, value) => line(C.yellow, label, value),
  err: (label, value) => line(C.red, label, value),
  title: (text) => console.log(`${C.bold}${C.green}${text}${C.reset}`),
};
