// Type-safe wrappers around the Choice Token Locker contract.
// All execute messages build a MsgExecuteContractCompat ready to broadcast.

import { MsgExecuteContractCompat } from "@injectivelabs/sdk-ts";
import type {
    ClaimableManyResponse,
    ClaimableResponse,
    Config,
    Cw20HookMsg,
    ExecuteMsg,
    LockResponse,
    LocksResponse,
    QueryMsg,
    Schedule,
    SortOrder,
    StatsResponse,
    UncheckedDenom,
} from "../types/locker";
import { smartQuery } from "./clients";
import type { NetworkKey } from "../constants";

// ---------------- Queries ----------------

export const locker = {
    config: (network: NetworkKey, contract: string) =>
        smartQuery<Config>(network, contract, { config: {} } as QueryMsg),

    stats: (network: NetworkKey, contract: string) =>
        smartQuery<StatsResponse>(network, contract, { stats: {} } as QueryMsg),

    lock: (network: NetworkKey, contract: string, id: number) =>
        smartQuery<LockResponse>(network, contract, { lock: { id } } as QueryMsg),

    locksByOwner: (
        network: NetworkKey,
        contract: string,
        params: { owner: string; start_after?: number; limit?: number; order?: SortOrder },
    ) =>
        smartQuery<LocksResponse>(network, contract, {
            locks_by_owner: params,
        } as QueryMsg),

    locksByCreator: (
        network: NetworkKey,
        contract: string,
        params: { creator: string; start_after?: number; limit?: number; order?: SortOrder },
    ) =>
        smartQuery<LocksResponse>(network, contract, {
            locks_by_creator: params,
        } as QueryMsg),

    locksByDenom: (
        network: NetworkKey,
        contract: string,
        params: { denom: string; start_after?: number; limit?: number; order?: SortOrder },
    ) =>
        smartQuery<LocksResponse>(network, contract, {
            locks_by_denom: params,
        } as QueryMsg),

    allLocks: (
        network: NetworkKey,
        contract: string,
        params: { start_after?: number; limit?: number; order?: SortOrder } = {},
    ) =>
        smartQuery<LocksResponse>(network, contract, {
            all_locks: params,
        } as QueryMsg),

    claimable: (network: NetworkKey, contract: string, id: number) =>
        smartQuery<ClaimableResponse>(network, contract, { claimable: { id } } as QueryMsg),

    claimableMany: (network: NetworkKey, contract: string, ids: number[]) =>
        smartQuery<ClaimableManyResponse>(network, contract, {
            claimable_many: { ids },
        } as QueryMsg),
};

// ---------------- Execute message builders ----------------

interface BuildArgs {
    sender: string;
    contract: string;
}

export function buildLockNative(
    args: BuildArgs & {
        denom: string;
        amount: string;
        schedule: Schedule;
        title?: string;
        description?: string;
        creationFee?: { denom: string; amount: string };
    },
) {
    const lockMsg: ExecuteMsg = {
        lock: {
            denom: { native: args.denom } as UncheckedDenom,
            amount: args.amount,
            schedule: args.schedule,
            title: args.title || null,
            description: args.description || null,
        },
    };

    // Funds: lock amount + creation fee if any (combined if same denom)
    const funds: { denom: string; amount: string }[] = [{ denom: args.denom, amount: args.amount }];
    if (args.creationFee) {
        if (args.creationFee.denom === args.denom) {
            funds[0].amount = (BigInt(funds[0].amount) + BigInt(args.creationFee.amount)).toString();
        } else {
            funds.push({ denom: args.creationFee.denom, amount: args.creationFee.amount });
        }
    }

    return MsgExecuteContractCompat.fromJSON({
        sender: args.sender,
        contractAddress: args.contract,
        msg: lockMsg,
        funds,
    });
}

/// Cw20 `IncreaseAllowance` builder — the caller grants the locker spender
/// rights for `amount` so a subsequent `LockCw20` can pull via TransferFrom.
/// Returns a single `MsgExecuteContractCompat` targeting the cw20 contract.
export function buildIncreaseAllowance(
    args: BuildArgs & { cw20: string; amount: string },
) {
    return MsgExecuteContractCompat.fromJSON({
        sender: args.sender,
        contractAddress: args.cw20,
        msg: {
            increase_allowance: {
                spender: args.contract,
                amount: args.amount,
            },
        },
        funds: [],
    });
}

