export function buildQuery(params) {
  return Object.entries(params)
    .map(([key, value]) => key + "=" + value)
    .join("&");
}
