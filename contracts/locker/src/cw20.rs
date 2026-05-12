//! Minimal vendored cw20 types — just what this contract needs.
//!
//! Upstream `cw20 = "2.0"` still pins `cosmwasm-std = "2.x"`. To use
//! cosmwasm-std 3.x we inline the two messages we actually touch:
//! the `Receive` hook payload and the `Transfer` execute variant.

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
