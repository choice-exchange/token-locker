import { useState } from "react";
import { useAllLocks, useClaimableMany, useLocksByDenom, useStats } from "../hooks/useLocker";
import { useWallet } from "../wallet/useWallet";
import { LockCard } from "../components/LockCard";

type FilterKind = "all" | "denom";

export function ExploreTab() {
    const stats = useStats();
    const address = useWallet((s) => s.address);

    const [filter, setFilter] = useState<FilterKind>("all");
    const [denomKind, setDenomKind] = useState<"native" | "cw20">("native");
    const [denomValue, setDenomValue] = useState<string>("");
    const denomKey = denomValue ? `${denomKind}:${denomValue.trim()}` : null;

    return (
        <div className="space-y-4">
            <div className="card row text-sm">
                <span className="text-ink-300">Total locks ever created</span>
                <span className="font-mono">
                    {stats.data ? stats.data.total_locks : stats.loading ? "…" : "—"}
                </span>
            </div>

            <div className="card space-y-3">
                <div className="flex gap-2">
                    <button
                        onClick={() => setFilter("all")}
                        className={`px-3 py-1.5 text-xs rounded ${filter === "all" ? "bg-primaryColor text-black" : "bg-ink-700 text-ink-200"}`}
                    >
                        All locks
                    </button>
                    <button
                        onClick={() => setFilter("denom")}
                        className={`px-3 py-1.5 text-xs rounded ${filter === "denom" ? "bg-primaryColor text-black" : "bg-ink-700 text-ink-200"}`}
                    >
                        By denom
                    </button>
                </div>
                {filter === "denom" && (
                    <div className="flex gap-2 items-end">
                        <select
                            value={denomKind}
                            onChange={(e) => setDenomKind(e.target.value as "native" | "cw20")}
                            className="!w-auto !text-xs"
                        >
                            <option value="native">native</option>
                            <option value="cw20">cw20</option>
                        </select>
                        <input
                            type="text"
                            placeholder={denomKind === "native" ? "inj  /  factory/inj1.../sub" : "inj1… cw20 addr"}
                            value={denomValue}
                            onChange={(e) => setDenomValue(e.target.value)}
                            className="!text-xs font-mono"
                        />
                        <span className="text-[10px] text-ink-300 font-mono mb-1">
                            key: {denomKey || "—"}
                        </span>
                    </div>
                )}
            </div>

            {filter === "all" ? <AllList address={address} /> : <DenomList denomKey={denomKey} address={address} />}
        </div>
    );
}

function AllList({ address }: { address: string | null }) {
    const [order] = useState<"asc" | "desc">("desc");
    const [page, setPage] = useState(1);
    const [cursor, setCursor] = useState<number | undefined>(undefined);
    const { data, loading, error, refresh } = useAllLocks({ startAfter: cursor, order });
    const claimable = useClaimableMany(data);

    function next() {
        if (!data || data.length === 0) return;
        const lastId = data[data.length - 1].id;
        setCursor(lastId);
        setPage((p) => p + 1);
    }
    function reset() {
        setCursor(undefined);
        setPage(1);
    }

    return (
        <List
            locks={data}
            loading={loading}
            error={error}
            address={address}
            claimable={claimable.data}
            onMutated={() => {
                refresh();
                claimable.refresh();
            }}
            page={page}
            onNext={next}
            onReset={reset}
        />
    );
}

function DenomList({ denomKey, address }: { denomKey: string | null; address: string | null }) {
    const [cursor, setCursor] = useState<number | undefined>(undefined);
    const [page, setPage] = useState(1);
    const { data, loading, error, refresh } = useLocksByDenom(denomKey, {
        startAfter: cursor,
        order: "desc",
    });
    const claimable = useClaimableMany(data);

    if (!denomKey) {
        return (
            <div className="card text-center text-sm text-ink-300 py-8">
                Enter a denom above to query.
            </div>
        );
    }
    function next() {
        if (!data || data.length === 0) return;
        setCursor(data[data.length - 1].id);
        setPage((p) => p + 1);
    }
    function reset() {
        setCursor(undefined);
        setPage(1);
    }
    return (
        <List
            locks={data}
            loading={loading}
            error={error}
            address={address}
            claimable={claimable.data}
            onMutated={() => {
                refresh();
                claimable.refresh();
            }}
            page={page}
            onNext={next}
            onReset={reset}
        />
    );
}

function List({
    locks,
    loading,
    error,
    address,
    claimable,
    onMutated,
    page,
    onNext,
    onReset,
}: {
    locks: import("../types/locker").Lock[] | undefined;
    loading: boolean;
    error: unknown;
    address: string | null;
    claimable: Map<number, import("../types/locker").ClaimableManyEntry> | undefined;
    onMutated: () => void;
    page: number;
    onNext: () => void;
    onReset: () => void;
}) {
    if (loading && !locks)
        return <div className="card text-sm text-ink-300 text-center py-8">Loading…</div>;
    if (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return (
            <div className="card border-bad/40 text-bad text-sm">
                Failed to load: <span className="font-mono">{msg}</span>
            </div>
        );
    }
    if (!locks || locks.length === 0)
        return (
            <div className="card text-sm text-ink-300 text-center py-8">
                No locks in this view.
                {page > 1 && (
                    <button className="btn-ghost ml-2 !text-xs" onClick={onReset}>
                        Back to first page
                    </button>
                )}
            </div>
        );
    return (
        <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {locks.map((l) => (
                    <LockCard
                        key={l.id}
                        lock={l}
                        claimableEntry={claimable?.get(l.id)}
                        isOwner={!!address && l.owner === address}
                        onMutated={onMutated}
                    />
                ))}
            </div>
            <div className="flex justify-center gap-2 pt-2">
                {page > 1 && (
                    <button className="btn-secondary !text-xs" onClick={onReset}>
                        First page
                    </button>
                )}
                <button
                    className="btn-secondary !text-xs"
                    onClick={onNext}
                    disabled={locks.length < 30}
                    title={locks.length < 30 ? "End of results" : "Next page"}
                >
                    Next →
                </button>
            </div>
        </>
    );
}
