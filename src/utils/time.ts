export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jitter(ms: number, ratio = 0.2): number {
  const spread = ms * ratio;
  return Math.max(0, Math.round(ms - spread + Math.random() * spread * 2));
}

export function nowIso(): string {
  return new Date().toISOString();
}
