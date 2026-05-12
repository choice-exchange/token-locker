import { useState } from "react";
import { toast } from "react-toastify";
import { Wallet } from "@injectivelabs/wallet-base";
import { useWallet } from "../wallet/useWallet";
import { selectAndConnect } from "../wallet/walletStrategy";
import type { SupportedWallet } from "../wallet/walletStrategy";

const WALLETS: { id: SupportedWallet; label: string }[] = [
    { id: Wallet.Keplr, label: "Keplr" },
    { id: Wallet.Leap, label: "Leap" },
];

export function WalletButton() {
    const network = useWallet((s) => s.network);
    const address = useWallet((s) => s.address);
    const wallet = useWallet((s) => s.wallet);
    const setAddress = useWallet((s) => s.setAddress);
    const setWalletState = useWallet((s) => s.setWallet);

    const [open, setOpen] = useState(false);
    const [connecting, setConnecting] = useState(false);

    async function connect(w: SupportedWallet) {
        setOpen(false);
        setConnecting(true);
        try {
            const addr = await selectAndConnect(network, w);
            setWalletState(w);
            setAddress(addr);
            toast.success(`Connected ${w}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toast.error(`Wallet error: ${msg}`);
        } finally {
            setConnecting(false);
        }
    }

    function disconnect() {
        setAddress(null);
        setWalletState(null);
    }

    if (address) {
        return (
            <div className="flex items-center gap-2">
                <span className="pill font-mono">
                    <span className="text-ink-300">{wallet}</span>·{shortAddr(address)}
                </span>
                <button className="btn-ghost" onClick={disconnect} title="Disconnect">
                    ✕
                </button>
            </div>
        );
    }

    return (
        <div className="relative">
            <button
                className="btn-primary"
                onClick={() => setOpen((o) => !o)}
                disabled={connecting}
            >
                {connecting ? "Connecting…" : "Connect wallet"}
            </button>
            {open && (
                <div className="absolute right-0 mt-2 w-44 card !p-2 z-30">
                    {WALLETS.map((w) => (
                        <button
                            key={w.id}
                            className="block w-full text-left px-3 py-2 text-sm rounded hover:bg-ink-700"
                            onClick={() => connect(w.id)}
                        >
                            {w.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

function shortAddr(a: string): string {
    if (a.length <= 14) return a;
    return `${a.slice(0, 8)}…${a.slice(-4)}`;
}
