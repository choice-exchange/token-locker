import { useState } from "react";
import { toast } from "react-toastify";
import { Decimal } from "decimal.js";
import type { ClaimableManyEntry, Lock } from "../types/locker";
import { isCliff, isLinear, isPiecewise, denomLabel } from "../types/locker";
import { fmtBaseUnits } from "../utils/amount";
import { fmtDate, fmtRelative, nanosToDate, dateToNanos, fromLocalInput, toLocalInput } from "../utils/time";
import { claimableAt, scheduleKindLabel } from "../utils/schedule";
import { ScheduleProgress } from "./ScheduleProgress";
import { useNow } from "../hooks/useNow";
import { useLockerAddress, useWallet } from "../wallet/useWallet";
import { NETWORKS } from "../constants";
import {
    buildExtend,
    buildTopUpCw20,
    buildTopUpNative,
    buildTransferOwner,
    buildWithdraw,
} from "../chain/locker";
import { broadcast } from "../wallet/walletStrategy";

interface Props {
    lock: Lock;
    claimableEntry?: ClaimableManyEntry;
    onMutated?: () => void;
    /** Highlight that the connected wallet owns this lock — enables owner-only actions. */
    isOwner: boolean;
}

type Action = "withdraw" | "topup" | "extend" | "transfer" | null;

