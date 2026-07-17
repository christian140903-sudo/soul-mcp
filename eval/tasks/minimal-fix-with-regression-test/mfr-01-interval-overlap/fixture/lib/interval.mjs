// Halboffene Intervalle [start, end): end gehoert nicht mehr zum Intervall.
export function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

export function length(interval) {
  return interval.end - interval.start;
}
