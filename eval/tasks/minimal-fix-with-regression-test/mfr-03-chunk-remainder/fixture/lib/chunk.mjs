export function chunk(items, size) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("size must be a positive integer");
  }
  const out = [];
  const fullChunks = Math.floor(items.length / size);
  for (let i = 0; i < fullChunks; i++) {
    out.push(items.slice(i * size, (i + 1) * size));
  }
  return out;
}
