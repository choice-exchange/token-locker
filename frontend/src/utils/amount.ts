import { Decimal } from "decimal.js";

Decimal.set({ precision: 50 });

// Human-readable amount ("1.23") → base-units string ("1230000000000000000" for 18).
export function toBaseUnits(human: string, decimals: number): string {
    const clean = (human || "0").trim();
    if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") return "0";
    return new Decimal(clean).mul(new Decimal(10).pow(decimals)).toFixed(0);
}

// Base-units string → human Decimal ("1230000000000000000" → "1.23")
export function fromBaseUnits(base: string, decimals: number, maxFrac = 6): string {
    if (!base) return "0";
    const d = new Decimal(base).div(new Decimal(10).pow(decimals));
    return trimZeros(d.toFixed(Math.min(decimals, maxFrac)));
}

function trimZeros(s: string): string {
    if (!s.includes(".")) return s;
    return s.replace(/0+$/, "").replace(/\.$/, "");
}

// Pretty-print large base-units with thin separators when no decimals known.
export function fmtBaseUnits(base: string): string {
    if (!base) return "0";
    return base.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Compare two base-units strings: -1 / 0 / 1.
export function cmpBase(a: string, b: string): number {
    const da = new Decimal(a || "0");
    const db = new Decimal(b || "0");
    return da.cmp(db);
}

export function maxBase(a: string, b: string): string {
    return cmpBase(a, b) >= 0 ? a : b;
}
