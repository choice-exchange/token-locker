#![cfg(test)]

//! Integration tests for choice-token-locker.
//!
//! Runs against an in-process Injective chain via `injective-test-tube`.
//! Requires pre-built wasm artifacts at `artifacts/choice_token_locker.wasm`
//! and `cw20_base/cw20_base.wasm` (refresh with `make_artifacts.sh`).
//!
//! cw20 messages are built as raw JSON to avoid pulling in the cw20 crate
//! (which still pins cosmwasm-std 2.x and would conflict with our cw-std 3.x).

use cosmwasm_std::{to_json_binary, Coin, Timestamp, Uint128};

use choice_token_locker::cw20::Cw20ReceiveMsg as VendoredCw20ReceiveMsg;
use choice_token_locker::denom::UncheckedDenom;
use choice_token_locker::msg::{
    ClaimableResponse, Cw20HookMsg, ExecuteMsg, InstantiateMsg, LockResponse, QueryMsg,
};
use choice_token_locker::schedule::Schedule;

use injective_test_tube::injective_std::types::cosmos::bank::v1beta1::QueryBalanceRequest;
use injective_test_tube::{Account, Bank, InjectiveTestApp, Module, SigningAccount, Wasm};

const LOCKER_WASM: &[u8] = include_bytes!("../artifacts/choice_token_locker.wasm");
const CW20_WASM: &[u8] = include_bytes!("../cw20_base/cw20_base.wasm");

const DENOM: &str = "inj";

// ─── helpers ─────────────────────────────────────────────────────────────────

struct Env {
    app: InjectiveTestApp,
    admin: SigningAccount,
    alice: SigningAccount,
    bob: SigningAccount,
    fee_coll: SigningAccount,
    locker: String,
}

fn user_funds() -> Vec<Coin> {
    vec![Coin::new(1_000_000_000_000_000_000_000_000u128, DENOM)]
}

fn setup(creation_fee: Option<Coin>) -> Env {
    let app = InjectiveTestApp::new();
    let admin = app.init_account(&user_funds()).unwrap();
    let alice = app.init_account(&user_funds()).unwrap();
    let bob = app.init_account(&user_funds()).unwrap();
    let fee_coll = app.init_account(&[]).unwrap();

    let wasm = Wasm::new(&app);
    let code_id = wasm.store_code(LOCKER_WASM, None, &admin).unwrap().data.code_id;
    let locker = wasm
        .instantiate(
            code_id,
            &InstantiateMsg {
                admin: Some(admin.address()),
                fee_collector: Some(fee_coll.address()),
                creation_fee,
            },
            Some(&admin.address()),
            Some("choice-token-locker"),
            &[],
            &admin,
        )
        .unwrap()
        .data
        .address;

    Env { app, admin, alice, bob, fee_coll, locker }
}

fn block_time_plus(env: &Env, secs: i64) -> Timestamp {
    let now = env.app.get_block_time_seconds();
    Timestamp::from_seconds((now + secs) as u64)
}

fn warp(env: &Env, secs: u64) {
    env.app.increase_time(secs);
}

fn bank_balance(env: &Env, addr: &str, denom: &str) -> u128 {
    let bank = Bank::new(&env.app);
    let resp = bank
        .query_balance(&QueryBalanceRequest {
            address: addr.to_string(),
            denom: denom.to_string(),
        })
        .unwrap();
    resp.balance
        .map(|c| c.amount.parse::<u128>().unwrap())
        .unwrap_or(0)
}

fn instantiate_cw20(env: &Env, name: &str, initial_holder: &str, initial_amount: u128) -> String {
    let wasm = Wasm::new(&env.app);
    let code_id = wasm
        .store_code(CW20_WASM, None, &env.admin)
        .unwrap()
        .data
        .code_id;
    let init = serde_json::json!({
        "name": name,
        "symbol": "TST",
        "decimals": 6u8,
        "initial_balances": [{"address": initial_holder, "amount": initial_amount.to_string()}],
        "mint": null,
        "marketing": null
    });
    wasm.instantiate(
        code_id,
        &init,
        Some(&env.admin.address()),
        Some("cw20-base"),
        &[],
        &env.admin,
    )
    .unwrap()
    .data
    .address
}

