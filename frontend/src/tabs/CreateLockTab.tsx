import { useMemo, useState } from "react";
import { toast } from "react-toastify";
import { useConfig } from "../hooks/useLocker";
import { useLockerAddress, useWallet } from "../wallet/useWallet";
import { NETWORKS } from "../constants";
import { broadcast } from "../wallet/walletStrategy";
import { buildLockCw20, buildLockNative } from "../chain/locker";
import { AmountInput } from "../components/AmountInput";
import { ScheduleBuilder } from "../components/ScheduleBuilder";
import type { ScheduleKind } from "../components/ScheduleBuilder";
import { fmtBaseUnits, toBaseUnits } from "../utils/amount";
import type { Schedule } from "../types/locker";

type DenomKind = "native" | "cw20";

const COMMON_DECIMALS: { label: string; decimals: number }[] = [
    { label: "18 (INJ / EVM peggy)", decimals: 18 },
    { label: "6 (USDT / USDC peggy)", decimals: 6 },
    { label: "0 (raw base units)", decimals: 0 },
];

export function CreateLockTab() {
    const network = useWallet((s) => s.network);
    const address = useWallet((s) => s.address);
    const contract = useLockerAddress();
    const explorerUrl = NETWORKS[network].explorerUrl;
    const cfg = useConfig();
    const creationFee = cfg.data?.creation_fee || null;

    const [denomKind, setDenomKind] = useState<DenomKind>("native");
    const [denom, setDenom] = useState<string>("inj");
    const [decimals, setDecimals] = useState<number>(18);
    const [amountHuman, setAmountHuman] = useState<string>("");
    const [title, setTitle] = useState<string>("");
    const [description, setDescription] = useState<string>("");
    const [kind, setKind] = useState<ScheduleKind>("cliff");
    const [scheduleOut, setScheduleOut] = useState<{ schedule: Schedule | null; error?: string }>({
        schedule: null,
    });
    const [submitting, setSubmitting] = useState(false);

    const amountBase = useMemo(
        () => (amountHuman ? toBaseUnits(amountHuman, decimals) : "0"),
        [amountHuman, decimals],
    );
    const amountOk = amountBase !== "0" && BigInt(amountBase) > 0n;
    const denomOk = denom.trim().length > 0;
    const ready = ready_(address, contract, amountOk, denomOk, scheduleOut.schedule);

    async function submit() {
        if (!ready || !scheduleOut.schedule) return;
        setSubmitting(true);
        try {
            const msg =
                denomKind === "native"
                    ? buildLockNative({
                          sender: address!,
                          contract,
                          denom: denom.trim(),
                          amount: amountBase,
                          schedule: scheduleOut.schedule,
                          title: title || undefined,
                          description: description || undefined,
                          creationFee: creationFee || undefined,
                      })
                    : buildLockCw20({
                          sender: address!,
                          contract,
                          cw20: denom.trim(),
                          amount: amountBase,
                          schedule: scheduleOut.schedule,
                          title: title || undefined,
                          description: description || undefined,
                      });
            const res = await broadcast(network, address!, msg);
            toast.success(
                <div>
                    Lock created
                    {res.txHash && (
                        <>
                            <br />
                            <a
                                className="text-accent-400 underline text-xs"
                                href={`${explorerUrl}/transaction/${res.txHash}`}
                                target="_blank"
                                rel="noreferrer"
                            >
                                View transaction
                            </a>
                        </>
                    )}
                </div>,
            );
            setAmountHuman("");
            setTitle("");
            setDescription("");
        } catch (e) {
            toast.error(`Lock failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-4">
                <div className="card space-y-4">
                    <h2 className="text-sm font-semibold">Token & amount</h2>

                    <div className="flex gap-2">
                        {(["native", "cw20"] as const).map((k) => (
                            <button
                                key={k}
                                onClick={() => {
                                    setDenomKind(k);
                                    setDenom(k === "native" ? "inj" : "");
                                    setDecimals(k === "native" ? 18 : 6);
                                }}
                                className={`px-3 py-1.5 rounded text-xs ${denomKind === k ? "bg-primaryColor text-black" : "bg-ink-700 text-ink-200"}`}
                            >
                                {k === "native" ? "Native / TF" : "cw20"}
                            </button>
                        ))}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label>{denomKind === "native" ? "Denom" : "cw20 address"}</label>
                            <input
                                type="text"
                                placeholder={
                                    denomKind === "native"
                                        ? "inj  or  factory/inj1…/subdenom"
                                        : "inj1… cw20 contract"
                                }
                                value={denom}
                                onChange={(e) => setDenom(e.target.value)}
                                className="font-mono"
                            />
                        </div>
                        <div>
                            <label>Decimals (display only)</label>
                            <select
                                value={decimals}
                                onChange={(e) => setDecimals(Number(e.target.value))}
                            >
                                {COMMON_DECIMALS.map((d) => (
                                    <option key={d.decimals} value={d.decimals}>
                                        {d.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <AmountInput
                        label="Amount"
                        value={amountHuman}
                        onChange={setAmountHuman}
                        helper={
                            amountOk ? (
                                <>
                                    = <span className="font-mono">{fmtBaseUnits(amountBase)}</span> base units
                                </>
                            ) : (
                                "Enter the deposit amount in human units"
                            )
                        }
                    />

                    <div className="grid grid-cols-1 gap-3">
                        <div>
                            <label>Title (optional)</label>
                            <input
                                type="text"
                                placeholder="LP lock — INJ/USDT"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                maxLength={120}
                            />
                        </div>
                        <div>
                            <label>Description (optional)</label>
                            <textarea
                                placeholder="What is this lock for?"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={2}
                                maxLength={400}
                            />
                        </div>
                    </div>
                </div>

                <div className="card space-y-3">
                    <h2 className="text-sm font-semibold">Unlock schedule</h2>
                    <ScheduleBuilder
                        kind={kind}
                        onKindChange={setKind}
                        totalBase={amountBase}
                        decimals={decimals}
                        onChange={setScheduleOut}
                    />
                </div>
            </div>

            <div className="space-y-4">
                <div className="card space-y-3">
                    <h2 className="text-sm font-semibold">Review & submit</h2>
                    <ReviewRow label="Network" value={NETWORKS[network].label} />
                    <ReviewRow
                        label="Locker"
                        value={contract ? short(contract) : <span className="text-warn">unset</span>}
                    />
                    <ReviewRow label="Denom" value={short(denom)} mono />
                    <ReviewRow
                        label="Amount"
                        value={
                            <>
                                <span className="font-mono">{amountHuman || "0"}</span>{" "}
                                <span className="text-ink-300">({fmtBaseUnits(amountBase)})</span>
                            </>
                        }
                    />
                    {creationFee && (
                        <ReviewRow
                            label="Creation fee"
                            value={
                                <span className="font-mono">
                                    {fmtBaseUnits(creationFee.amount)} {creationFee.denom}
                                </span>
                            }
                        />
                    )}
                    {scheduleOut.error && (
                        <div className="text-xs text-bad">{scheduleOut.error}</div>
                    )}
                    {denomKind === "cw20" && (
                        <div className="text-xs text-ink-300">
                            cw20 deposits go via the token's Send hook (Cw20HookMsg::Lock). No creation
                            fee is charged on cw20 locks.
                        </div>
                    )}
                    <button
                        className="btn-primary w-full"
                        disabled={!ready || submitting}
                        onClick={submit}
                    >
                        {submitting ? "Broadcasting…" : "Create lock"}
                    </button>
                    {!address && <div className="text-xs text-warn text-center">Connect a wallet</div>}
                    {!contract && <div className="text-xs text-warn text-center">Set a contract address</div>}
                </div>
            </div>
        </div>
    );
}

function ReviewRow({
    label,
    value,
    mono,
}: {
    label: string;
    value: React.ReactNode;
    mono?: boolean;
}) {
    return (
        <div className="row text-xs">
            <span className="text-ink-300">{label}</span>
            <span className={mono ? "font-mono" : ""}>{value}</span>
        </div>
    );
}

function short(s: string): string {
    if (!s) return "—";
    if (s.length <= 18) return s;
    return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

function ready_(
    address: string | null,
    contract: string,
    amountOk: boolean,
    denomOk: boolean,
    schedule: Schedule | null,
): boolean {
    return Boolean(address && contract && amountOk && denomOk && schedule);
}
