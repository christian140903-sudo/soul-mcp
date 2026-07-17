import { formatCurrency } from "./format.mjs";
import { add } from "./math.mjs";

export function invoiceTotal(lines) {
  let cents = 0;
  for (const line of lines) {
    cents = add(cents, line.cents);
  }
  return formatCurrency(cents);
}