fn cw20_send(env: &Env, cw20: &str, signer: &SigningAccount, contract: &str, amount: u128, hook: &Cw20HookMsg) {
    let msg = serde_json::json!({
        "send": {
            "contract": contract,
            "amount": amount.to_string(),
            "msg": to_json_binary(hook).unwrap(),
        }
    });
    Wasm::new(&env.app)
        .execute::<serde_json::Value>(cw20, &msg, &[], signer)
        .unwrap();
}

fn cw20_balance(env: &Env, cw20: &str, holder: &str) -> u128 {
    let q = serde_json::json!({"balance": {"address": holder}});
    let resp: serde_json::Value = Wasm::new(&env.app).query(cw20, &q).unwrap();
    resp["balance"].as_str().unwrap().parse().unwrap()
}

fn lock_native(
    env: &Env,
    signer: &SigningAccount,
    amount: u128,
    schedule: Schedule,
    funds: Vec<Coin>,
) {
    Wasm::new(&env.app)
        .execute::<ExecuteMsg>(
            &env.locker,
            &ExecuteMsg::Lock {
                denom: UncheckedDenom::Native(DENOM.into()),
                amount: Uint128::new(amount),
                schedule,
                title: None,
                description: None,
            },
            &funds,
            signer,
        )
        .unwrap();
}

fn query_lock(env: &Env, id: u64) -> LockResponse {
    Wasm::new(&env.app)
        .query(&env.locker, &QueryMsg::Lock { id })
        .unwrap()
}

