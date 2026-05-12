import { NETWORKS } from "../constants";
import type { NetworkKey } from "../constants";
import { useWallet } from "../wallet/useWallet";
import { WalletButton } from "./WalletButton";
import { ContractAddressBar } from "./ContractAddressBar";

interface Props {
    activeTab: TabKey;
    onTab: (t: TabKey) => void;
}

export type TabKey = "create" | "mine" | "explore" | "admin";

const TABS: { key: TabKey; label: string }[] = [
    { key: "create", label: "Create lock" },
    { key: "mine", label: "My locks" },
    { key: "explore", label: "Explore" },
    { key: "admin", label: "Admin" },
];

export function Header({ activeTab, onTab }: Props) {
    const network = useWallet((s) => s.network);
    const setNetwork = useWallet((s) => s.setNetwork);

    return (
        <header className="border-b border-ink-500/60 bg-darkBgColor/80 backdrop-blur sticky top-0 z-20">
            <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
                <h1 className="text-base font-semibold tracking-tight">
                    <span className="brand-gradient-text">Choice</span>{" "}
                    <span className="text-white">· Token Locker</span>
                </h1>
                <span className="kbd hidden sm:inline">choice/token-locker</span>
                <div className="grow" />
                <select
                    aria-label="Network"
                    value={network}
                    onChange={(e) => setNetwork(e.target.value as NetworkKey)}
                    className="!w-auto !py-1.5 !px-2 text-sm"
                >
                    {Object.values(NETWORKS).map((n) => (
                        <option key={n.key} value={n.key}>
                            {n.label}
                        </option>
                    ))}
                </select>
                <WalletButton />
            </div>
            <div className="max-w-5xl mx-auto px-4 -mb-px flex gap-1">
                {TABS.map((t) => (
                    <button
                        key={t.key}
                        className={`tab ${activeTab === t.key ? "tab-active" : ""}`}
                        onClick={() => onTab(t.key)}
                    >
                        {t.label}
                    </button>
                ))}
            </div>
            <ContractAddressBar />
        </header>
    );
}
