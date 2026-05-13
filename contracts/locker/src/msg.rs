use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Coin, Uint128};
use crate::cw20::Cw20ReceiveMsg;
use crate::denom::UncheckedDenom;
use crate::schedule::Schedule;
use crate::state::Lock;

/// Instantiate the locker.
///
/// - `admin`: may update `Config`. Cannot touch any `Lock`. Defaults to msg.sender.
/// - `fee_collector`: receives `creation_fee` on native locks.
/// - `creation_fee`: optional flat fee (native denom only).
#[cw_serde]
pub struct InstantiateMsg {
    pub admin: Option<String>,
    pub fee_collector: Option<String>,
    pub creation_fee: Option<Coin>,
}

/// All callable entry points. See the workspace README for the full reference.
#[cw_serde]
pub enum ExecuteMsg {
    /// Create a lock funded by attached native funds. cw20 locks MUST use
    /// either `LockCw20` (with native fee, recommended path) or the legacy
    /// `Receive` hook (only valid when no `creation_fee` is configured) —
    /// passing `UncheckedDenom::Cw20(...)` here is rejected.
    Lock {
        denom: UncheckedDenom,
        amount: Uint128,
        schedule: Schedule,
        title: Option<String>,
        description: Option<String>,
    },

    /// Create a cw20 lock and charge the native creation fee atomically. The
    /// caller must first call `cw20::IncreaseAllowance { spender: locker,
    /// amount }` on the target cw20 contract, then call this with the
    /// `creation_fee` attached in `info.funds`. The locker pulls `amount` via
    /// `Cw20::TransferFrom` and forwards the fee to `fee_collector`.
    ///
    /// This path is the only way to create a cw20 lock when a fee is
    /// configured — the legacy `Receive` path cannot carry native funds, so it
    /// rejects with `Cw20LockRequiresFeePath` when a fee is set.
    LockCw20 {
        cw20_addr: String,
        amount: Uint128,
        schedule: Schedule,
        title: Option<String>,
        description: Option<String>,
    },

    /// cw20 entry point. Invoked by the cw20 contract via its `Send` hook.
    /// The wrapped `msg` field is a base64-encoded [`Cw20HookMsg`].
    ///
    /// `Cw20HookMsg::Lock` is rejected when `creation_fee` is configured (use
    /// `LockCw20` instead). `Cw20HookMsg::TopUp` is always accepted — top-ups
    /// don't pay the creation fee in either path.
    Receive(Cw20ReceiveMsg),

    /// Move a `Cliff` lock's `unlock_at` strictly forward. Owner-only.
    /// Rejected on `SaturatingLinear` / `PiecewiseLinear` schedules.
    Extend { id: u64, new_unlock_at: cosmwasm_std::Timestamp },

    /// Add more of the same denom to a `Cliff` lock. Native: attach matching
    /// funds. cw20: use `Cw20HookMsg::TopUp` instead. Anyone may top up
    /// (analogous to anyone funding a public escrow).
    TopUp { id: u64, amount: Uint128 },

    /// Hand ownership of a lock to another address. Owner-only.
    TransferOwner { id: u64, new_owner: String },

    /// Claim up to the currently claimable amount. `amount: None` claims everything.
    /// Owner-only. Returns `StillLocked` if nothing is claimable yet.
    Withdraw { id: u64, amount: Option<Uint128> },

    /// Admin-only. Updates Config fields. Never touches `Lock`s.
    ///
    /// `admin`: `Some(addr)` sets a new admin, `None` leaves unchanged. Cannot be cleared.
    /// `fee_collector`: `Some(Some(addr))` sets, `Some(None)` clears, `None` leaves unchanged.
    /// `creation_fee`: `Some(Some(fee))` sets, `Some(None)` clears, `None` leaves unchanged.
    ///
    /// Post-update, the contract enforces `creation_fee.is_some() => fee_collector.is_some()`
    /// and `creation_fee.amount > 0` to prevent stuck fees and bricked `Lock` calls.
    UpdateConfig {
        admin: Option<String>,
        fee_collector: Option<Option<String>>,
        creation_fee: Option<Option<Coin>>,
    },
}