fn query_claimable(env: &Env, id: u64) -> ClaimableResponse {
    Wasm::new(&env.app)
        .query(&env.locker, &QueryMsg::Claimable { id, at: None })
        .unwrap()
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[test]
fn native_cliff_lock_full_lifecycle() {
    let env = setup(None);
    let unlock_at = block_time_plus(&env, 1000);

    let alice_before = bank_balance(&env, &env.alice.address(), DENOM);
    lock_native(
        &env,
        &env.alice,
        500,
        Schedule::Cliff { unlock_at },
        vec![Coin::new(500u128, DENOM)],
    );

    let lock = query_lock(&env, 1).lock;
    assert_eq!(lock.total, Uint128::new(500));
    assert_eq!(lock.owner.as_str(), env.alice.address());

    // pre-unlock withdraw is rejected
    let err = Wasm::new(&env.app)
        .execute::<ExecuteMsg>(
            &env.locker,
            &ExecuteMsg::Withdraw { id: 1, amount: None },
            &[],
            &env.alice,
        )
        .unwrap_err();
    assert!(err.to_string().contains("not yet unlocked"), "{err}");

    warp(&env, 1500);

    Wasm::new(&env.app)
        .execute::<ExecuteMsg>(
            &env.locker,
            &ExecuteMsg::Withdraw { id: 1, amount: None },
            &[],
            &env.alice,
        )
        .unwrap();

    let alice_after = bank_balance(&env, &env.alice.address(), DENOM);
    let diff = alice_before as i128 - alice_after as i128;
    // alice paid 500 net (deposit - return = 0) plus gas; assert net change is small.
    assert!(diff.abs() < 1_000_000_000_000_000_000, "unexpected net delta {diff}");
    let claim = query_claimable(&env, 1);
    assert_eq!(claim.withdrawn, Uint128::new(500));
    assert_eq!(claim.claimable, Uint128::zero());
}

#[test]
fn cw20_lock_via_send_hook_and_withdraw() {
    let env = setup(None);
    let cw20 = instantiate_cw20(&env, "Lockable", &env.alice.address(), 1_000_000);
    let unlock_at = block_time_plus(&env, 1000);

    // alice sends 700 to the locker with a Lock hook
    cw20_send(
        &env,
        &cw20,
        &env.alice,
        &env.locker,
        700,
        &Cw20HookMsg::Lock {
            schedule: Schedule::Cliff { unlock_at },
            title: Some("LP lock".into()),
            description: None,
        },
    );

    assert_eq!(cw20_balance(&env, &cw20, &env.alice.address()), 1_000_000 - 700);
    assert_eq!(cw20_balance(&env, &cw20, &env.locker), 700);

    // pre-unlock fails
    let err = Wasm::new(&env.app)
        .execute::<ExecuteMsg>(
            &env.locker,
            &ExecuteMsg::Withdraw { id: 1, amount: None },
            &[],
            &env.alice,
        )
        .unwrap_err();
    assert!(err.to_string().contains("not yet unlocked"), "{err}");

    warp(&env, 1500);

    Wasm::new(&env.app)
        .execute::<ExecuteMsg>(
            &env.locker,
            &ExecuteMsg::Withdraw { id: 1, amount: None },
            &[],
            &env.alice,
        )
        .unwrap();

    assert_eq!(cw20_balance(&env, &cw20, &env.alice.address()), 1_000_000);
    assert_eq!(cw20_balance(&env, &cw20, &env.locker), 0);
}

#[test]
fn topup_then_withdraw_sums() {
    let env = setup(None);
    let unlock_at = block_time_plus(&env, 1000);

    lock_native(
        &env,
        &env.alice,
        300,
        Schedule::Cliff { unlock_at },
        vec![Coin::new(300u128, DENOM)],
    );

    Wasm::new(&env.app)
        .execute::<ExecuteMsg>(
            &env.locker,
            &ExecuteMsg::TopUp { id: 1, amount: Uint128::new(200) },
            &[Coin::new(200u128, DENOM)],
            &env.alice,
        )
        .unwrap();

    let lock = query_lock(&env, 1).lock;
    assert_eq!(lock.total, Uint128::new(500));

    warp(&env, 1500);
    Wasm::new(&env.app)
        .execute::<ExecuteMsg>(
            &env.locker,
            &ExecuteMsg::Withdraw { id: 1, amount: None },
            &[],
            &env.alice,
        )
        .unwrap();
    let claim = query_claimable(&env, 1);
    assert_eq!(claim.withdrawn, Uint128::new(500));
}

#[test]
fn transfer_owner_lets_new_owner_withdraw() {
    let env = setup(None);
    let unlock_at = block_time_plus(&env, 500);

    lock_native(
        &env,
        &env.alice,
        100,
        Schedule::Cliff { unlock_at },
        vec![Coin::new(100u128, DENOM)],
    );

    Wasm::new(&env.app)
        .execute::<ExecuteMsg>(
            &env.locker,
            &ExecuteMsg::TransferOwner {
                id: 1,
                new_owner: env.bob.address(),
            },
            &[],
            &env.alice,
        )
        .unwrap();

    warp(&env, 1000);

    // alice (former owner) is now rejected
    let err = Wasm::new(&env.app)
        .execute::<ExecuteMsg>(
            &env.locker,
            &ExecuteMsg::Withdraw { id: 1, amount: None },
            &[],
            &env.alice,
        )
        .unwrap_err();
    assert!(err.to_string().contains("unauthorized"), "{err}");

    Wasm::new(&env.app)
        .execute::<ExecuteMsg>(
            &env.locker,
            &ExecuteMsg::Withdraw { id: 1, amount: None },
            &[],
            &env.bob,
        )
        .unwrap();
    // verify via lock state (bank-balance check is noisy due to gas)
    let lock = query_lock(&env, 1).lock;
    assert_eq!(lock.owner.as_str(), env.bob.address());
    assert_eq!(lock.withdrawn, Uint128::new(100));
}

#[test]
fn creation_fee_charged_and_forwarded() {
    let fee = Coin::new(10u128, DENOM);
    let env = setup(Some(fee.clone()));
    let unlock_at = block_time_plus(&env, 1000);

    let collector_before = bank_balance(&env, &env.fee_coll.address(), DENOM);

    // attach 10 fee + 100 lock = 110
    lock_native(
        &env,
        &env.alice,
        100,
        Schedule::Cliff { unlock_at },
        vec![Coin::new(110u128, DENOM)],
    );

    let collector_after = bank_balance(&env, &env.fee_coll.address(), DENOM);
    assert_eq!(collector_after - collector_before, 10);

    // and the lock balance should be 100, not 110
    let lock = query_lock(&env, 1).lock;
    assert_eq!(lock.total, Uint128::new(100));
}

// Silence unused-field warnings on the Env struct fields we keep for readability
// but don't reference in every test.
#[allow(dead_code)]
fn _touch(env: &Env) {
    let _ = &env.admin;
    let _ = &env.bob;
    let _ = &env.fee_coll;
}

// Surface the vendored receive message type so the symbol is exercised
// somewhere in this crate's test build (otherwise it lives only inside execute()).
#[allow(dead_code)]
fn _vendored_receive_type(_: VendoredCw20ReceiveMsg) {}
