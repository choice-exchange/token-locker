use cosmwasm_std::{OverflowError, StdError, Uint128, Uint256};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("{0}")]
    Overflow(#[from] OverflowError),

    #[error("unauthorized")]
    Unauthorized {},

    #[error("invalid denom")]
    InvalidDenom {},

    #[error("cw20 deposits must arrive via Cw20::Send -> Receive")]
    Cw20MustUseReceive {},

    #[error("sender {0} is not a cw20 contract")]
    NotACw20Contract(String),

    #[error("attached funds do not match declared lock amount or denom")]
    WrongFundsAttached {},

    #[error("creation fee required: expected {expected} {denom}")]
    CreationFeeMissing { expected: Uint256, denom: String },

    #[error("lock {0} not found")]
    LockNotFound(u64),

    #[error("amount must be positive")]
    ZeroAmount {},

    #[error("unlock time must be in the future")]
    UnlockNotInFuture {},

    #[error("extension must move unlock time forward")]
    ExtendNotForward {},

    #[error("lock is not yet unlocked")]
    StillLocked {},

    #[error("nothing claimable: lock is fully withdrawn")]
    NothingClaimable {},

    #[error("requested withdraw {requested} exceeds claimable {claimable}")]
    InsufficientClaimable { requested: Uint128, claimable: Uint128 },

    #[error("operation only valid on cliff-schedule locks")]
    CliffOnly {},

    #[error("schedule is invalid: {0}")]
    InvalidSchedule(String),

    #[error("piecewise schedule has too many steps: max {max}, got {got}")]
    PiecewiseTooManySteps { max: usize, got: usize },

    #[error("extend is rejected: lock has already unlocked")]
    ExtendAfterUnlock {},

    #[error("top-up is rejected: lock has already unlocked")]
    TopUpAfterUnlock {},

    #[error("cannot transfer ownership to current owner")]
    TransferToSelf {},

    #[error("cannot transfer ownership to the locker contract itself")]
    TransferToContract {},

    #[error("invalid config: {0}")]
    InvalidConfig(String),
}
