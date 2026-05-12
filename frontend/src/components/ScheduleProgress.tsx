import { Decimal } from "decimal.js";
import type { Lock } from "../types/locker";
import { isLinear, isPiecewise } from "../types/locker";
import { claimableAt, scheduleBounds } from "../utils/schedule";

interface Props {
    lock: Lock;
    nowMs: number;
}

/** Renders a horizontal progress bar showing what % is unlocked right now. */
export function ScheduleProgress({ lock, nowMs }: Props) {
    const total = new Decimal(lock.total || "0");
    if (total.isZero()) return null;

    const claimableNow = new Decimal(claimableAt(lock.schedule, lock.total, nowMs));
    const withdrawn = new Decimal(lock.withdrawn || "0");

    const pctUnlocked = clamp(claimableNow.div(total).mul(100).toNumber(), 0, 100);
    const pctWithdrawn = clamp(withdrawn.div(total).mul(100).toNumber(), 0, 100);

    const { startMs, endMs } = scheduleBounds(lock.schedule);
    const isVesting = isLinear(lock.schedule) || isPiecewise(lock.schedule);

    return (
        <div className="space-y-1">
            <div className="relative h-2 rounded-full bg-ink-700 overflow-hidden">
                <div
                    className="absolute inset-y-0 left-0 bg-accent-700"
                    style={{ width: `${pctUnlocked}%` }}
                    title={`${pctUnlocked.toFixed(2)}% unlocked`}
                />
                <div
                    className="absolute inset-y-0 left-0 bg-good"
                    style={{ width: `${pctWithdrawn}%` }}
                    title={`${pctWithdrawn.toFixed(2)}% withdrawn`}
                />
            </div>
            {isVesting && (
                <div className="flex justify-between text-[10px] text-ink-300 font-mono">
                    <span>{shortAt(startMs)}</span>
                    <span>{shortAt(endMs)}</span>
                </div>
            )}
        </div>
    );
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

function shortAt(ms: number): string {
    if (ms === 0) return "—";
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}
