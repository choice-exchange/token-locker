//! Minimal vendored cw20 types — just what this contract needs.
//!
//! Upstream `cw20 = "2.0"` still pins `cosmwasm-std = "2.x"`. To use
//! cosmwasm-std 3.x we inline the messages we actually touch:
//! the `Receive` hook payload, the `Transfer` execute variant, and the
//! `TokenInfo` query (used by `execute_receive` to probe that `info.sender`
//! is really a cw20 contract before creating a lock).

use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Binary, Uint128};

#[cw_serde]
pub struct Cw20ReceiveMsg {
    pub sender: String,
    pub amount: Uint128,
    pub msg: Binary,
}

#[cw_serde]
pub enum Cw20ExecuteMsg {
    Transfer { recipient: String, amount: Uint128 },
}

/// Subset of `cw20::Cw20QueryMsg` used to probe whether a sender is a cw20
/// contract. We only need `TokenInfo` — its successful response is enough to
/// distinguish a real cw20 from an EOA or unrelated contract.
#[cw_serde]
pub enum Cw20QueryMsg {
    TokenInfo {},
}

#[cw_serde]
pub struct TokenInfoResponse {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub total_supply: Uint128,
}
