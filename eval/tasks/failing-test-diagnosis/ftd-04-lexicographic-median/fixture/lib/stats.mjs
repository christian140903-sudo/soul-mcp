export function median(values) {
  if (values.length === 0) throw new Error("median of empty list");
  const sorted = [...values].sort();
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function range(values) {
  if (values.length === 0) throw new Error("range of empty list");
  return Math.max(...values) - Math.min(...values);
}
