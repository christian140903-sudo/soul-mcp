// Eintraege stammen aus einem CSV-Import: { amount: "12" } — amount ist ein String.
export function sumAmounts(entries) {
  let total = 0;
  for (const entry of entries) {
    total += entry.amount;
  }
  return total;
}

export function countEntries(entries) {
  return entries.length;
}