export function LockCard({ lock, claimableEntry, onMutated, isOwner }: Props) {
    const now = useNow();
    const network = useWallet((s) => s.network);
    const address = useWallet((s) => s.address);
    const contract = useLockerAddress();
    const explorerUrl = NETWORKS[network].explorerUrl;

    const [action, setAction] = useState<Action>(null);

    const isCw20 = "cw20" in lock.denom;
    const denomStr = denomLabel(lock.denom);
    const denomShort = isCw20 ? `cw20:${shorten(denomStr)}` : denomStr;

    // Live client-side claimable (smooth, no chain roundtrip).
    const liveClaimable = claimableAt(lock.schedule, lock.total, now);
    const liveAvailable = (() => {
        const c = new Decimal(liveClaimable);
        const w = new Decimal(lock.withdrawn || "0");
        const d = c.sub(w);
        return d.isNegative() ? "0" : d.toFixed(0);
    })();

    // On-chain claimable (fresher truth, used as the "withdraw all" amount).
    const onchainAvailable = claimableEntry?.response?.claimable ?? liveAvailable;

    const fullyUnlocked = (() => {
        if (isCliff(lock.schedule)) {
            return nanosToDate(lock.schedule.cliff.unlock_at).getTime() <= now;
        }
        if (isLinear(lock.schedule)) {
            return nanosToDate(lock.schedule.saturating_linear.end_at).getTime() <= now;
        }
        if (isPiecewise(lock.schedule)) {
            const steps = lock.schedule.piecewise_linear.steps;
            return steps.length > 0 && nanosToDate(steps[steps.length - 1][0]).getTime() <= now;
        }
        return false;
    })();

    const closeAction = () => setAction(null);

    async function run<T>(fn: () => Promise<T>, label: string) {
        if (!address) {
            toast.error("Connect wallet first");
            return;
        }
        try {
            const res = await fn();
            const txHash = (res as { txHash?: string }).txHash;
            toast.success(
                <div>
                    <div>{label} confirmed</div>
                    {txHash && (
                        <a
                            href={`${explorerUrl}/transaction/${txHash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-accent-400 underline text-xs"
                        >
                            View transaction
                        </a>
                    )}
                </div>,
            );
            closeAction();
            onMutated?.();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toast.error(`${label} failed: ${msg}`);
        }
    }

    return (
        <div className="card space-y-3">
            <div className="row">
                <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                        <span className="pill">#{lock.id}</span>
                        <span className="pill">{scheduleKindLabel(lock.schedule)}</span>
                        {fullyUnlocked && <span className="pill !bg-good/20 !text-good">Unlocked</span>}
                        {isCw20 && <span className="pill !bg-warn/20 !text-warn">cw20</span>}
                    </div>
                    <div className="text-sm font-medium">{lock.title || "(no title)"}</div>
                    {lock.description && (
                        <div className="text-xs text-ink-300 max-w-md">{lock.description}</div>
                    )}
                </div>
                <div className="text-right">
                    <div className="text-xs text-ink-300">Total</div>
                    <div className="font-mono text-sm">
                        {fmtBaseUnits(lock.total)} <span className="text-ink-300">{denomShort}</span>
                    </div>
                </div>
            </div>

            <ScheduleProgress lock={lock} nowMs={now} />

            <div className="grid grid-cols-3 gap-2 text-xs">
                <Stat label="Claimable" value={fmtBaseUnits(liveAvailable)} accent />
                <Stat label="Withdrawn" value={fmtBaseUnits(lock.withdrawn)} />
                <Stat
                    label={fullyUnlocked ? "Fully unlocked" : "Unlocks"}
                    value={milestoneLabel(lock, now)}
                />
            </div>

            <div className="text-[10px] font-mono text-ink-300 flex flex-wrap gap-x-3">
                <span title="Current owner">owner {shorten(lock.owner)}</span>
                {lock.owner !== lock.creator && (
                    <span title="Original depositor">creator {shorten(lock.creator)}</span>
                )}
                <span>created {fmtDate(nanosToDate(lock.created_at))}</span>
            </div>

            {isOwner && (
                <div className="flex flex-wrap gap-2 pt-1">
                    <button
                        className="btn-primary !py-1.5 !text-xs"
                        onClick={() => setAction("withdraw")}
                        disabled={new Decimal(onchainAvailable || "0").isZero()}
                    >
                        Withdraw
                    </button>
                    {isCliff(lock.schedule) && !fullyUnlocked && (
                        <>
                            <button className="btn-secondary !py-1.5 !text-xs" onClick={() => setAction("topup")}>
                                Top up
                            </button>
                            <button className="btn-secondary !py-1.5 !text-xs" onClick={() => setAction("extend")}>
                                Extend
                            </button>
                        </>
                    )}
                    <button className="btn-secondary !py-1.5 !text-xs" onClick={() => setAction("transfer")}>
                        Transfer owner
                    </button>
                </div>
            )}

            {action === "withdraw" && (
                <WithdrawForm
                    available={onchainAvailable}
                    denomShort={denomShort}
                    onCancel={closeAction}
                    onSubmit={(amount) =>
                        run(
                            () =>
                                broadcast(
                                    network,
                                    address!,
                                    buildWithdraw({
                                        sender: address!,
                                        contract,
                                        id: lock.id,
                                        amount,
                                    }),
                                ),
                            "Withdraw",
                        )
                    }
                />
            )}
            {action === "topup" && (
                <TopUpForm
                    isCw20={isCw20}
                    denomStr={denomStr}
                    onCancel={closeAction}
                    onSubmit={(amount) =>
                        run(
                            () =>
                                broadcast(
                                    network,
                                    address!,
                                    isCw20
                                        ? buildTopUpCw20({
                                              sender: address!,
                                              contract,
                                              id: lock.id,
                                              cw20: denomStr,
                                              amount,
                                          })
                                        : buildTopUpNative({
                                              sender: address!,
                                              contract,
                                              id: lock.id,
                                              denom: denomStr,
                                              amount,
                                          }),
                                ),
                            "Top up",
                        )
                    }
                />
            )}
            {action === "extend" && isCliff(lock.schedule) && (
                <ExtendForm
                    currentUnlockMs={nanosToDate(lock.schedule.cliff.unlock_at).getTime()}
                    onCancel={closeAction}
                    onSubmit={(newUnlockNanos) =>
                        run(
                            () =>
                                broadcast(
                                    network,
                                    address!,
                                    buildExtend({
                                        sender: address!,
                                        contract,
                                        id: lock.id,
                                        newUnlockAtNanos: newUnlockNanos,
                                    }),
                                ),
                            "Extend",
                        )
                    }
                />
            )}
            {action === "transfer" && (
                <TransferForm
                    self={address || ""}
                    contract={contract}
                    onCancel={closeAction}
                    onSubmit={(newOwner) =>
                        run(
                            () =>
                                broadcast(
                                    network,
                                    address!,
                                    buildTransferOwner({
                                        sender: address!,
                                        contract,
                                        id: lock.id,
                                        newOwner,
                                    }),
                                ),
                            "Transfer owner",
                        )
                    }
                />
            )}
        </div>
    );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
    return (
        <div className="bg-ink-700/40 rounded-md px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-ink-300">{label}</div>
            <div className={`font-mono ${accent ? "text-good" : "text-ink-100"}`}>{value}</div>
        </div>
    );
}

function milestoneLabel(lock: Lock, nowMs: number): string {
    if (isCliff(lock.schedule)) {
        const ms = nanosToDate(lock.schedule.cliff.unlock_at).getTime();
        return ms <= nowMs ? fmtDate(new Date(ms)) : fmtRelative(ms, nowMs);
    }
    if (isLinear(lock.schedule)) {
        const endMs = nanosToDate(lock.schedule.saturating_linear.end_at).getTime();
        return endMs <= nowMs ? fmtDate(new Date(endMs)) : `100% ${fmtRelative(endMs, nowMs)}`;
    }
    if (isPiecewise(lock.schedule)) {
        const steps = lock.schedule.piecewise_linear.steps;
        const lastMs = nanosToDate(steps[steps.length - 1][0]).getTime();
        return lastMs <= nowMs ? fmtDate(new Date(lastMs)) : `100% ${fmtRelative(lastMs, nowMs)}`;
    }
    return "—";
}

function shorten(s: string): string {
    if (s.length <= 14) return s;
    return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

// ---------------- Inline forms ----------------

function ActionShell(props: { title: string; children: React.ReactNode }) {
    return (
        <div className="border-t border-ink-700 pt-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-ink-200">{props.title}</div>
            {props.children}
        </div>
    );
}

function WithdrawForm({
    available,
    denomShort,
    onCancel,
    onSubmit,
}: {
    available: string;
    denomShort: string;
    onCancel: () => void;
    onSubmit: (amount?: string) => void;
}) {
    const [amount, setAmount] = useState<string>("");
    const [mode, setMode] = useState<"all" | "partial">("all");
    return (
        <ActionShell title="Withdraw">
            <div className="flex gap-2 text-xs">
                <button
                    className={`px-2 py-1 rounded ${mode === "all" ? "bg-primaryColor text-black" : "bg-ink-700 text-ink-200"}`}
                    onClick={() => setMode("all")}
                >
                    All claimable
                </button>
                <button
                    className={`px-2 py-1 rounded ${mode === "partial" ? "bg-primaryColor text-black" : "bg-ink-700 text-ink-200"}`}
                    onClick={() => setMode("partial")}
                >
                    Partial
                </button>
            </div>
            <div className="text-xs text-ink-300">
                Available now: <span className="font-mono text-ink-100">{fmtBaseUnits(available)}</span>{" "}
                {denomShort}
            </div>
            {mode === "partial" && (
                <input
                    type="text"
                    placeholder="base units"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="font-mono"
                />
            )}
            <div className="flex gap-2 justify-end">
                <button className="btn-ghost !text-xs" onClick={onCancel}>
                    Cancel
                </button>
                <button
                    className="btn-primary !text-xs"
                    onClick={() => onSubmit(mode === "all" ? undefined : amount)}
                >
                    Confirm
                </button>
            </div>
        </ActionShell>
    );
}

function TopUpForm({
    isCw20,
    denomStr,
    onCancel,
    onSubmit,
}: {
    isCw20: boolean;
    denomStr: string;
    onCancel: () => void;
    onSubmit: (amount: string) => void;
}) {
    const [amount, setAmount] = useState<string>("");
    return (
        <ActionShell title={`Top up (${isCw20 ? "cw20 Send hook" : "attaches native funds"})`}>
            <div className="text-xs text-ink-300 font-mono truncate">denom: {denomStr}</div>
            <input
                type="text"
                placeholder="amount (base units)"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="font-mono"
            />
            <div className="flex gap-2 justify-end">
                <button className="btn-ghost !text-xs" onClick={onCancel}>
                    Cancel
                </button>
                <button
                    className="btn-primary !text-xs"
                    disabled={!amount}
                    onClick={() => onSubmit(amount)}
                >
                    Top up
                </button>
            </div>
        </ActionShell>
    );
}

function ExtendForm({
    currentUnlockMs,
    onCancel,
    onSubmit,
}: {
    currentUnlockMs: number;
    onCancel: () => void;
    onSubmit: (newUnlockNanos: string) => void;
}) {
    const [next, setNext] = useState(
        toLocalInput(new Date(currentUnlockMs + 7 * 24 * 3600 * 1000)),
    );
    const d = fromLocalInput(next);
    const ok = d && d.getTime() > currentUnlockMs;
    return (
        <ActionShell title="Extend">
            <div className="text-xs text-ink-300">
                Current unlock: <span className="font-mono">{fmtDate(new Date(currentUnlockMs))}</span>{" "}
                — new must be strictly later.
            </div>
            <input type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} />
            <div className="flex gap-2 justify-end">
                <button className="btn-ghost !text-xs" onClick={onCancel}>
                    Cancel
                </button>
                <button
                    className="btn-primary !text-xs"
                    disabled={!ok}
                    onClick={() => d && onSubmit(dateToNanos(d))}
                >
                    Extend
                </button>
            </div>
        </ActionShell>
    );
}

function TransferForm({
    self,
    contract,
    onCancel,
    onSubmit,
}: {
    self: string;
    contract: string;
    onCancel: () => void;
    onSubmit: (newOwner: string) => void;
}) {
    const [target, setTarget] = useState("");
    const isSelf = target.trim() === self;
    const isContract = target.trim() === contract;
    const looksLikeInj = /^inj1[a-z0-9]{38,}$/.test(target.trim());
    const ok = looksLikeInj && !isSelf && !isContract;
    return (
        <ActionShell title="Transfer ownership">
            <input
                type="text"
                placeholder="inj1… new owner"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="font-mono"
            />
            {!looksLikeInj && target && (
                <div className="text-xs text-bad">Looks malformed — expecting inj1…</div>
            )}
            {isSelf && <div className="text-xs text-bad">Cannot transfer to yourself</div>}
            {isContract && <div className="text-xs text-bad">Cannot transfer to the locker contract</div>}
            <div className="flex gap-2 justify-end">
                <button className="btn-ghost !text-xs" onClick={onCancel}>
                    Cancel
                </button>
                <button
                    className="btn-primary !text-xs"
                    disabled={!ok}
                    onClick={() => ok && onSubmit(target.trim())}
                >
                    Transfer
                </button>
            </div>
        </ActionShell>
    );
}