/// Hook payload embedded in a cw20 `Send`'s `msg` field. The cw20 contract
/// unwraps this, computes the `amount`, and calls our `Receive` entry point.
#[cw_serde]
pub enum Cw20HookMsg {
    /// Create a new cw20 lock. The `Cw20ReceiveMsg.sender` becomes the owner,
    /// the cw20 contract address becomes the lock's denom.
    Lock {
        schedule: Schedule,
        title: Option<String>,
        description: Option<String>,
    },
    /// Top up an existing cw20 cliff lock. The lock's cw20 must match the
    /// sending cw20 contract.
    TopUp { id: u64 },
}

/// Sort order for paginated queries.
///
/// `start_after` is always exclusive on the inner lock-id. With `Desc`, the
/// frontend should track the **smallest** id seen on a page to fetch the next
/// page (vs the largest for `Asc`).
#[cw_serde]
#[derive(Default)]
pub enum SortOrder {
    #[default]
    Asc,
    Desc,
}

impl SortOrder {
    pub fn to_order(&self) -> cosmwasm_std::Order {
        match self {
            SortOrder::Asc => cosmwasm_std::Order::Ascending,
            SortOrder::Desc => cosmwasm_std::Order::Descending,
        }
    }
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(crate::state::Config)]
    Config {},

    /// Aggregate counters. `total_locks` is the monotonic nonce — useful for
    /// "X locks created" UI and as a paging upper bound.
    #[returns(StatsResponse)]
    Stats {},

    #[returns(LockResponse)]
    Lock { id: u64 },

    #[returns(LocksResponse)]
    LocksByOwner {
        owner: String,
        start_after: Option<u64>,
        limit: Option<u32>,
        order: Option<SortOrder>,
    },

    /// "Locks I created" — survives `TransferOwner` so an OTC seller can still
    /// audit their issued locks after handing ownership to the buyer.
    #[returns(LocksResponse)]
    LocksByCreator {
        creator: String,
        start_after: Option<u64>,
        limit: Option<u32>,
        order: Option<SortOrder>,
    },

    #[returns(LocksResponse)]
    LocksByDenom {
        denom: String, // CheckedDenom::key() format: "native:<d>" or "cw20:<addr>"
        start_after: Option<u64>,
        limit: Option<u32>,
        order: Option<SortOrder>,
    },

    #[returns(LocksResponse)]
    AllLocks {
        start_after: Option<u64>,
        limit: Option<u32>,
        order: Option<SortOrder>,
    },

    /// Current claimable amount for a lock at the given time (defaults to block time).
    #[returns(ClaimableResponse)]
    Claimable {
        id: u64,
        at: Option<cosmwasm_std::Timestamp>,
    },

    /// Batched claimable lookup, capped at 100 ids per call. Unknown ids return
    /// `entry.response = None` rather than failing the whole query.
    #[returns(ClaimableManyResponse)]
    ClaimableMany {
        ids: Vec<u64>,
        at: Option<cosmwasm_std::Timestamp>,
    },
}

#[cw_serde]
pub struct LockResponse {
    pub lock: Lock,
}

#[cw_serde]
pub struct LocksResponse {
    pub locks: Vec<Lock>,
}

#[cw_serde]
pub struct ClaimableResponse {
    pub claimable: Uint128,
    pub withdrawn: Uint128,
    pub remaining: Uint128,
}

#[cw_serde]
pub struct ClaimableManyEntry {
    pub id: u64,
    /// `None` if the lock id does not exist.
    pub response: Option<ClaimableResponse>,
}

#[cw_serde]
pub struct ClaimableManyResponse {
    pub entries: Vec<ClaimableManyEntry>,
}

#[cw_serde]
pub struct StatsResponse {
    /// Monotonic counter of locks ever created. Lock ids run 1..=total_locks.
    pub total_locks: u64,
}

#[cw_serde]
pub struct MigrateMsg {}
