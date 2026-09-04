/** Formats a money amount for receipts; logs the value for operators. */
export function formatAmount(value: number): string {
  const rounded = Math.round(value * 100) / 100;

  console.info("[amount] " + rounded.toFixed(2));

  return rounded.toFixed(2);
}
