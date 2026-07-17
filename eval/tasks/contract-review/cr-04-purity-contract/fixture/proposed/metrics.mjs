// "Performance-Verbesserung": Memoization + weniger Kopien
let statsCache = new Map();

export function computeStats(values) {
  const key = values.join(",");
  if (statsCache.has(key)) return statsCache.get(key);
  let sum = 0;
  for (const v of values) sum += v;
  const mean = values.length === 0 ? 0 : sum / values.length;
  const result = { count: values.length, sum, mean };
  statsCache.set(key, result);
  return result;
}

export function topN(values, n) {
  // spart die Array-Kopie
  const sorted = values.sort((a, b) => b - a);
  return sorted.slice(0, n);
}

export function summarize(values) {
  const stats = computeStats(values);
  return { ...stats, top3: topN(values, 3), generatedAt: Date.now() };
}
