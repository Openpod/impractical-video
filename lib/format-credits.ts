export function formatCredits(credits: number): string {
  return credits.toLocaleString();
}

export function formatCreditsWithUnit(credits: number): string {
  return `${formatCredits(credits)} credit${credits === 1 ? "" : "s"}`;
}
