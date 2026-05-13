use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env, MockApi};
use cosmwasm_std::{
    coins, from_json, to_json_binary, Addr, BankMsg, Coin, ContractResult, CosmosMsg, SystemResult,
    Timestamp, Uint128, Uint256, WasmMsg, WasmQuery,
};
use crate::contract::{execute, instantiate, query};
use crate::cw20::{Cw20ReceiveMsg, TokenInfoResponse};
use crate::denom::UncheckedDenom;
use crate::error::ContractError;
use crate::msg::{
    ClaimableManyResponse, ClaimableResponse, Cw20HookMsg, ExecuteMsg, InstantiateMsg,
    LockResponse, LocksResponse, QueryMsg, SortOrder, StatsResponse,
};
use crate::schedule::Schedule;

const DENOM: &str = "inj";

fn addr(name: &str) -> Addr {
    MockApi::default().addr_make(name)
}

struct Actors {
    alice: Addr,
    admin: Addr,
    fee_coll: Addr,
    cw20: Addr,
}

fn actors() -> Actors {
    Actors {
        alice: addr("alice"),
        admin: addr("admin"),
        fee_coll: addr("fee_coll"),
        cw20: addr("cw20"),
    }
}

fn setup(creation_fee: Option<Coin>) -> (
    cosmwasm_std::OwnedDeps<
        cosmwasm_std::testing::MockStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    >,
    Actors,
) {
    let mut deps = mock_dependencies();
    let a = actors();
    // Wire the wasm querier so the cw20 sanity probe (`TokenInfo {}`) succeeds
    // for the canonical `cw20` test address and fails for everything else.
    let cw20_addr = a.cw20.to_string();
    deps.querier.update_wasm(move |q: &WasmQuery| match q {
        WasmQuery::Smart { contract_addr, .. } if contract_addr == &cw20_addr => {
            SystemResult::Ok(ContractResult::Ok(
                to_json_binary(&TokenInfoResponse {
                    name: "Test".to_string(),
                    symbol: "TST".to_string(),
                    decimals: 6,
                    total_supply: Uint128::new(1_000_000),
                })
                .unwrap(),
            ))
        }
        _ => SystemResult::Err(cosmwasm_std::SystemError::NoSuchContract {
            addr: match q {
                WasmQuery::Smart { contract_addr, .. } => contract_addr.clone(),
                _ => "unknown".to_string(),
            },
        }),
    });
    let env = mock_env();
    let info = message_info(&a.admin, &[]);
    instantiate(
        deps.as_mut(),
        env,
        info,
        InstantiateMsg {
            admin: Some(a.admin.to_string()),
            fee_collector: Some(a.fee_coll.to_string()),
            creation_fee,
        },
    )
    .unwrap();
    (deps, a)
}

fn future(env: &cosmwasm_std::Env, secs: u64) -> Timestamp {
    env.block.time.plus_seconds(secs)
}

#[test]
fn cliff_lock_full_lifecycle() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 1000);

    let info = message_info(&a.alice, &coins(500, DENOM));
    let res = execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(500),
            schedule: Schedule::Cliff { unlock_at },
            title: Some("LP lock".into()),
            description: None,
        },
    )
    .unwrap();
    assert!(res.attributes.iter().any(|x| x.key == "id" && x.value == "1"));

    let info = message_info(&a.alice, &[]);
    let err = execute(
        deps.as_mut(),
        env.clone(),
        info.clone(),
        ExecuteMsg::Withdraw { id: 1, amount: None },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::StillLocked {}));

    let mut later = env.clone();
    later.block.time = unlock_at;
    let res = execute(
        deps.as_mut(),
        later,
        info,
        ExecuteMsg::Withdraw { id: 1, amount: None },
    )
    .unwrap();
    let msg = &res.messages[0].msg;
    match msg {
        CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
            assert_eq!(to_address, &a.alice.to_string());
            assert_eq!(amount[0].denom, DENOM);
            assert_eq!(amount[0].amount, Uint256::from(500u128));
        }
        _ => panic!("expected bank send"),
    }
}

