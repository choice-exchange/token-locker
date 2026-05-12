use cosmwasm_std::{
    entry_point, from_json, to_json_binary, Addr, BankMsg, Binary, Coin, CosmosMsg, Deps, DepsMut,
    Env, MessageInfo, Order, Response, StdResult, Storage, Timestamp, Uint128,
};
use cw2::set_contract_version;
use cw_storage_plus::Bound;

use crate::cw20::Cw20ReceiveMsg;

use crate::denom::{CheckedDenom, UncheckedDenom};
use crate::error::ContractError;
use crate::msg::{
    ClaimableManyEntry, ClaimableManyResponse, ClaimableResponse, Cw20HookMsg, ExecuteMsg,
    InstantiateMsg, LockResponse, LocksResponse, MigrateMsg, QueryMsg, SortOrder, StatsResponse,
};
use crate::schedule::Schedule;
use crate::state::{
    Config, Lock, CONFIG, LOCKS, LOCKS_BY_CREATOR, LOCKS_BY_DENOM, LOCKS_BY_OWNER, LOCK_COUNT,
};

const CONTRACT_NAME: &str = "crates.io:choice-token-locker";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

const DEFAULT_LIMIT: u32 = 30;
const MAX_LIMIT: u32 = 100;
const MAX_TITLE_LEN: usize = 128;
const MAX_DESCRIPTION_LEN: usize = 1024;
/// Hard cap on `ClaimableMany.ids.len()` — keeps a single query within the
/// per-call gas envelope frontends can reliably plan around.
const MAX_BATCH_IDS: usize = 100;

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let admin = msg
        .admin
        .map(|a| deps.api.addr_validate(&a))
        .transpose()?
        .or(Some(info.sender.clone()));
    let fee_collector = msg
        .fee_collector
        .map(|a| deps.api.addr_validate(&a))
        .transpose()?;

    validate_fee_config(&msg.creation_fee, &fee_collector)?;

    CONFIG.save(
        deps.storage,
        &Config {
            admin,
            fee_collector,
            creation_fee: msg.creation_fee,
        },
    )?;
    LOCK_COUNT.save(deps.storage, &0u64)?;

    Ok(Response::new().add_attribute("action", "instantiate"))
}

/// Enforce the invariants `creation_fee => fee_collector`, `fee.amount > 0`,
/// and `!fee.denom.is_empty()`. Without these, fees either strand in the
/// contract (no collector → no sweep path) or every `Lock` call reverts
/// (zero-amount fee → `BankMsg::Send` with amount 0 is rejected by the SDK).
fn validate_fee_config(
    creation_fee: &Option<Coin>,
    fee_collector: &Option<Addr>,
) -> Result<(), ContractError> {
    if let Some(fee) = creation_fee {
        if fee_collector.is_none() {
            return Err(ContractError::InvalidConfig(
                "creation_fee requires fee_collector to be set".into(),
            ));
        }
        if fee.amount.is_zero() {
            return Err(ContractError::InvalidConfig(
                "creation_fee.amount must be positive".into(),
            ));
        }
        if fee.denom.is_empty() {
            return Err(ContractError::InvalidConfig(
                "creation_fee.denom must be non-empty".into(),
            ));
        }
    }
    Ok(())
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Lock { denom, amount, schedule, title, description } => {
            execute_lock_native(deps, env, info, denom, amount, schedule, title, description)
        }
        ExecuteMsg::Receive(rcv) => execute_receive(deps, env, info, rcv),
        ExecuteMsg::Extend { id, new_unlock_at } => execute_extend(deps, env, info, id, new_unlock_at),
        ExecuteMsg::TopUp { id, amount } => execute_topup_native(deps, env, info, id, amount),
        ExecuteMsg::TransferOwner { id, new_owner } => {
            execute_transfer_owner(deps, env, info, id, new_owner)
        }
        ExecuteMsg::Withdraw { id, amount } => execute_withdraw(deps, env, info, id, amount),
        ExecuteMsg::UpdateConfig { admin, fee_collector, creation_fee } => {
            execute_update_config(deps, info, admin, fee_collector, creation_fee)
        }
    }
}

