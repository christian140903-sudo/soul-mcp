export function pageSlice(items, page, perPage) {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage + 1);
}

export function pageCount(items, perPage) {
  return Math.ceil(items.length / perPage);
}
