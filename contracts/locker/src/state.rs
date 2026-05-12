use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Coin, Timestamp, Uint128};
use cw_storage_plus::{Item, Map};

use crate::denom::CheckedDenom;
use crate::schedule::Schedule;

/// Global contract configuration. Only `admin` can mutate this; nothing here
/// affects any existing `Lock`.
#[cw_serde]
pub struct Config {
    /// Address allowed to call `UpdateConfig`. No power over individual locks.
    pub admin: Option<Addr>,
    /// Recipient of `creation_fee` payments. If unset, fees accrue to the contract.
    pub fee_collector: Option<Addr>,
    /// Flat per-lock fee (native denom only). If `None`, no fee is charged.
    /// Only applies to `ExecuteMsg::Lock`, not the cw20 `Receive` path.
    pub creation_fee: Option<Coin>,
}

/// A single locked position.
///
/// - `total` grows on `TopUp` (cliff-only), never shrinks.
/// - `withdrawn` grows on `Withdraw`, never shrinks.
/// - Claimable at time `t` = `schedule.claimable_at(t, total) - withdrawn`.
#[cw_serde]
pub struct Lock {
    pub id: u64,
    /// Current owner. Can `Withdraw`, `Extend`, `TopUp`, `TransferOwner`.
    pub owner: Addr,
    /// Original depositor. Immutable; for provenance only.
    pub creator: Addr,
    pub denom: CheckedDenom,
    pub total: Uint128,
    pub withdrawn: Uint128,
    pub schedule: Schedule,
    pub title: Option<String>,
    pub description: Option<String>,
    pub created_at: Timestamp,
}

impl Lock {
    pub fn remaining(&self) -> Uint128 {
        self.total.checked_sub(self.withdrawn).unwrap_or(Uint128::zero())
    }
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const LOCK_COUNT: Item<u64> = Item::new("lock_count");
pub const LOCKS: Map<u64, Lock> = Map::new("locks");

/// Secondary indexes (write-through, hand-maintained). Using a Map with empty
/// value keeps reads simple and avoids an IndexedMap migration if we ever add
/// more axes.
///
/// `LOCKS_BY_OWNER` rotates on `TransferOwner`; `LOCKS_BY_CREATOR` is immutable
/// for the lifetime of the lock (provenance), letting an OTC seller still query
/// "locks I created" after handing ownership to the buyer.
pub const LOCKS_BY_OWNER: Map<(&Addr, u64), ()> = Map::new("locks_by_owner");
pub const LOCKS_BY_CREATOR: Map<(&Addr, u64), ()> = Map::new("locks_by_creator");
pub const LOCKS_BY_DENOM: Map<(&str, u64), ()> = Map::new("locks_by_denom");
