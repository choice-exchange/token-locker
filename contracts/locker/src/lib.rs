//! # Choice Token Locker
//!
//! A permissionless, multi-tenant token locker. Anyone can deposit cw20 tokens
//! or native denoms, declare a [`Schedule`](schedule::Schedule), and later withdraw
//! at maturity. One deployed contract serves unlimited users — each lock has a
//! unique [`id`](state::Lock::id).
//!
//! ## Key types
//! - [`InstantiateMsg`](msg::InstantiateMsg) / [`ExecuteMsg`](msg::ExecuteMsg) /
//!   [`QueryMsg`](msg::QueryMsg) — contract surface
//! - [`Schedule`](schedule::Schedule) — `Cliff`, `SaturatingLinear`, `PiecewiseLinear`
//! - [`UncheckedDenom`](denom::UncheckedDenom) / [`CheckedDenom`](denom::CheckedDenom) —
//!   `Native` or `Cw20`
//! - [`Lock`](state::Lock) — on-chain record
//!
//! See the workspace README for the full architecture, security model, and
//! build/test instructions.

pub mod contract;
pub mod cw20;
pub mod denom;
pub mod error;
pub mod msg;
pub mod schedule;
pub mod state;

#[cfg(test)]
mod tests;

pub use crate::error::ContractError;
