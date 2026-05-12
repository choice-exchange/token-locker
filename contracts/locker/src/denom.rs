use cosmwasm_schema::cw_serde;
use cosmwasm_std::{
    to_json_binary, Addr, BankMsg, Coin, CosmosMsg, Deps, MessageInfo, StdResult, Uint128, WasmMsg,
};
use crate::cw20::Cw20ExecuteMsg;
use crate::error::ContractError;

/// Unvalidated denom supplied by the user. Validated into [`CheckedDenom`] at
/// the contract boundary. `Native(d)` covers token-factory subdenoms as well
/// as base denoms like `inj`.
#[cw_serde]
pub enum UncheckedDenom {
    Native(String),
    Cw20(String),
}

/// Stored, validated denom. Use [`key`](Self::key) for stable map indexing
/// (`native:<d>` / `cw20:<addr>`) and [`transfer_msg`](Self::transfer_msg)
/// to construct the outbound transfer for `Withdraw`.
#[cw_serde]
pub enum CheckedDenom {
    Native(String),
    Cw20(Addr),
}

impl UncheckedDenom {
    pub fn into_checked(self, deps: Deps) -> Result<CheckedDenom, ContractError> {
        Ok(match self {
            UncheckedDenom::Native(d) => {
                if d.is_empty() {
                    return Err(ContractError::InvalidDenom {});
                }
                CheckedDenom::Native(d)
            }
            UncheckedDenom::Cw20(addr) => CheckedDenom::Cw20(deps.api.addr_validate(&addr)?),
        })
    }
}

impl CheckedDenom {
    pub fn key(&self) -> String {
        match self {
            CheckedDenom::Native(d) => format!("native:{d}"),
            CheckedDenom::Cw20(a) => format!("cw20:{a}"),
        }
    }

    pub fn as_str(&self) -> String {
        match self {
            CheckedDenom::Native(d) => d.clone(),
            CheckedDenom::Cw20(a) => a.to_string(),
        }
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            CheckedDenom::Native(_) => "native",
            CheckedDenom::Cw20(_) => "cw20",
        }
    }

    /// Verify a native deposit. cw20 deposits MUST come through Receive(),
    /// so calling this on a cw20 lock is a contract bug.
    pub fn assert_native_funds(&self, info: &MessageInfo, expected: Uint128) -> Result<(), ContractError> {
        let denom = match self {
            CheckedDenom::Native(d) => d,
            CheckedDenom::Cw20(_) => return Err(ContractError::Cw20MustUseReceive {}),
        };
        if info.funds.len() != 1 {
            return Err(ContractError::WrongFundsAttached {});
        }
        let coin = &info.funds[0];
        if &coin.denom != denom || coin.amount != cosmwasm_std::Uint256::from(expected) {
            return Err(ContractError::WrongFundsAttached {});
        }
        Ok(())
    }

    /// Build the bank/wasm msg to send `amount` of this denom from the contract to `to`.
    pub fn transfer_msg(&self, to: &Addr, amount: Uint128) -> StdResult<CosmosMsg> {
        Ok(match self {
            CheckedDenom::Native(denom) => CosmosMsg::Bank(BankMsg::Send {
                to_address: to.to_string(),
                amount: vec![Coin { denom: denom.clone(), amount: amount.into() }],
            }),
            CheckedDenom::Cw20(addr) => CosmosMsg::Wasm(WasmMsg::Execute {
                contract_addr: addr.to_string(),
                msg: to_json_binary(&Cw20ExecuteMsg::Transfer {
                    recipient: to.to_string(),
                    amount,
                })?,
                funds: vec![],
            }),
        })
    }
}
