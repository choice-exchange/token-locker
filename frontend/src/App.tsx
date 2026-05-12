import { useState } from "react";
import { Header } from "./components/Header";
import type { TabKey } from "./components/Header";
import { CreateLockTab } from "./tabs/CreateLockTab";
import { MyLocksTab } from "./tabs/MyLocksTab";
import { ExploreTab } from "./tabs/ExploreTab";
import { AdminTab } from "./tabs/AdminTab";
import { useLockerAddress } from "./wallet/useWallet";

export default function App() {
    const [tab, setTab] = useState<TabKey>("create");
    const contract = useLockerAddress();

    return (
        <div className="min-h-screen flex flex-col">
            <Header activeTab={tab} onTab={setTab} />
            <main className="max-w-5xl w-full mx-auto px-4 py-6 grow">
                {!contract ? (
                    <div className="card text-center text-sm text-ink-300 py-10 space-y-2">
                        <div>No locker contract address set.</div>
                        <div className="text-xs">
                            Set <code className="kbd">VITE_LOCKER_ADDRESS_TESTNET</code> in <code className="kbd">.env</code>,
                            or paste an address in the bar above.
                        </div>
                    </div>
                ) : tab === "create" ? (
                    <CreateLockTab />
                ) : tab === "mine" ? (
                    <MyLocksTab />
                ) : tab === "explore" ? (
                    <ExploreTab />
                ) : (
                    <AdminTab />
                )}
            </main>
            <footer className="border-t border-ink-700 py-4 text-center text-[10px] text-ink-300">
                Standalone learning UI · derived from{" "}
                <code className="kbd">contracts/locker/src/msg.rs</code>
            </footer>
        </div>
    );
}
