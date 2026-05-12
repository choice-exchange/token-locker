import { useMemo } from "react";
import { locker } from "../chain/locker";
import { useLockerAddress, useWallet } from "../wallet/useWallet";
import { useAsync } from "./useAsync";
import type { ClaimableManyEntry, Lock, SortOrder } from "../types/locker";

function useContext() {
    const network = useWallet((s) => s.network);
    const contract = useLockerAddress();
    return { network, contract };
}

export function useConfig() {
    const { network, contract } = useContext();
    return useAsync(
        async () => (contract ? locker.config(network, contract) : undefined),
        [network, contract],
    );
}

export function useStats() {
    const { network, contract } = useContext();
    return useAsync(
        async () => (contract ? locker.stats(network, contract) : undefined),
        [network, contract],
    );
}

export function useLocksByOwner(
    owner: string | null,
    opts: { startAfter?: number; limit?: number; order?: SortOrder } = {},
) {
    const { network, contract } = useContext();
    return useAsync(async () => {
        if (!contract || !owner) return undefined;
        const res = await locker.locksByOwner(network, contract, {
            owner,
            start_after: opts.startAfter,
            limit: opts.limit ?? 30,
            order: opts.order ?? "desc",
        });
        return res.locks;
    }, [network, contract, owner, opts.startAfter, opts.limit, opts.order]);
}

export function useLocksByCreator(
    creator: string | null,
    opts: { startAfter?: number; limit?: number; order?: SortOrder } = {},
) {
    const { network, contract } = useContext();
    return useAsync(async () => {
        if (!contract || !creator) return undefined;
        const res = await locker.locksByCreator(network, contract, {
            creator,
            start_after: opts.startAfter,
            limit: opts.limit ?? 30,
            order: opts.order ?? "desc",
        });
        return res.locks;
    }, [network, contract, creator, opts.startAfter, opts.limit, opts.order]);
}

export function useLocksByDenom(
    denomKey: string | null,
    opts: { startAfter?: number; limit?: number; order?: SortOrder } = {},
) {
    const { network, contract } = useContext();
    return useAsync(async () => {
        if (!contract || !denomKey) return undefined;
        const res = await locker.locksByDenom(network, contract, {
            denom: denomKey,
            start_after: opts.startAfter,
            limit: opts.limit ?? 30,
            order: opts.order ?? "desc",
        });
        return res.locks;
    }, [network, contract, denomKey, opts.startAfter, opts.limit, opts.order]);
}

export function useAllLocks(opts: { startAfter?: number; limit?: number; order?: SortOrder } = {}) {
    const { network, contract } = useContext();
    return useAsync(async () => {
        if (!contract) return undefined;
        const res = await locker.allLocks(network, contract, {
            start_after: opts.startAfter,
            limit: opts.limit ?? 30,
            order: opts.order ?? "desc",
        });
        return res.locks;
    }, [network, contract, opts.startAfter, opts.limit, opts.order]);
}

export function useClaimableMany(locks: Lock[] | undefined) {
    const { network, contract } = useContext();
    const ids = useMemo(() => (locks ? locks.map((l) => l.id) : []), [locks]);
    const idsKey = ids.join(",");
    return useAsync(async () => {
        if (!contract || ids.length === 0) return new Map<number, ClaimableManyEntry>();
        const res = await locker.claimableMany(network, contract, ids);
        return new Map(res.entries.map((e) => [e.id, e]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [network, contract, idsKey]);
}