#[test]
fn linear_partial_withdraws() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let start = env.block.time;
    let end = start.plus_seconds(1000);

    let info = message_info(&a.alice, &coins(1000, DENOM));
    execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(1000),
            schedule: Schedule::SaturatingLinear { start_at: start, end_at: end },
            title: None,
            description: None,
        },
    )
    .unwrap();

    let mut mid = env.clone();
    mid.block.time = start.plus_seconds(500);
    let info = message_info(&a.alice, &[]);
    execute(
        deps.as_mut(),
        mid.clone(),
        info.clone(),
        ExecuteMsg::Withdraw { id: 1, amount: None },
    )
    .unwrap();

    let q: ClaimableResponse = from_json(
        query(deps.as_ref(), mid.clone(), QueryMsg::Claimable { id: 1, at: None }).unwrap(),
    )
    .unwrap();
    assert_eq!(q.withdrawn, Uint128::new(500));
    assert_eq!(q.claimable, Uint128::zero());

    let mut done = env;
    done.block.time = end;
    let res = execute(
        deps.as_mut(),
        done,
        info,
        ExecuteMsg::Withdraw { id: 1, amount: None },
    )
    .unwrap();
    let CosmosMsg::Bank(BankMsg::Send { amount, .. }) = &res.messages[0].msg else {
        panic!("bank")
    };
    assert_eq!(amount[0].amount, Uint256::from(500u128));
}

#[test]
fn cw20_receive_creates_lock_and_withdraws() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 1000);

    let hook = Cw20HookMsg::Lock {
        schedule: Schedule::Cliff { unlock_at },
        title: None,
        description: None,
    };
    let rcv = Cw20ReceiveMsg {
        sender: a.alice.to_string(),
        amount: Uint128::new(1234),
        msg: cosmwasm_std::to_json_binary(&hook).unwrap(),
    };
    let info = message_info(&a.cw20, &[]);
    execute(deps.as_mut(), env.clone(), info, ExecuteMsg::Receive(rcv)).unwrap();

    let mut later = env;
    later.block.time = unlock_at;
    let info = message_info(&a.alice, &[]);
    let res = execute(
        deps.as_mut(),
        later,
        info,
        ExecuteMsg::Withdraw { id: 1, amount: None },
    )
    .unwrap();
    match &res.messages[0].msg {
        CosmosMsg::Wasm(WasmMsg::Execute { contract_addr, .. }) => {
            assert_eq!(contract_addr, &a.cw20.to_string());
        }
        _ => panic!("expected cw20 transfer"),
    }
}

#[test]
fn admin_cannot_touch_locks() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 1000);
    let info = message_info(&a.alice, &coins(100, DENOM));
    execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(100),
            schedule: Schedule::Cliff { unlock_at },
            title: None,
            description: None,
        },
    )
    .unwrap();

    let info = message_info(&a.admin, &[]);
    let err = execute(
        deps.as_mut(),
        env.clone(),
        info.clone(),
        ExecuteMsg::Withdraw { id: 1, amount: None },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    let err = execute(
        deps.as_mut(),
        env,
        info,
        ExecuteMsg::TransferOwner { id: 1, new_owner: a.admin.to_string() },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));
}

#[test]
fn extend_only_forward_and_cliff_only() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 1000);
    let info = message_info(&a.alice, &coins(100, DENOM));
    execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(100),
            schedule: Schedule::Cliff { unlock_at },
            title: None,
            description: None,
        },
    )
    .unwrap();

    let info = message_info(&a.alice, &[]);
    let err = execute(
        deps.as_mut(),
        env.clone(),
        info.clone(),
        ExecuteMsg::Extend {
            id: 1,
            new_unlock_at: unlock_at.minus_seconds(1),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::ExtendNotForward {}));

    let _ = execute(
        deps.as_mut(),
        env,
        info,
        ExecuteMsg::Extend {
            id: 1,
            new_unlock_at: unlock_at.plus_seconds(500),
        },
    )
    .unwrap();

    let q: LockResponse = from_json(
        query(deps.as_ref(), mock_env(), QueryMsg::Lock { id: 1 }).unwrap(),
    )
    .unwrap();
    if let Schedule::Cliff { unlock_at: now_at } = q.lock.schedule {
        assert_eq!(now_at, unlock_at.plus_seconds(500));
    } else {
        panic!("schedule changed unexpectedly");
    }
}

