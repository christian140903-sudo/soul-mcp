import { multiply } from "./math.mjs";

export function formatCurrency(cents) {
  const eur = multiply(cents, 0.01);
  return eur.toFixed(2) + " EUR";
}
