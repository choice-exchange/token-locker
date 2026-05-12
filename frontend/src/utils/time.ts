// Timestamp helpers.
// CosmWasm Timestamps are u64 nanoseconds, serialized as decimal strings.

export function dateToNanos(d: Date): string {
    return (BigInt(d.getTime()) * 1_000_000n).toString();
}

export function secondsToNanos(s: number | bigint): string {
    return (BigInt(s) * 1_000_000_000n).toString();
}

export function nanosToMs(ns: string): number {
    return Number(BigInt(ns) / 1_000_000n);
}

export function nanosToDate(ns: string): Date {
    return new Date(nanosToMs(ns));
}

export function nowNanos(): string {
    return dateToNanos(new Date());
}

export function fmtDate(d: Date): string {
    return d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function fmtRelative(targetMs: number, nowMs: number): string {
    const diff = targetMs - nowMs;
    const abs = Math.abs(diff);
    const sec = Math.floor(abs / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    const future = diff > 0;
    const txt =
        day > 0
            ? `${day}d ${hr % 24}h`
            : hr > 0
              ? `${hr}h ${min % 60}m`
              : min > 0
                ? `${min}m ${sec % 60}s`
                : `${sec}s`;
    return future ? `in ${txt}` : `${txt} ago`;
}

// Format a datetime-local <input> value (yyyy-mm-ddTHH:MM) from a Date.
export function toLocalInput(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(s: string): Date | null {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}