#[test]
fn topup_rejected_on_vesting_schedule() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let start = env.block.time;
    let end = start.plus_seconds(1000);

    let info = message_info(&a.alice, &coins(100, DENOM));
    execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(100),
            schedule: Schedule::SaturatingLinear { start_at: start, end_at: end },
            title: None,
            description: None,
        },
    )
    .unwrap();

    let info = message_info(&a.alice, &coins(50, DENOM));
    let err = execute(
        deps.as_mut(),
        env,
        info,
        ExecuteMsg::TopUp { id: 1, amount: Uint128::new(50) },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::CliffOnly {}));
}

#[test]
fn creation_fee_charged_and_forwarded() {
    let fee = Coin { denom: DENOM.into(), amount: Uint256::from(10u128) };
    let (mut deps, a) = setup(Some(fee.clone()));
    let env = mock_env();
    let unlock_at = future(&env, 1000);

    // 10 fee + 100 lock = 110 attached
    let info = message_info(&a.alice, &coins(110, DENOM));
    let res = execute(
        deps.as_mut(),
        env,
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(100),
            schedule: Schedule::Cliff { unlock_at },
            title: None,
            description: None,
        },
    )
    .unwrap();

    let fwd = &res.messages[0].msg;
    match fwd {
        CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
            assert_eq!(to_address, &a.fee_coll.to_string());
            assert_eq!(amount[0].amount, Uint256::from(10u128));
        }
        _ => panic!("expected fee forward"),
    }
}

// ─── new tests for audit fixes ───────────────────────────────────────────────

#[test]
fn instantiate_rejects_fee_without_collector() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let a = actors();
    let info = message_info(&a.admin, &[]);
    let err = crate::contract::instantiate(
        deps.as_mut(),
        env,
        info,
        InstantiateMsg {
            admin: Some(a.admin.to_string()),
            fee_collector: None,
            creation_fee: Some(Coin { denom: DENOM.into(), amount: Uint256::from(10u128) }),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidConfig(_)), "{err:?}");
}

#[test]
fn instantiate_rejects_zero_amount_fee() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let a = actors();
    let info = message_info(&a.admin, &[]);
    let err = crate::contract::instantiate(
        deps.as_mut(),
        env,
        info,
        InstantiateMsg {
            admin: Some(a.admin.to_string()),
            fee_collector: Some(a.fee_coll.to_string()),
            creation_fee: Some(Coin { denom: DENOM.into(), amount: Uint256::zero() }),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidConfig(_)), "{err:?}");
}

#[test]
fn instantiate_rejects_empty_fee_denom() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let a = actors();
    let info = message_info(&a.admin, &[]);
    let err = crate::contract::instantiate(
        deps.as_mut(),
        env,
        info,
        InstantiateMsg {
            admin: Some(a.admin.to_string()),
            fee_collector: Some(a.fee_coll.to_string()),
            creation_fee: Some(Coin { denom: "".into(), amount: Uint256::from(10u128) }),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidConfig(_)), "{err:?}");
}

#[test]
fn update_config_can_clear_fee_collector_when_fee_unset() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let info = message_info(&a.admin, &[]);
    execute(
        deps.as_mut(),
        env,
        info,
        ExecuteMsg::UpdateConfig {
            admin: None,
            fee_collector: Some(None),
            creation_fee: None,
        },
    )
    .unwrap();
}