// ─── creation ────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn execute_lock_native(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    denom: UncheckedDenom,
    amount: Uint128,
    schedule: Schedule,
    title: Option<String>,
    description: Option<String>,
) -> Result<Response, ContractError> {
    let checked = denom.into_checked(deps.as_ref())?;
    if matches!(checked, CheckedDenom::Cw20(_)) {
        return Err(ContractError::Cw20MustUseReceive {});
    }
    // Strip the creation fee from info.funds before checking lock deposit.
    let remaining_funds = take_creation_fee(deps.storage, &info.funds)?;
    let info_after_fee = MessageInfo {
        sender: info.sender.clone(),
        funds: remaining_funds,
    };
    checked.assert_native_funds(&info_after_fee, amount)?;

    let lock = create_lock(
        deps.storage,
        env.block.time,
        info.sender.clone(),
        info.sender,
        checked,
        amount,
        schedule,
        title,
        description,
    )?;
    Ok(Response::new()
        .add_messages(forward_fee_msg(deps.storage)?)
        .add_attribute("action", "lock")
        .add_attribute("id", lock.id.to_string())
        .add_attribute("amount", amount)
        .add_attribute("owner", lock.owner.as_str())
        .add_attribute("creator", lock.creator.as_str())
        .add_attribute("denom", lock.denom.as_str())
        .add_attribute("denom_kind", lock.denom.kind_str())
        .add_attribute("schedule_type", lock.schedule.type_tag())
        .add_attribute("unlock_at", lock.schedule.first_unlock_at().seconds().to_string())
        .add_attribute("final_unlock_at", lock.schedule.final_unlock_at().seconds().to_string()))
}

