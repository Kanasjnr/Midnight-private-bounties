// Display formatting for amounts, times and ids. Times are seconds since the
// Unix epoch as bigint, like block time and the contract's deadlines.

/** A whole token amount with thousands separators: 2,060. */
export function amount(n: bigint): string {
  return n.toLocaleString("en-US");
}

/** Wallet NIGHT (in STAR, 10^6 per NIGHT) or DUST (in SPECK, 10^15 per DUST), to `digits` decimals. */
export function units(raw: bigint, perUnit: bigint, digits = 2): string {
  const whole = raw / perUnit;
  const scale = 10n ** BigInt(digits);
  const frac = ((raw % perUnit) * scale) / perUnit;
  const fracText = digits > 0 && frac > 0n ? `.${frac.toString().padStart(digits, "0").replace(/0+$/, "")}` : "";
  return `${amount(whole)}${fracText}`;
}

export const STAR_PER_NIGHT = 1_000_000n;
export const SPECK_PER_DUST = 1_000_000_000_000_000n;

/** A span of seconds in its two largest units: 2d 4h, 3h 12m, 47m, 45s. */
export function span(seconds: bigint): string {
  const s = seconds < 0n ? -seconds : seconds;
  const d = s / 86_400n;
  const h = (s % 86_400n) / 3_600n;
  const m = (s % 3_600n) / 60n;
  if (d > 0n) return h > 0n ? `${d}d ${h}h` : `${d}d`;
  if (h > 0n) return m > 0n ? `${h}h ${m}m` : `${h}h`;
  if (m > 0n) return `${m}m`;
  return `${s}s`;
}

/** How long ago `t` was: "just now", "12m ago", "2d ago". */
export function ago(t: bigint, now: bigint): string {
  const d = now - t;
  if (d < 60n) return "just now";
  return `${span(d)} ago`;
}

/** A deadline relative to now: "Ends in 3h 12m" or "Ended 1d ago". */
export function deadlineText(deadline: bigint, now: bigint): string {
  return deadline > now ? `Ends in ${span(deadline - now)}` : `Ended ${ago(deadline, now)}`;
}

/** A local date and time for `t`: "Nov 2, 14:30". */
export function dateTime(t: bigint): string {
  return new Date(Number(t) * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** The first and last few characters of a long hex string or address. */
export function short(text: string, head = 8, tail = 6): string {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}
