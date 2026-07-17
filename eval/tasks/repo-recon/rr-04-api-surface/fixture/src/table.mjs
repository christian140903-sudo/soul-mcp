export function toTable(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, String(cell).length);
    });
  }
  return rows.map((row) => row.map((cell, i) => _pad(String(cell), widths[i])).join(" | ")).join("\n");
}

// exportiert, aber nicht Teil der oeffentlichen API (kein Re-Export in index.mjs)
export function _pad(s, width) {
  return s + " ".repeat(width - s.length);
}