#[test]
fn update_config_rejects_clearing_collector_while_fee_set() {
    let fee = Coin { denom: DENOM.into(), amount: Uint256::from(10u128) };
    let (mut deps, a) = setup(Some(fee));
    let env = mock_env();
    let info = message_info(&a.admin, &[]);
    let err = execute(
        deps.as_mut(),
        env,
        info,
        ExecuteMsg::UpdateConfig {
            admin: None,
            fee_collector: Some(None),
            creation_fee: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidConfig(_)), "{err:?}");
}

#[test]
fn extend_rejected_after_unlock() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 100);
    let info = message_info(&a.alice, &coins(100, DENOM));
    execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(100),
            schedule: Schedule::Cliff { unlock_at },
            title: None,
            description: None,
        },
    )
    .unwrap();

    let mut after = env;
    after.block.time = unlock_at.plus_seconds(1);
    let info = message_info(&a.alice, &[]);
    let err = execute(
        deps.as_mut(),
        after,
        info,
        ExecuteMsg::Extend {
            id: 1,
            new_unlock_at: unlock_at.plus_seconds(1000),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::ExtendAfterUnlock {}));
}

#[test]
fn topup_rejected_after_unlock_native() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 100);
    let info = message_info(&a.alice, &coins(100, DENOM));
    execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(100),
            schedule: Schedule::Cliff { unlock_at },
            title: None,
            description: None,
        },
    )
    .unwrap();

    let mut after = env;
    after.block.time = unlock_at.plus_seconds(1);
    let info = message_info(&a.alice, &coins(50, DENOM));
    let err = execute(
        deps.as_mut(),
        after,
        info,
        ExecuteMsg::TopUp { id: 1, amount: Uint128::new(50) },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::TopUpAfterUnlock {}));
}

#[test]
fn topup_rejected_after_unlock_cw20() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 100);

    let hook = Cw20HookMsg::Lock {
        schedule: Schedule::Cliff { unlock_at },
        title: None,
        description: None,
    };
    let rcv = Cw20ReceiveMsg {
        sender: a.alice.to_string(),
        amount: Uint128::new(100),
        msg: cosmwasm_std::to_json_binary(&hook).unwrap(),
    };
    let info = message_info(&a.cw20, &[]);
    execute(deps.as_mut(), env.clone(), info, ExecuteMsg::Receive(rcv)).unwrap();

    let mut after = env;
    after.block.time = unlock_at.plus_seconds(1);
    let hook = Cw20HookMsg::TopUp { id: 1 };
    let rcv = Cw20ReceiveMsg {
        sender: a.alice.to_string(),
        amount: Uint128::new(50),
        msg: cosmwasm_std::to_json_binary(&hook).unwrap(),
    };
    let info = message_info(&a.cw20, &[]);
    let err = execute(deps.as_mut(), after, info, ExecuteMsg::Receive(rcv)).unwrap_err();
    assert!(matches!(err, ContractError::TopUpAfterUnlock {}));
}

#[test]
fn transfer_owner_rejects_self() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 1000);
    let info = message_info(&a.alice, &coins(100, DENOM));
    execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(100),
            schedule: Schedule::Cliff { unlock_at },
            title: None,
            description: None,
        },
    )
    .unwrap();

    let info = message_info(&a.alice, &[]);
    let err = execute(
        deps.as_mut(),
        env,
        info,
        ExecuteMsg::TransferOwner {
            id: 1,
            new_owner: a.alice.to_string(),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::TransferToSelf {}));
}

#[test]
fn transfer_owner_rejects_contract_address() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 1000);
    let info = message_info(&a.alice, &coins(100, DENOM));
    execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(100),
            schedule: Schedule::Cliff { unlock_at },
            title: None,
            description: None,
        },
    )
    .unwrap();

    let info = message_info(&a.alice, &[]);
    let err = execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::TransferOwner {
            id: 1,
            new_owner: env.contract.address.to_string(),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::TransferToContract {}));
}

// ─── frontend-integration query tests ────────────────────────────────────────

