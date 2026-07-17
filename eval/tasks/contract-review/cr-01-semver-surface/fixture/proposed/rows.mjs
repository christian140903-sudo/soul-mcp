export function parseRow(line, delimiter) {
  if (delimiter === undefined) {
    throw new TypeError("delimiter is required");
  }
  const cells = line.split(delimiter).map((c) => c.trim());
  return { cells, raw: line };
}

export function rowCount(rows) {
  return rows.length;
}

// neu: JSON-Export
export function toJson(rows) {
  return JSON.stringify(rows.map((row) => row.cells));
}
