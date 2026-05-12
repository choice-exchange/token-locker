import { useState } from "react";
import { useClaimableMany, useLocksByCreator, useLocksByOwner } from "../hooks/useLocker";
import { useWallet } from "../wallet/useWallet";
import { LockCard } from "../components/LockCard";

type Tab = "owner" | "creator";

export function MyLocksTab() {
    const address = useWallet((s) => s.address);
    const [tab, setTab] = useState<Tab>("owner");

    if (!address) {
        return <EmptyState text="Connect a wallet to see your locks." />;
    }

    return (
        <div className="space-y-4">
            <div className="flex gap-2">
                <SubTab active={tab === "owner"} onClick={() => setTab("owner")}>
                    Owned by me
                </SubTab>
                <SubTab active={tab === "creator"} onClick={() => setTab("creator")}>
                    Created by me
                </SubTab>
                <span className="text-xs text-ink-300 self-center ml-2">
                    {tab === "owner"
                        ? "Locks where you can withdraw / extend / transfer."
                        : "Locks you originally deposited (survives transfer-owner)."}
                </span>
            </div>
            {tab === "owner" ? <OwnerView address={address} /> : <CreatorView address={address} />}
        </div>
    );
}

function OwnerView({ address }: { address: string }) {
    const { data, loading, error, refresh } = useLocksByOwner(address);
    const claimable = useClaimableMany(data);
    return (
        <LockGrid
            locks={data}
            loading={loading}
            error={error}
            isOwnerOf={() => true}
            emptyHint="You don't own any locks yet. Create one in the Create lock tab."
            claimable={claimable.data}
            onMutated={() => {
                refresh();
                claimable.refresh();
            }}
        />
    );
}

function CreatorView({ address }: { address: string }) {
    const { data, loading, error, refresh } = useLocksByCreator(address);
    const claimable = useClaimableMany(data);
    return (
        <LockGrid
            locks={data}
            loading={loading}
            error={error}
            isOwnerOf={(l) => l.owner === address}
            emptyHint="You haven't created any locks yet."
            claimable={claimable.data}
            onMutated={() => {
                refresh();
                claimable.refresh();
            }}
        />
    );
}

function LockGrid({
    locks,
    loading,
    error,
    isOwnerOf,
    emptyHint,
    claimable,
    onMutated,
}: {
    locks: import("../types/locker").Lock[] | undefined;
    loading: boolean;
    error: unknown;
    isOwnerOf: (l: import("../types/locker").Lock) => boolean;
    emptyHint: string;
    claimable: Map<number, import("../types/locker").ClaimableManyEntry> | undefined;
    onMutated: () => void;
}) {
    if (loading && !locks) return <Spinner />;
    if (error) return <ErrorBlock error={error} />;
    if (!locks || locks.length === 0) return <EmptyState text={emptyHint} />;
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {locks.map((l) => (
                <LockCard
                    key={l.id}
                    lock={l}
                    claimableEntry={claimable?.get(l.id)}
                    isOwner={isOwnerOf(l)}
                    onMutated={onMutated}
                />
            ))}
        </div>
    );
}

function SubTab({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className={`px-3 py-1.5 text-xs rounded ${active ? "bg-primaryColor text-black" : "bg-ink-700 text-ink-200 hover:bg-ink-600"}`}
        >
            {children}
        </button>
    );
}

function EmptyState({ text }: { text: string }) {
    return (
        <div className="card text-center text-sm text-ink-300 py-12">{text}</div>
    );
}

function Spinner() {
    return (
        <div className="card text-center text-sm text-ink-300 py-8">Loading…</div>
    );
}

function ErrorBlock({ error }: { error: unknown }) {
    const msg = error instanceof Error ? error.message : String(error);
    return (
        <div className="card border-bad/40 text-bad text-sm">
            Failed to load locks: <span className="font-mono">{msg}</span>
        </div>
    );
}
