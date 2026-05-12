import { useState } from "react";
import { NETWORKS } from "../constants";
import { useLockerAddress, useWallet } from "../wallet/useWallet";

export function ContractAddressBar() {
    const network = useWallet((s) => s.network);
    const override = useWallet((s) => s.lockerOverride);
    const setOverride = useWallet((s) => s.setLockerOverride);
    const active = useLockerAddress();

    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(override);

    const envAddr = NETWORKS[network].lockerAddress;
    const usingOverride = override.length > 0;

    return (
        <div className="border-t border-ink-700/60 bg-ink-800/40">
            <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-2 text-xs">
                <span className="text-ink-300">Contract</span>
                {editing ? (
                    <>
                        <input
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder="inj1… (leave empty to use env default)"
                            className="!py-1 !text-xs font-mono"
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    setOverride(draft);
                                    setEditing(false);
                                }
                                if (e.key === "Escape") {
                                    setDraft(override);
                                    setEditing(false);
                                }
                            }}
                        />
                        <button
                            className="btn-secondary !py-1 !px-2 !text-xs"
                            onClick={() => {
                                setOverride(draft);
                                setEditing(false);
                            }}
                        >
                            Save
                        </button>
                        <button
                            className="btn-ghost !py-1 !px-2 !text-xs"
                            onClick={() => {
                                setDraft(override);
                                setEditing(false);
                            }}
                        >
                            Cancel
                        </button>
                    </>
                ) : (
                    <>
                        <code className="font-mono text-ink-100 truncate">
                            {active || (
                                <span className="text-warn">
                                    not set — paste a deployed address or set VITE_LOCKER_ADDRESS_
                                    {network.toUpperCase()}
                                </span>
                            )}
                        </code>
                        {usingOverride && (
                            <span className="pill !text-[10px]" title={`env default: ${envAddr || "(unset)"}`}>
                                override
                            </span>
                        )}
                        <div className="grow" />
                        <button
                            className="btn-ghost !py-1 !px-2 !text-xs"
                            onClick={() => {
                                setDraft(override);
                                setEditing(true);
                            }}
                        >
                            {usingOverride ? "Edit" : "Override"}
                        </button>
                        {usingOverride && (
                            <button
                                className="btn-ghost !py-1 !px-2 !text-xs text-bad"
                                onClick={() => setOverride("")}
                            >
                                Clear
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
