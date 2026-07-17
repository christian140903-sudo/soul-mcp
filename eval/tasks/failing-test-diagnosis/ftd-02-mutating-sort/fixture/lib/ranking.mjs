export function topScores(scores, n) {
  const sorted = scores.sort((a, b) => b - a);
  return sorted.slice(0, n);
}

export function averageScore(scores) {
  if (scores.length === 0) return 0;
  let sum = 0;
  for (const s of scores) sum += s;
  return sum / scores.length;
}