/// Cw20 lock via the M-4 fee-enforced path. Builds the locker's `LockCw20`
/// execute, with the native `creation_fee` (if any) attached. This MUST be
/// batched with a preceding `buildIncreaseAllowance` so the locker's
/// internal `TransferFrom` can pull `amount` from the caller atomically.
export function buildLockCw20(
    args: BuildArgs & {
        cw20: string;
        amount: string;
        schedule: Schedule;
        title?: string;
        description?: string;
        creationFee?: { denom: string; amount: string };
    },
) {
    const lockMsg: ExecuteMsg = {
        lock_cw20: {
            cw20_addr: args.cw20,
            amount: args.amount,
            schedule: args.schedule,
            title: args.title || null,
            description: args.description || null,
        },
    };

    // Funds: only the native creation fee (cw20 deposit travels via TransferFrom).
    const funds = args.creationFee
        ? [{ denom: args.creationFee.denom, amount: args.creationFee.amount }]
        : [];

    return MsgExecuteContractCompat.fromJSON({
        sender: args.sender,
        contractAddress: args.contract,
        msg: lockMsg,
        funds,
    });
}

/// Legacy cw20 lock via Send→Receive. ONLY valid when no `creation_fee` is
/// configured on the locker (otherwise the contract rejects with
/// `Cw20LockRequiresFeePath`). Kept for the no-fee deployment shape.
export function buildLockCw20Receive(
    args: BuildArgs & {
        cw20: string;
        amount: string;
        schedule: Schedule;
        title?: string;
        description?: string;
    },
) {
    const hook: Cw20HookMsg = {
        lock: {
            schedule: args.schedule,
            title: args.title || null,
            description: args.description || null,
        },
    };
    return MsgExecuteContractCompat.fromJSON({
        sender: args.sender,
        contractAddress: args.cw20,
        msg: {
            send: {
                contract: args.contract,
                amount: args.amount,
                msg: btoa(JSON.stringify(hook)),
            },
        },
        funds: [],
    });
}

export function buildTopUpNative(
    args: BuildArgs & { id: number; denom: string; amount: string },
) {
    const msg: ExecuteMsg = { top_up: { id: args.id, amount: args.amount } };
    return MsgExecuteContractCompat.fromJSON({
        sender: args.sender,
        contractAddress: args.contract,
        msg,
        funds: [{ denom: args.denom, amount: args.amount }],
    });
}

export function buildTopUpCw20(
    args: BuildArgs & { id: number; cw20: string; amount: string },
) {
    const hook: Cw20HookMsg = { top_up: { id: args.id } };
    return MsgExecuteContractCompat.fromJSON({
        sender: args.sender,
        contractAddress: args.cw20,
        msg: {
            send: {
                contract: args.contract,
                amount: args.amount,
                msg: btoa(JSON.stringify(hook)),
            },
        },
        funds: [],
    });
}

export function buildExtend(args: BuildArgs & { id: number; newUnlockAtNanos: string }) {
    const msg: ExecuteMsg = { extend: { id: args.id, new_unlock_at: args.newUnlockAtNanos } };
    return MsgExecuteContractCompat.fromJSON({
        sender: args.sender,
        contractAddress: args.contract,
        msg,
        funds: [],
    });
}

export function buildTransferOwner(
    args: BuildArgs & { id: number; newOwner: string },
) {
    const msg: ExecuteMsg = {
        transfer_owner: { id: args.id, new_owner: args.newOwner },
    };
    return MsgExecuteContractCompat.fromJSON({
        sender: args.sender,
        contractAddress: args.contract,
        msg,
        funds: [],
    });
}

export function buildWithdraw(
    args: BuildArgs & { id: number; amount?: string },
) {
    const msg: ExecuteMsg = {
        withdraw: { id: args.id, amount: args.amount ?? null },
    };
    return MsgExecuteContractCompat.fromJSON({
        sender: args.sender,
        contractAddress: args.contract,
        msg,
        funds: [],
    });
}

export function buildUpdateConfig(
    args: BuildArgs & {
        admin?: string;
        feeCollector?: string | null; // undefined = leave, null = clear, string = set
        creationFee?: { denom: string; amount: string } | null;
    },
) {
    const inner: Record<string, unknown> = {};
    if (args.admin !== undefined) inner.admin = args.admin;
    if (args.feeCollector !== undefined) inner.fee_collector = args.feeCollector;
    if (args.creationFee !== undefined) inner.creation_fee = args.creationFee;

    return MsgExecuteContractCompat.fromJSON({
        sender: args.sender,
        contractAddress: args.contract,
        msg: { update_config: inner },
        funds: [],
    });
}