fn execute_receive(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    rcv: Cw20ReceiveMsg,
) -> Result<Response, ContractError> {
    // info.sender is the cw20 contract address.
    let cw20_addr = info.sender.clone();
    let depositor = deps.api.addr_validate(&rcv.sender)?;
    let amount = rcv.amount;
    let hook: Cw20HookMsg = from_json(&rcv.msg)?;

    // No creation fee charging path for cw20 deposits: fee is native and would
    // require a second message. Document this — fee applies to native locks only.

    match hook {
        Cw20HookMsg::Lock { schedule, title, description } => {
            let lock = create_lock(
                deps.storage,
                env.block.time,
                depositor.clone(),
                depositor,
                CheckedDenom::Cw20(cw20_addr),
                amount,
                schedule,
                title,
                description,
            )?;
            Ok(Response::new()
                .add_attribute("action", "lock")
                .add_attribute("id", lock.id.to_string())
                .add_attribute("amount", amount)
                .add_attribute("owner", lock.owner.as_str())
                .add_attribute("creator", lock.creator.as_str())
                .add_attribute("denom", lock.denom.as_str())
                .add_attribute("denom_kind", lock.denom.kind_str())
                .add_attribute("schedule_type", lock.schedule.type_tag())
                .add_attribute("unlock_at", lock.schedule.first_unlock_at().seconds().to_string())
                .add_attribute("final_unlock_at", lock.schedule.final_unlock_at().seconds().to_string()))
        }
        Cw20HookMsg::TopUp { id } => {
            let mut lock = LOCKS.load(deps.storage, id).map_err(|_| ContractError::LockNotFound(id))?;
            if !lock.schedule.is_cliff() {
                return Err(ContractError::CliffOnly {});
            }
            if lock.schedule.final_unlock_at().seconds() <= env.block.time.seconds() {
                return Err(ContractError::TopUpAfterUnlock {});
            }
            // The depositing cw20 must match the lock's denom.
            match &lock.denom {
                CheckedDenom::Cw20(a) if a == cw20_addr => {}
                _ => return Err(ContractError::WrongFundsAttached {}),
            }
            if amount.is_zero() {
                return Err(ContractError::ZeroAmount {});
            }
            lock.total = lock.total.checked_add(amount)?;
            LOCKS.save(deps.storage, id, &lock)?;
            Ok(Response::new()
                .add_attribute("action", "topup")
                .add_attribute("id", id.to_string())
                .add_attribute("amount", amount)
                .add_attribute("owner", lock.owner.as_str())
                .add_attribute("denom", lock.denom.as_str())
                .add_attribute("denom_kind", lock.denom.kind_str()))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn create_lock(
    storage: &mut dyn Storage,
    now: Timestamp,
    creator: Addr,
    owner: Addr,
    denom: CheckedDenom,
    amount: Uint128,
    schedule: Schedule,
    title: Option<String>,
    description: Option<String>,
) -> Result<Lock, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    schedule.validate(now, amount)?;
    if let Some(t) = &title {
        if t.len() > MAX_TITLE_LEN {
            return Err(ContractError::InvalidSchedule("title too long".into()));
        }
    }
    if let Some(d) = &description {
        if d.len() > MAX_DESCRIPTION_LEN {
            return Err(ContractError::InvalidSchedule("description too long".into()));
        }
    }

    let id = LOCK_COUNT.load(storage)? + 1;
    LOCK_COUNT.save(storage, &id)?;

    let lock = Lock {
        id,
        owner: owner.clone(),
        creator,
        denom: denom.clone(),
        total: amount,
        withdrawn: Uint128::zero(),
        schedule,
        title,
        description,
        created_at: now,
    };
    LOCKS.save(storage, id, &lock)?;
    LOCKS_BY_OWNER.save(storage, (&owner, id), &())?;
    LOCKS_BY_CREATOR.save(storage, (&lock.creator, id), &())?;
    LOCKS_BY_DENOM.save(storage, (denom.key().as_str(), id), &())?;
    Ok(lock)
}

// ─── modify ──────────────────────────────────────────────────────────────────

fn execute_extend(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    id: u64,
    new_unlock_at: Timestamp,
) -> Result<Response, ContractError> {
    let mut lock = LOCKS.load(deps.storage, id).map_err(|_| ContractError::LockNotFound(id))?;
    if lock.owner != info.sender {
        return Err(ContractError::Unauthorized {});
    }
    let current = match lock.schedule {
        Schedule::Cliff { unlock_at } => unlock_at,
        _ => return Err(ContractError::CliffOnly {}),
    };
    // Once a cliff has unlocked, the lock has effectively ended its locking
    // duty; re-extending would let an owner re-arm a partially-drained lock
    // and contradict the "no early exit / monotonic" invariant readers expect.
    if current.seconds() <= env.block.time.seconds() {
        return Err(ContractError::ExtendAfterUnlock {});
    }
    if new_unlock_at.seconds() <= current.seconds() {
        return Err(ContractError::ExtendNotForward {});
    }
    lock.schedule = Schedule::Cliff { unlock_at: new_unlock_at };
    LOCKS.save(deps.storage, id, &lock)?;
    Ok(Response::new()
        .add_attribute("action", "extend")
        .add_attribute("id", id.to_string())
        .add_attribute("new_unlock_at", new_unlock_at.seconds().to_string())
        .add_attribute("owner", lock.owner.as_str())
        .add_attribute("denom", lock.denom.as_str())
        .add_attribute("denom_kind", lock.denom.kind_str()))
}

fn execute_topup_native(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    id: u64,
    amount: Uint128,
) -> Result<Response, ContractError> {
    let mut lock = LOCKS.load(deps.storage, id).map_err(|_| ContractError::LockNotFound(id))?;
    if !lock.schedule.is_cliff() {
        return Err(ContractError::CliffOnly {});
    }
    if matches!(lock.denom, CheckedDenom::Cw20(_)) {
        return Err(ContractError::Cw20MustUseReceive {});
    }
    // Top-up after unlock would just route funds straight to the owner — the
    // lock no longer locks anything. Reject so misdirected funds revert
    // instead of silently transferring.
    if lock.schedule.final_unlock_at().seconds() <= env.block.time.seconds() {
        return Err(ContractError::TopUpAfterUnlock {});
    }
    lock.denom.assert_native_funds(&info, amount)?;
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    lock.total = lock.total.checked_add(amount)?;
    LOCKS.save(deps.storage, id, &lock)?;
    Ok(Response::new()
        .add_attribute("action", "topup")
        .add_attribute("id", id.to_string())
        .add_attribute("amount", amount)
        .add_attribute("owner", lock.owner.as_str())
        .add_attribute("denom", lock.denom.as_str())
        .add_attribute("denom_kind", lock.denom.kind_str()))
}

fn execute_transfer_owner(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    id: u64,
    new_owner: String,
) -> Result<Response, ContractError> {
    let mut lock = LOCKS.load(deps.storage, id).map_err(|_| ContractError::LockNotFound(id))?;
    if lock.owner != info.sender {
        return Err(ContractError::Unauthorized {});
    }
    let new_owner = deps.api.addr_validate(&new_owner)?;
    if new_owner == lock.owner {
        return Err(ContractError::TransferToSelf {});
    }
    // The locker has no execute path to act as `info.sender`, so transferring
    // to the contract itself permanently strands the lock.
    if new_owner == env.contract.address {
        return Err(ContractError::TransferToContract {});
    }
    let old_owner = lock.owner.clone();
    LOCKS_BY_OWNER.remove(deps.storage, (&lock.owner, id));
    LOCKS_BY_OWNER.save(deps.storage, (&new_owner, id), &())?;
    lock.owner = new_owner.clone();
    LOCKS.save(deps.storage, id, &lock)?;
    Ok(Response::new()
        .add_attribute("action", "transfer_owner")
        .add_attribute("id", id.to_string())
        .add_attribute("new_owner", new_owner)
        .add_attribute("old_owner", old_owner.as_str())
        .add_attribute("denom", lock.denom.as_str())
        .add_attribute("denom_kind", lock.denom.kind_str()))
}

fn execute_withdraw(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    id: u64,
    amount: Option<Uint128>,
) -> Result<Response, ContractError> {
    let mut lock = LOCKS.load(deps.storage, id).map_err(|_| ContractError::LockNotFound(id))?;
    if lock.owner != info.sender {
        return Err(ContractError::Unauthorized {});
    }
    let claimable_total = lock.schedule.claimable_at(env.block.time, lock.total);
    let claimable_now = claimable_total.checked_sub(lock.withdrawn).unwrap_or(Uint128::zero());
    if claimable_now.is_zero() {
        if lock.withdrawn >= lock.total {
            return Err(ContractError::NothingClaimable {});
        }
        return Err(ContractError::StillLocked {});
    }
    let requested = amount.unwrap_or(claimable_now);
    if requested.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    if requested > claimable_now {
        return Err(ContractError::InsufficientClaimable {
            requested,
            claimable: claimable_now,
        });
    }
    lock.withdrawn = lock.withdrawn.checked_add(requested)?;
    let transfer = lock.denom.transfer_msg(&lock.owner, requested)?;
    LOCKS.save(deps.storage, id, &lock)?;
    Ok(Response::new()
        .add_message(transfer)
        .add_attribute("action", "withdraw")
        .add_attribute("id", id.to_string())
        .add_attribute("amount", requested)
        .add_attribute("owner", lock.owner.as_str())
        .add_attribute("denom", lock.denom.as_str())
        .add_attribute("denom_kind", lock.denom.kind_str()))
}

// ─── admin ───────────────────────────────────────────────────────────────────

fn execute_update_config(
    deps: DepsMut,
    info: MessageInfo,
    admin: Option<String>,
    fee_collector: Option<Option<String>>,
    creation_fee: Option<Option<Coin>>,
) -> Result<Response, ContractError> {
    let mut cfg = CONFIG.load(deps.storage)?;
    match &cfg.admin {
        Some(a) if a == info.sender => {}
        _ => return Err(ContractError::Unauthorized {}),
    }
    if let Some(a) = admin {
        cfg.admin = Some(deps.api.addr_validate(&a)?);
    }
    if let Some(f) = fee_collector {
        cfg.fee_collector = match f {
            Some(addr) => Some(deps.api.addr_validate(&addr)?),
            None => None,
        };
    }
    if let Some(fee) = creation_fee {
        cfg.creation_fee = fee;
    }
    validate_fee_config(&cfg.creation_fee, &cfg.fee_collector)?;
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

// ─── fee handling ────────────────────────────────────────────────────────────

/// Remove the creation fee from a Vec<Coin> if a fee is configured. Returns the
/// remaining funds (everything except the fee). Errors if the fee is missing.
fn take_creation_fee(storage: &dyn Storage, funds: &[Coin]) -> Result<Vec<Coin>, ContractError> {
    let cfg = CONFIG.load(storage)?;
    let Some(fee) = cfg.creation_fee else {
        return Ok(funds.to_vec());
    };
    let mut remaining = Vec::with_capacity(funds.len());
    let mut found = false;
    for c in funds {
        if !found && c.denom == fee.denom {
            if c.amount < fee.amount {
                return Err(ContractError::CreationFeeMissing {
                    expected: fee.amount,
                    denom: fee.denom.clone(),
                });
            }
            let surplus = c.amount - fee.amount;
            if !surplus.is_zero() {
                remaining.push(Coin { denom: c.denom.clone(), amount: surplus });
            }
            found = true;
        } else {
            remaining.push(c.clone());
        }
    }
    if !found {
        return Err(ContractError::CreationFeeMissing {
            expected: fee.amount,
            denom: fee.denom,
        });
    }
    Ok(remaining)
}

/// Build the messages to forward collected fees to the fee_collector. Returns
/// empty if no fee or no collector (in which case fees stay in the contract —
/// admin can set a collector later and sweep via UpdateConfig+manual flow if
/// needed, but the simpler convention is to always configure a collector).
fn forward_fee_msg(storage: &dyn Storage) -> Result<Vec<CosmosMsg>, ContractError> {
    let cfg = CONFIG.load(storage)?;
    let (Some(fee), Some(collector)) = (cfg.creation_fee, cfg.fee_collector) else {
        return Ok(vec![]);
    };
    Ok(vec![CosmosMsg::Bank(BankMsg::Send {
        to_address: collector.into_string(),
        amount: vec![fee],
    })])
}

// ─── queries ─────────────────────────────────────────────────────────────────

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Stats {} => to_json_binary(&StatsResponse {
            total_locks: LOCK_COUNT.load(deps.storage)?,
        }),
        QueryMsg::Lock { id } => to_json_binary(&LockResponse {
            lock: LOCKS.load(deps.storage, id)?,
        }),
        QueryMsg::LocksByOwner { owner, start_after, limit, order } => {
            let owner = deps.api.addr_validate(&owner)?;
            let locks = paginate_owner(deps, &owner, start_after, limit, order)?;
            to_json_binary(&LocksResponse { locks })
        }
        QueryMsg::LocksByCreator { creator, start_after, limit, order } => {
            let creator = deps.api.addr_validate(&creator)?;
            let locks = paginate_creator(deps, &creator, start_after, limit, order)?;
            to_json_binary(&LocksResponse { locks })
        }
        QueryMsg::LocksByDenom { denom, start_after, limit, order } => {
            let locks = paginate_denom(deps, &denom, start_after, limit, order)?;
            to_json_binary(&LocksResponse { locks })
        }
        QueryMsg::AllLocks { start_after, limit, order } => {
            let locks = paginate_all(deps, start_after, limit, order)?;
            to_json_binary(&LocksResponse { locks })
        }
        QueryMsg::Claimable { id, at } => {
            let lock = LOCKS.load(deps.storage, id)?;
            let t = at.unwrap_or(env.block.time);
            to_json_binary(&claimable_for(&lock, t))
        }
        QueryMsg::ClaimableMany { ids, at } => {
            if ids.len() > MAX_BATCH_IDS {
                return Err(cosmwasm_std::StdError::msg(format!(
                    "batch too large: max {} ids, got {}",
                    MAX_BATCH_IDS,
                    ids.len()
                )));
            }
            let t = at.unwrap_or(env.block.time);
            let entries = ids
                .into_iter()
                .map(|id| ClaimableManyEntry {
                    id,
                    response: LOCKS
                        .may_load(deps.storage, id)
                        .ok()
                        .flatten()
                        .map(|lock| claimable_for(&lock, t)),
                })
                .collect();
            to_json_binary(&ClaimableManyResponse { entries })
        }
    }
}

fn claimable_for(lock: &Lock, t: Timestamp) -> ClaimableResponse {
    let claimable_total = lock.schedule.claimable_at(t, lock.total);
    let claimable = claimable_total
        .checked_sub(lock.withdrawn)
        .unwrap_or(Uint128::zero());
    ClaimableResponse {
        claimable,
        withdrawn: lock.withdrawn,
        remaining: lock.remaining(),
    }
}

fn clamp_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize
}

