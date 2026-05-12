// Hand-written TS bindings for the Choice Token Locker contract.
// Mirrors contracts/locker/src/msg.rs + schema/raw/*.json.
//
// Convention: timestamps are nanoseconds-as-string (cosmwasm Uint64).
// Amounts are base units as string (cosmwasm Uint128).

export type Uint128 = string;
export type TimestampNs = string;

export type CheckedDenom = { native: string } | { cw20: string };
export type UncheckedDenom = { native: string } | { cw20: string };

export type Schedule =
    | { cliff: { unlock_at: TimestampNs } }
    | { saturating_linear: { start_at: TimestampNs; end_at: TimestampNs } }
    | { piecewise_linear: { steps: [TimestampNs, Uint128][] } };

export interface Coin {
    denom: string;
    amount: string;
}

export interface Lock {
    id: number;
    owner: string;
    creator: string;
    denom: CheckedDenom;
    total: Uint128;
    withdrawn: Uint128;
    schedule: Schedule;
    title?: string | null;
    description?: string | null;
    created_at: TimestampNs;
}

export interface Config {
    admin?: string | null;
    fee_collector?: string | null;
    creation_fee?: Coin | null;
}

export interface StatsResponse {
    total_locks: number;
}

export interface LockResponse {
    lock: Lock;
}

export interface LocksResponse {
    locks: Lock[];
}

export interface ClaimableResponse {
    claimable: Uint128;
    withdrawn: Uint128;
    remaining: Uint128;
}

export interface ClaimableManyEntry {
    id: number;
    response: ClaimableResponse | null;
}

export interface ClaimableManyResponse {
    entries: ClaimableManyEntry[];
}

// --- ExecuteMsg variants ---

export type SortOrder = "asc" | "desc";

export type ExecuteMsg =
    | {
          lock: {
              denom: UncheckedDenom;
              amount: Uint128;
              schedule: Schedule;
              title?: string | null;
              description?: string | null;
          };
      }
    | { receive: { sender: string; amount: Uint128; msg: string } }
    | { extend: { id: number; new_unlock_at: TimestampNs } }
    | { top_up: { id: number; amount: Uint128 } }
    | { transfer_owner: { id: number; new_owner: string } }
    | { withdraw: { id: number; amount?: Uint128 | null } }
    | {
          update_config: {
              admin?: string | null;
              // double Option: undefined = leave, null = clear, value = set
              fee_collector?: string | null;
              creation_fee?: Coin | null;
          };
      };

// --- Cw20HookMsg (base64-encoded inside cw20 Send) ---

export type Cw20HookMsg =
    | {
          lock: {
              schedule: Schedule;
              title?: string | null;
              description?: string | null;
          };
      }
    | { top_up: { id: number } };

// --- QueryMsg variants ---

export type QueryMsg =
    | { config: Record<string, never> }
    | { stats: Record<string, never> }
    | { lock: { id: number } }
    | {
          locks_by_owner: {
              owner: string;
              start_after?: number | null;
              limit?: number | null;
              order?: SortOrder | null;
          };
      }
    | {
          locks_by_creator: {
              creator: string;
              start_after?: number | null;
              limit?: number | null;
              order?: SortOrder | null;
          };
      }
    | {
          locks_by_denom: {
              denom: string;
              start_after?: number | null;
              limit?: number | null;
              order?: SortOrder | null;
          };
      }
    | {
          all_locks: {
              start_after?: number | null;
              limit?: number | null;
              order?: SortOrder | null;
          };
      }
    | { claimable: { id: number; at?: TimestampNs | null } }
    | { claimable_many: { ids: number[]; at?: TimestampNs | null } };

// Helpers

export function denomKey(d: CheckedDenom): string {
    return "native" in d ? `native:${d.native}` : `cw20:${d.cw20}`;
}

export function denomLabel(d: CheckedDenom | UncheckedDenom): string {
    return "native" in d ? d.native : d.cw20;
}

export function isCliff(s: Schedule): s is { cliff: { unlock_at: TimestampNs } } {
    return "cliff" in s;
}
export function isLinear(
    s: Schedule,
): s is { saturating_linear: { start_at: TimestampNs; end_at: TimestampNs } } {
    return "saturating_linear" in s;
}
export function isPiecewise(
    s: Schedule,
): s is { piecewise_linear: { steps: [TimestampNs, Uint128][] } } {
    return "piecewise_linear" in s;
}
