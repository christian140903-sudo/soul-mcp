export function parseRow(line) {
  const cells = line.split(",").map((c) => c.trim());
  return { cells, raw: line };
}

export function toCsv(rows) {
  return rows.map((row) => row.cells.join(",")).join("\n");
}

export function rowCount(rows) {
  return rows.length;
}
