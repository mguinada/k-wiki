/** The first item of a list, undefined for an empty or missing list. */
export function firstItem(items: string[] | undefined): string | undefined {
  return items?.[0];
}

/** How many labels a list carries; logs the count for operators. */
export function labelCount(labels: string[]): number {
  console.debug("labels: " + labels.length);

  return labels.length;
}
