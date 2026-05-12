import { Decimal } from "decimal.js";
import type { Schedule } from "../types/locker";
import { isCliff, isLinear, isPiecewise } from "../types/locker";

// Port of contracts/locker/src/schedule.rs `claimable_at`.
// Returns the cumulative amount unlocked at time `tMs` for a lock with `totalBase`.
//
// All math in Decimal to preserve the contract's Uint256-internal precision.
// Result is a non-negative base-units string ≤ totalBase.
export function claimableAt(schedule: Schedule, totalBase: string, tMs: number): string {
    const total = new Decimal(totalBase || "0");
    if (total.isZero()) return "0";

    if (isCliff(schedule)) {
        const unlockMs = Number(BigInt(schedule.cliff.unlock_at) / 1_000_000n);
        return tMs >= unlockMs ? total.toFixed(0) : "0";
    }

    if (isLinear(schedule)) {
        const startMs = Number(BigInt(schedule.saturating_linear.start_at) / 1_000_000n);
        const endMs = Number(BigInt(schedule.saturating_linear.end_at) / 1_000_000n);
        if (tMs <= startMs) return "0";
        if (tMs >= endMs) return total.toFixed(0);
        const num = new Decimal(tMs - startMs);
        const den = new Decimal(endMs - startMs);
        return total.mul(num).div(den).toFixed(0, Decimal.ROUND_DOWN);
    }

    if (isPiecewise(schedule)) {
        const steps = schedule.piecewise_linear.steps.map(
            ([ts, amt]) => [Number(BigInt(ts) / 1_000_000n), new Decimal(amt)] as const,
        );
        if (steps.length === 0) return "0";
        if (tMs <= steps[0][0]) return "0";
        const last = steps[steps.length - 1];
        if (tMs >= last[0]) return last[1].toFixed(0);
        for (let i = 1; i < steps.length; i++) {
            const [tPrev, vPrev] = steps[i - 1];
            const [tNext, vNext] = steps[i];
            if (tMs <= tNext) {
                const num = new Decimal(tMs - tPrev);
                const den = new Decimal(tNext - tPrev);
                const delta = vNext.minus(vPrev).mul(num).div(den);
                return vPrev.plus(delta).toFixed(0, Decimal.ROUND_DOWN);
            }
        }
    }

    return "0";
}

// Returns t0 (first non-zero), tEnd (fully unlocked), totalAtEnd for progress bar drawing.
export function scheduleBounds(schedule: Schedule): { startMs: number; endMs: number } {
    if (isCliff(schedule)) {
        const u = Number(BigInt(schedule.cliff.unlock_at) / 1_000_000n);
        return { startMs: u, endMs: u };
    }
    if (isLinear(schedule)) {
        return {
            startMs: Number(BigInt(schedule.saturating_linear.start_at) / 1_000_000n),
            endMs: Number(BigInt(schedule.saturating_linear.end_at) / 1_000_000n),
        };
    }
    if (isPiecewise(schedule)) {
        const steps = schedule.piecewise_linear.steps;
        if (steps.length === 0) return { startMs: 0, endMs: 0 };
        return {
            startMs: Number(BigInt(steps[0][0]) / 1_000_000n),
            endMs: Number(BigInt(steps[steps.length - 1][0]) / 1_000_000n),
        };
    }
    return { startMs: 0, endMs: 0 };
}

export function scheduleKindLabel(s: Schedule): string {
    if (isCliff(s)) return "Cliff";
    if (isLinear(s)) return "Linear vest";
    if (isPiecewise(s)) return "Piecewise";
    return "Unknown";
}
