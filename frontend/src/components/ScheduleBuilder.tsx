import { useMemo, useState } from "react";
import type { Schedule } from "../types/locker";
import { fromLocalInput, toLocalInput, dateToNanos } from "../utils/time";
import { toBaseUnits } from "../utils/amount";

export type ScheduleKind = "cliff" | "linear" | "piecewise";

interface Props {
    kind: ScheduleKind;
    onKindChange: (k: ScheduleKind) => void;
    /** Amount in base units — only needed for piecewise's "final equals total" check. */
    totalBase: string;
    /** Decimals — for piecewise per-step input. */
    decimals: number;
    /** Emits validated Schedule or null. Also surfaces a human-readable error. */
    onChange: (out: { schedule: Schedule | null; error?: string }) => void;
}

interface PiecewiseRow {
    when: string; // local input
    cumulative: string; // human amount
}

export function ScheduleBuilder({
    kind,
    onKindChange,
    totalBase,
    decimals,
    onChange,
}: Props) {
    // --- Cliff state ---
    const [cliffAt, setCliffAt] = useState<string>(toLocalInput(in7Days()));

    // --- Linear state ---
    const [startAt, setStartAt] = useState<string>(toLocalInput(in1Day()));
    const [endAt, setEndAt] = useState<string>(toLocalInput(in30Days()));

    // --- Piecewise state ---
    const [steps, setSteps] = useState<PiecewiseRow[]>(() => [
        { when: toLocalInput(in7Days()), cumulative: "0" },
        { when: toLocalInput(in30Days()), cumulative: "" },
    ]);

    // Recompute on every render with the current inputs.
    const out = useMemo<{ schedule: Schedule | null; error?: string }>(() => {
        try {
            if (kind === "cliff") {
                const d = fromLocalInput(cliffAt);
                if (!d) return { schedule: null, error: "Pick an unlock date" };
                if (d.getTime() <= Date.now()) return { schedule: null, error: "Unlock must be in the future" };
                return { schedule: { cliff: { unlock_at: dateToNanos(d) } } };
            }
            if (kind === "linear") {
                const s = fromLocalInput(startAt);
                const e = fromLocalInput(endAt);
                if (!s || !e) return { schedule: null, error: "Pick start + end dates" };
                if (s.getTime() >= e.getTime()) return { schedule: null, error: "End must be after start" };
                return {
                    schedule: {
                        saturating_linear: {
                            start_at: dateToNanos(s),
                            end_at: dateToNanos(e),
                        },
                    },
                };
            }
            // piecewise
            if (steps.length < 2) return { schedule: null, error: "Need at least 2 breakpoints" };
            if (steps.length > 50) return { schedule: null, error: "Max 50 breakpoints" };
            const built: [string, string][] = [];
            let prevMs = -Infinity;
            let prevCum = -1n;
            for (let i = 0; i < steps.length; i++) {
                const row = steps[i];
                const d = fromLocalInput(row.when);
                if (!d) return { schedule: null, error: `Step ${i + 1}: bad date` };
                if (d.getTime() <= prevMs)
                    return { schedule: null, error: `Step ${i + 1}: dates must be strictly ascending` };
                const cum = toBaseUnits(row.cumulative || "0", decimals);
                const cumBig = BigInt(cum);
                if (cumBig < prevCum)
                    return {
                        schedule: null,
                        error: `Step ${i + 1}: cumulative cannot decrease`,
                    };
                built.push([dateToNanos(d), cum]);
                prevMs = d.getTime();
                prevCum = cumBig;
            }
            // Final cumulative must equal total
            if (totalBase && BigInt(built[built.length - 1][1]) !== BigInt(totalBase)) {
                return {
                    schedule: null,
                    error: `Final cumulative must equal total (${totalBase})`,
                };
            }
            return { schedule: { piecewise_linear: { steps: built } } };
        } catch (e) {
            return { schedule: null, error: e instanceof Error ? e.message : String(e) };
        }
    }, [kind, cliffAt, startAt, endAt, steps, totalBase, decimals]);

    // Surface to parent on changes
    useEffectish(() => onChange(out), [out.schedule, out.error]);

    return (
        <div className="space-y-3">
            <div className="flex gap-1 p-1 bg-ink-700 rounded-md w-fit">
                {(["cliff", "linear", "piecewise"] as const).map((k) => (
                    <button
                        key={k}
                        type="button"
                        className={`px-3 py-1 text-xs rounded ${kind === k ? "bg-primaryColor text-black" : "text-ink-200 hover:text-ink-100"}`}
                        onClick={() => onKindChange(k)}
                    >
                        {k === "cliff" ? "Cliff" : k === "linear" ? "Linear vest" : "Piecewise"}
                    </button>
                ))}
            </div>

            {kind === "cliff" && (
                <div>
                    <label>Unlock at</label>
                    <input
                        type="datetime-local"
                        value={cliffAt}
                        onChange={(e) => setCliffAt(e.target.value)}
                    />
                    <p className="text-xs text-ink-300 mt-1">
                        100% claimable at this moment. Cliff is the only schedule that allows top-up + extend.
                    </p>
                </div>
            )}

            {kind === "linear" && (
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label>Start at</label>
                        <input
                            type="datetime-local"
                            value={startAt}
                            onChange={(e) => setStartAt(e.target.value)}
                        />
                    </div>
                    <div>
                        <label>End at</label>
                        <input
                            type="datetime-local"
                            value={endAt}
                            onChange={(e) => setEndAt(e.target.value)}
                        />
                    </div>
                    <p className="col-span-2 text-xs text-ink-300">
                        Linear vest: 0% at start → 100% at end. Immutable; no top-up / extend.
                    </p>
                </div>
            )}

            {kind === "piecewise" && (
                <div className="space-y-2">
                    <p className="text-xs text-ink-300">
                        Breakpoints of <em>cumulative</em> claimable amount. Times must strictly ascend; cumulative
                        is non-decreasing. The last row must equal the lock total.
                    </p>
                    <div className="space-y-1">
                        {steps.map((row, i) => (
                            <div key={i} className="flex gap-2 items-center">
                                <span className="text-xs text-ink-300 w-6">{i + 1}.</span>
                                <input
                                    type="datetime-local"
                                    value={row.when}
                                    onChange={(e) => updateStep(setSteps, i, { when: e.target.value })}
                                    className="!py-1.5 !text-xs"
                                />
                                <input
                                    type="text"
                                    placeholder="cumulative"
                                    value={row.cumulative}
                                    onChange={(e) =>
                                        updateStep(setSteps, i, { cumulative: e.target.value })
                                    }
                                    className="!py-1.5 !text-xs"
                                />
                                <button
                                    type="button"
                                    className="btn-ghost !py-1 !px-2 !text-xs"
                                    onClick={() =>
                                        setSteps((s) => s.filter((_, j) => j !== i))
                                    }
                                    disabled={steps.length <= 2}
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                    </div>
                    <button
                        type="button"
                        className="btn-secondary !py-1 !px-2 !text-xs"
                        onClick={() =>
                            setSteps((s) => [...s, { when: toLocalInput(in30Days()), cumulative: "" }])
                        }
                    >
                        + Add breakpoint
                    </button>
                </div>
            )}

            {out.error && <div className="text-xs text-bad">{out.error}</div>}
        </div>
    );
}

function updateStep(
    setSteps: React.Dispatch<React.SetStateAction<PiecewiseRow[]>>,
    i: number,
    patch: Partial<PiecewiseRow>,
) {
    setSteps((s) => s.map((row, j) => (i === j ? { ...row, ...patch } : row)));
}

function in1Day() {
    return new Date(Date.now() + 24 * 3600 * 1000);
}
function in7Days() {
    return new Date(Date.now() + 7 * 24 * 3600 * 1000);
}
function in30Days() {
    return new Date(Date.now() + 30 * 24 * 3600 * 1000);
}

// Tiny wrapper to silence the lint about non-stable deps; uses useEffect.
import { useEffect } from "react";
function useEffectish(fn: () => void, deps: unknown[]) {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(fn, deps);
}
