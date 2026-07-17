export function parseCsv(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => splitLine(line));
}

// bewusst NICHT exportiert: internes Detail
function splitLine(line) {
  return line.split(",").map((cell) => cell.trim());
}