/// Create N cliff locks owned by `owner`, all native DENOM, each amount=10,
/// returning the env used so callers can warp time if needed.
fn seed_locks(
    deps: &mut cosmwasm_std::OwnedDeps<
        cosmwasm_std::testing::MockStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    >,
    owner: &Addr,
    n: u64,
) -> cosmwasm_std::Env {
    let env = mock_env();
    let unlock_at = future(&env, 1000);
    for _ in 0..n {
        let info = message_info(owner, &coins(10, DENOM));
        execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::Lock {
                denom: UncheckedDenom::Native(DENOM.into()),
                amount: Uint128::new(10),
                schedule: Schedule::Cliff { unlock_at },
                title: None,
                description: None,
            },
        )
        .unwrap();
    }
    env
}

#[test]
fn stats_returns_lock_count() {
    let (mut deps, a) = setup(None);
    let env = mock_env();

    let stats: StatsResponse =
        from_json(query(deps.as_ref(), env.clone(), QueryMsg::Stats {}).unwrap()).unwrap();
    assert_eq!(stats.total_locks, 0);

    seed_locks(&mut deps, &a.alice, 3);

    let stats: StatsResponse =
        from_json(query(deps.as_ref(), env, QueryMsg::Stats {}).unwrap()).unwrap();
    assert_eq!(stats.total_locks, 3);
}

