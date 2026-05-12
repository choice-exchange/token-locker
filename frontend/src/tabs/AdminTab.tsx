import { useState } from "react";
import { toast } from "react-toastify";
import { useConfig } from "../hooks/useLocker";
import { useLockerAddress, useWallet } from "../wallet/useWallet";
import { NETWORKS } from "../constants";
import { broadcast } from "../wallet/walletStrategy";
import { buildUpdateConfig } from "../chain/locker";
import { fmtBaseUnits, toBaseUnits } from "../utils/amount";

type FieldMode<T> = { mode: "leave" | "set" | "clear"; value: T };

export function AdminTab() {
    const network = useWallet((s) => s.network);
    const address = useWallet((s) => s.address);
    const contract = useLockerAddress();
    const explorerUrl = NETWORKS[network].explorerUrl;
    const cfg = useConfig();

    const isAdmin = !!(address && cfg.data?.admin && address === cfg.data.admin);

    const [adminMode, setAdminMode] = useState<"leave" | "set">("leave");
    const [adminVal, setAdminVal] = useState<string>("");

    const [feeCollector, setFeeCollector] = useState<FieldMode<string>>({ mode: "leave", value: "" });

    const [creationFee, setCreationFee] = useState<{
        mode: "leave" | "set" | "clear";
        denom: string;
        amount: string;
        decimals: number;
    }>({ mode: "leave", denom: "inj", amount: "", decimals: 18 });

    const [submitting, setSubmitting] = useState(false);

    async function submit() {
        if (!address) return;
        setSubmitting(true);
        try {
            const args: Parameters<typeof buildUpdateConfig>[0] = {
                sender: address,
                contract,
            };
            if (adminMode === "set") args.admin = adminVal.trim() || undefined;

            if (feeCollector.mode === "set") args.feeCollector = feeCollector.value.trim();
            else if (feeCollector.mode === "clear") args.feeCollector = null;

            if (creationFee.mode === "clear") args.creationFee = null;
            else if (creationFee.mode === "set") {
                const amountBase = toBaseUnits(creationFee.amount || "0", creationFee.decimals);
                if (amountBase === "0" || BigInt(amountBase) === 0n) {
                    toast.error("Creation fee amount must be > 0");
                    return;
                }
                args.creationFee = { denom: creationFee.denom.trim(), amount: amountBase };
            }

            const msg = buildUpdateConfig(args);
            const res = await broadcast(network, address, msg);
            toast.success(
                <div>
                    Config updated
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
            cfg.refresh();
        } catch (err) {
            toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="card space-y-3">
                <h2 className="text-sm font-semibold">Current config</h2>
                {cfg.loading && <div className="text-xs text-ink-300">Loading…</div>}
                {cfg.error ? (
                    <div className="text-xs text-bad">
                        Failed: {cfg.error instanceof Error ? cfg.error.message : String(cfg.error)}
                    </div>
                ) : null}
                {cfg.data && (
                    <dl className="text-xs space-y-2">
                        <Row label="Admin" value={cfg.data.admin || "(unset)"} mono />
                        <Row label="Fee collector" value={cfg.data.fee_collector || "(unset)"} mono />
                        <Row
                            label="Creation fee"
                            value={
                                cfg.data.creation_fee ? (
                                    <span className="font-mono">
                                        {fmtBaseUnits(cfg.data.creation_fee.amount)} {cfg.data.creation_fee.denom}
                                    </span>
                                ) : (
                                    "(none)"
                                )
                            }
                        />
                    </dl>
                )}
                {address && cfg.data && (
                    <div className="text-xs">
                        Connected wallet:{" "}
                        {isAdmin ? (
                            <span className="text-good">is admin ✓</span>
                        ) : (
                            <span className="text-warn">is NOT admin — UpdateConfig will revert</span>
                        )}
                    </div>
                )}
            </div>

            <div className="card space-y-4">
                <h2 className="text-sm font-semibold">Update config</h2>
                <p className="text-xs text-ink-300">
                    Each field has tri-state semantics: <em>leave</em> = don't change, <em>set</em> =
                    new value, <em>clear</em> = unset. The contract enforces{" "}
                    <code className="kbd">creation_fee &rArr; fee_collector</code> after applying.
                </p>

                <Field label="Admin (cannot clear)">
                    <Tri
                        modes={["leave", "set"] as const}
                        value={adminMode}
                        onChange={(v) => setAdminMode(v)}
                    />
                    {adminMode === "set" && (
                        <input
                            placeholder="inj1… new admin"
                            value={adminVal}
                            onChange={(e) => setAdminVal(e.target.value)}
                            className="font-mono"
                        />
                    )}
                </Field>

                <Field label="Fee collector">
                    <Tri
                        modes={["leave", "set", "clear"] as const}
                        value={feeCollector.mode}
                        onChange={(v) => setFeeCollector((f) => ({ ...f, mode: v }))}
                    />
                    {feeCollector.mode === "set" && (
                        <input
                            placeholder="inj1… fee collector"
                            value={feeCollector.value}
                            onChange={(e) =>
                                setFeeCollector((f) => ({ ...f, value: e.target.value }))
                            }
                            className="font-mono"
                        />
                    )}
                </Field>

                <Field label="Creation fee">
                    <Tri
                        modes={["leave", "set", "clear"] as const}
                        value={creationFee.mode}
                        onChange={(v) => setCreationFee((f) => ({ ...f, mode: v }))}
                    />
                    {creationFee.mode === "set" && (
                        <div className="grid grid-cols-2 gap-2">
                            <input
                                placeholder="denom (native only)"
                                value={creationFee.denom}
                                onChange={(e) =>
                                    setCreationFee((f) => ({ ...f, denom: e.target.value }))
                                }
                                className="font-mono"
                            />
                            <input
                                placeholder="amount (human)"
                                value={creationFee.amount}
                                onChange={(e) =>
                                    setCreationFee((f) => ({ ...f, amount: e.target.value }))
                                }
                                className="font-mono"
                            />
                            <select
                                value={creationFee.decimals}
                                onChange={(e) =>
                                    setCreationFee((f) => ({ ...f, decimals: Number(e.target.value) }))
                                }
                                className="col-span-2"
                            >
                                <option value={18}>18 decimals (INJ)</option>
                                <option value={6}>6 decimals (USDT/USDC)</option>
                                <option value={0}>0 decimals (raw base units)</option>
                            </select>
                        </div>
                    )}
                </Field>

                <button
                    className="btn-primary w-full"
                    disabled={!address || submitting}
                    onClick={submit}
                >
                    {submitting ? "Broadcasting…" : "Submit UpdateConfig"}
                </button>
                {!address && <div className="text-xs text-warn text-center">Connect a wallet</div>}
            </div>
        </div>
    );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
    return (
        <div className="row">
            <dt className="text-ink-300">{label}</dt>
            <dd className={mono ? "font-mono" : ""}>{value}</dd>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-2">
            <label>{label}</label>
            {children}
        </div>
    );
}

function Tri<M extends string>({
    modes,
    value,
    onChange,
}: {
    modes: readonly M[];
    value: M;
    onChange: (m: M) => void;
}) {
    return (
        <div className="flex gap-1">
            {modes.map((m) => (
                <button
                    key={m}
                    type="button"
                    onClick={() => onChange(m)}
                    className={`px-2 py-1 text-xs rounded ${
                        value === m
                            ? m === "clear"
                                ? "bg-bad/30 text-bad border border-bad/40"
                                : "bg-primaryColor text-black"
                            : "bg-ink-700 text-ink-200"
                    }`}
                >
                    {m}
                </button>
            ))}
        </div>
    );
}
