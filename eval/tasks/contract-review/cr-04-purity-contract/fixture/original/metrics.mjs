export function computeStats(values) {
  let sum = 0;
  for (const v of values) sum += v;
  const mean = values.length === 0 ? 0 : sum / values.length;
  return { count: values.length, sum, mean };
}

export function topN(values, n) {
  const sorted = [...values].sort((a, b) => b - a);
  return sorted.slice(0, n);
}

export function summarize(values) {
  const stats = computeStats(values);
  return { ...stats, top3: topN(values, 3) };
}
