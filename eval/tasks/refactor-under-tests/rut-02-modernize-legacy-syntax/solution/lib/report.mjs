export function makeReport(title, rows) {
  const lines = rows.map((row) => `${row.name}: ${row.value}`);
  return title + "\n" + lines.join("\n");
}

export function totalOf(...values) {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