#[test]
fn locks_by_creator_persists_after_transfer() {
    let (mut deps, a) = setup(None);
    let env = seed_locks(&mut deps, &a.alice, 2);

    // alice transfers lock 1 to admin
    let info = message_info(&a.alice, &[]);
    execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::TransferOwner {
            id: 1,
            new_owner: a.admin.to_string(),
        },
    )
    .unwrap();

    // by_owner for alice should return only lock 2
    let resp: LocksResponse = from_json(
        query(
            deps.as_ref(),
            env.clone(),
            QueryMsg::LocksByOwner {
                owner: a.alice.to_string(),
                start_after: None,
                limit: None,
                order: None,
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(resp.locks.iter().map(|l| l.id).collect::<Vec<_>>(), vec![2]);

    // by_creator for alice should still return BOTH locks
    let resp: LocksResponse = from_json(
        query(
            deps.as_ref(),
            env,
            QueryMsg::LocksByCreator {
                creator: a.alice.to_string(),
                start_after: None,
                limit: None,
                order: None,
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        resp.locks.iter().map(|l| l.id).collect::<Vec<_>>(),
        vec![1, 2]
    );
}

#[test]
fn paginated_queries_support_descending_order() {
    let (mut deps, a) = setup(None);
    let env = seed_locks(&mut deps, &a.alice, 4);

    // AllLocks descending, limit 2: should yield [4, 3]
    let resp: LocksResponse = from_json(
        query(
            deps.as_ref(),
            env.clone(),
            QueryMsg::AllLocks {
                start_after: None,
                limit: Some(2),
                order: Some(SortOrder::Desc),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        resp.locks.iter().map(|l| l.id).collect::<Vec<_>>(),
        vec![4, 3]
    );

    // Next page (descending): start_after = 3, expect [2, 1]
    let resp: LocksResponse = from_json(
        query(
            deps.as_ref(),
            env,
            QueryMsg::AllLocks {
                start_after: Some(3),
                limit: Some(2),
                order: Some(SortOrder::Desc),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        resp.locks.iter().map(|l| l.id).collect::<Vec<_>>(),
        vec![2, 1]
    );
}

#[test]
fn claimable_many_returns_mixed_known_and_unknown() {
    let (mut deps, a) = setup(None);
    let env = seed_locks(&mut deps, &a.alice, 2);

    let resp: ClaimableManyResponse = from_json(
        query(
            deps.as_ref(),
            env,
            QueryMsg::ClaimableMany {
                ids: vec![1, 99, 2],
                at: None,
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(resp.entries.len(), 3);
    assert_eq!(resp.entries[0].id, 1);
    assert!(resp.entries[0].response.is_some());
    assert_eq!(resp.entries[1].id, 99);
    assert!(resp.entries[1].response.is_none());
    assert_eq!(resp.entries[2].id, 2);
    assert!(resp.entries[2].response.is_some());
}

#[test]
fn claimable_many_rejects_oversized_batch() {
    let (deps, _) = setup(None);
    let env = mock_env();
    let ids: Vec<u64> = (1..=101).collect();
    let err =
        query(deps.as_ref(), env, QueryMsg::ClaimableMany { ids, at: None }).unwrap_err();
    assert!(err.to_string().contains("batch too large"), "{err}");
}

#[test]
fn locks_by_denom_descending() {
    let (mut deps, a) = setup(None);
    let env = seed_locks(&mut deps, &a.alice, 3);

    let denom_key = format!("native:{DENOM}");
    let resp: LocksResponse = from_json(
        query(
            deps.as_ref(),
            env,
            QueryMsg::LocksByDenom {
                denom: denom_key,
                start_after: None,
                limit: None,
                order: Some(SortOrder::Desc),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        resp.locks.iter().map(|l| l.id).collect::<Vec<_>>(),
        vec![3, 2, 1]
    );
}

#[test]
fn withdraw_nothing_claimable_after_full_drain() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 100);
    let info = message_info(&a.alice, &coins(100, DENOM));
    execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(100),
            schedule: Schedule::Cliff { unlock_at },
            title: None,
            description: None,
        },
    )
    .unwrap();

    let mut after = env;
    after.block.time = unlock_at.plus_seconds(1);
    let info = message_info(&a.alice, &[]);
    execute(
        deps.as_mut(),
        after.clone(),
        info.clone(),
        ExecuteMsg::Withdraw { id: 1, amount: None },
    )
    .unwrap();
    let err = execute(
        deps.as_mut(),
        after,
        info,
        ExecuteMsg::Withdraw { id: 1, amount: None },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NothingClaimable {}));
}

// ─── audit fixes ─────────────────────────────────────────────────────────────

#[test]
fn receive_rejects_non_cw20_sender() {
    // Spoofed Receive from an EOA / non-cw20: the wasm querier reports
    // NoSuchContract for any address other than `a.cw20`, so the probe fails.
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let unlock_at = future(&env, 1000);

    let hook = Cw20HookMsg::Lock {
        schedule: Schedule::Cliff { unlock_at },
        title: None,
        description: None,
    };
    let rcv = Cw20ReceiveMsg {
        sender: a.alice.to_string(),
        amount: Uint128::new(1234),
        msg: cosmwasm_std::to_json_binary(&hook).unwrap(),
    };
    // info.sender = alice (an EOA in this test setup), NOT the registered cw20.
    let info = message_info(&a.alice, &[]);
    let err = execute(deps.as_mut(), env, info, ExecuteMsg::Receive(rcv)).unwrap_err();
    assert!(matches!(err, ContractError::NotACw20Contract(_)), "{err:?}");
}

#[test]
fn validate_rejects_saturating_linear_backdated_start() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let start = env.block.time.minus_seconds(1);
    let end = env.block.time.plus_seconds(1000);
    let info = message_info(&a.alice, &coins(100, DENOM));
    let err = execute(
        deps.as_mut(),
        env,
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(100),
            schedule: Schedule::SaturatingLinear { start_at: start, end_at: end },
            title: None,
            description: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidSchedule(_)), "{err:?}");
}

#[test]
fn validate_rejects_piecewise_nonzero_first_step() {
    let (mut deps, a) = setup(None);
    let env = mock_env();
    let info = message_info(&a.alice, &coins(1000, DENOM));
    let err = execute(
        deps.as_mut(),
        env.clone(),
        info,
        ExecuteMsg::Lock {
            denom: UncheckedDenom::Native(DENOM.into()),
            amount: Uint128::new(1000),
            schedule: Schedule::PiecewiseLinear {
                steps: vec![
                    (env.block.time.plus_seconds(100), Uint128::new(500)),
                    (env.block.time.plus_seconds(1000), Uint128::new(1000)),
                ],
            },
            title: None,
            description: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidSchedule(_)), "{err:?}");
}