/// Split `start_after` into (min, max) bounds for a given sort order.
fn bounds_for_order(
    start_after: Option<u64>,
    order: Order,
) -> (Option<Bound<'static, u64>>, Option<Bound<'static, u64>>) {
    let bound = start_after.map(Bound::exclusive);
    match order {
        Order::Ascending => (bound, None),
        Order::Descending => (None, bound),
    }
}

fn paginate_owner(
    deps: Deps,
    owner: &Addr,
    start_after: Option<u64>,
    limit: Option<u32>,
    order: Option<SortOrder>,
) -> StdResult<Vec<Lock>> {
    let limit = clamp_limit(limit);
    let order = order.unwrap_or_default().to_order();
    let (min, max) = bounds_for_order(start_after, order);
    LOCKS_BY_OWNER
        .prefix(owner)
        .keys(deps.storage, min, max, order)
        .take(limit)
        .map(|res| {
            let id = res?;
            LOCKS.load(deps.storage, id)
        })
        .collect()
}

fn paginate_creator(
    deps: Deps,
    creator: &Addr,
    start_after: Option<u64>,
    limit: Option<u32>,
    order: Option<SortOrder>,
) -> StdResult<Vec<Lock>> {
    let limit = clamp_limit(limit);
    let order = order.unwrap_or_default().to_order();
    let (min, max) = bounds_for_order(start_after, order);
    LOCKS_BY_CREATOR
        .prefix(creator)
        .keys(deps.storage, min, max, order)
        .take(limit)
        .map(|res| {
            let id = res?;
            LOCKS.load(deps.storage, id)
        })
        .collect()
}

fn paginate_denom(
    deps: Deps,
    denom: &str,
    start_after: Option<u64>,
    limit: Option<u32>,
    order: Option<SortOrder>,
) -> StdResult<Vec<Lock>> {
    let limit = clamp_limit(limit);
    let order = order.unwrap_or_default().to_order();
    let (min, max) = bounds_for_order(start_after, order);
    LOCKS_BY_DENOM
        .prefix(denom)
        .keys(deps.storage, min, max, order)
        .take(limit)
        .map(|res| {
            let id = res?;
            LOCKS.load(deps.storage, id)
        })
        .collect()
}

fn paginate_all(
    deps: Deps,
    start_after: Option<u64>,
    limit: Option<u32>,
    order: Option<SortOrder>,
) -> StdResult<Vec<Lock>> {
    let limit = clamp_limit(limit);
    let order = order.unwrap_or_default().to_order();
    let (min, max) = bounds_for_order(start_after, order);
    LOCKS
        .range(deps.storage, min, max, order)
        .take(limit)
        .map(|res| res.map(|(_, v)| v))
        .collect()
}

#[entry_point]
pub fn migrate(deps: DepsMut, _env: Env, _msg: MigrateMsg) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    Ok(Response::new().add_attribute("action", "migrate"))
}
