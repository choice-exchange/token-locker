import { useMemo, useRef, useState } from "react";
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
                    <label>Unlock date and time</label>
                    <DateTimeField
                        value={cliffAt}
                        onChange={setCliffAt}
                        ariaLabel="Unlock date and time"
                    />
                    <CliffPresetSlider
                        current={cliffAt}
                        onPick={(days) => setCliffAt(toLocalInput(addDays(new Date(), days)))}
                    />
                    <p className="text-xs text-ink-300 mt-1">
                        100% claimable at this moment ({localTzLabel()}). Cliff is the only schedule that allows top-up + extend.
                    </p>
                </div>
            )}

            {kind === "linear" && (
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label>Start at</label>
                        <DateTimeField
                            value={startAt}
                            onChange={setStartAt}
                            ariaLabel="Vest start date and time"
                        />
                    </div>
                    <div>
                        <label>End at</label>
                        <DateTimeField
                            value={endAt}
                            onChange={setEndAt}
                            ariaLabel="Vest end date and time"
                        />
                    </div>
                    <p className="col-span-2 text-xs text-ink-300">
                        Linear vest: 0% at start → 100% at end ({localTzLabel()}). Immutable; no top-up / extend.
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
                                <DateTimeField
                                    value={row.when}
                                    onChange={(v) => updateStep(setSteps, i, { when: v })}
                                    ariaLabel={`Breakpoint ${i + 1} date and time`}
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

// One-stop datetime input: clicking anywhere opens the native picker (via
// HTMLInputElement.showPicker) rather than only the small webkit indicator at
// the right edge. Keeps typing/arrow-key editing intact for keyboard users.
function DateTimeField({
    value,
    onChange,
    ariaLabel,
    className = "",
}: {
    value: string;
    onChange: (v: string) => void;
    ariaLabel?: string;
    className?: string;
}) {
    const ref = useRef<HTMLInputElement>(null);
    const openPicker = () => {
        const el = ref.current;
        if (!el) return;
        // showPicker exists in Chromium/Firefox; Safari falls back to focus,
        // which still surfaces the inline date wheel on touch devices.
        if (typeof el.showPicker === "function") {
            try { el.showPicker(); } catch { /* user-activation race; ignore */ }
        } else {
            el.focus();
        }
    };
    return (
        <div className="relative w-full">
            <input
                ref={ref}
                type="datetime-local"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onClick={openPicker}
                onFocus={openPicker}
                aria-label={ariaLabel}
                className={`!pr-10 ${className}`}
            />
            <button
                type="button"
                onClick={openPicker}
                tabIndex={-1}
                aria-label="Open date picker"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-primaryColor hover:opacity-80"
            >
                <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current" aria-hidden="true">
                    <path d="M7 11h2v2H7v-2zm0 4h2v2H7v-2zm4-4h2v2h-2v-2zm0 4h2v2h-2v-2zm4-4h2v2h-2v-2zm0 4h2v2h-2v-2zM5 22h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2zm0-16h14v14H5V6z"/>
                </svg>
            </button>
        </div>
    );
}

// Continuous day-scale slider — drag to set the cliff to any duration from 0
// days up to MAX_CLIFF_DAYS. Manual edits via the datetime input still work;
// the slider just tracks whatever the current value resolves to.
const MAX_CLIFF_DAYS = 730;
const CLIFF_PRESETS = [
    { label: "now", days: 0 },
    { label: "1mo", days: 30 },
    { label: "6mo", days: 180 },
    { label: "12mo", days: 365 },
    { label: "24mo", days: 730 },
] as const;

function CliffPresetSlider({
    current,
    onPick,
}: {
    current: string;
    onPick: (days: number) => void;
}) {
    const currentDays = useMemo(() => deltaDays(current), [current]);
    const sliderValue = Math.max(0, Math.min(MAX_CLIFF_DAYS, currentDays));
    return (
        <div className="mt-2">
            <div className="flex justify-between text-xs mb-1 select-none">
                <span className="text-ink-300">Duration</span>
                <span className="text-primaryColor font-semibold">{formatDuration(currentDays)}</span>
            </div>
            <input
                type="range"
                min={0}
                max={MAX_CLIFF_DAYS}
                step={1}
                value={sliderValue}
                onChange={(e) => onPick(parseInt(e.target.value, 10))}
                aria-label="Quick unlock duration"
                className="w-full accent-primaryColor cursor-pointer"
            />
            <div className="flex justify-between text-xs mt-1 select-none">
                {CLIFF_PRESETS.map((p) => (
                    <button
                        key={p.label}
                        type="button"
                        onClick={() => onPick(p.days)}
                        className={
                            "px-1 rounded transition-colors " +
                            (Math.abs(currentDays - p.days) <= 1
                                ? "text-primaryColor font-semibold"
                                : "text-ink-300 hover:text-ink-100")
                        }
                    >
                        {p.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

function deltaDays(localInputValue: string): number {
    const d = fromLocalInput(localInputValue);
    if (!d) return 0;
    const deltaMs = d.getTime() - Date.now();
    return Math.round(deltaMs / (24 * 3600 * 1000));
}

function formatDuration(days: number): string {
    if (days <= 0) return "now";
    if (days < 30) return `${days}d`;
    const years = Math.floor(days / 365);
    const remAfterY = days - years * 365;
    const months = Math.floor(remAfterY / 30);
    const remDays = remAfterY - months * 30;
    const parts: string[] = [];
    if (years > 0) parts.push(`${years}y`);
    if (months > 0) parts.push(`${months}mo`);
    if (remDays > 0 && years === 0) parts.push(`${remDays}d`);
    return parts.join(" ");
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 3600 * 1000);
}

function localTzLabel(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
        return "local time";
    }
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
