# Choice Token Locker

A permissionless, multi-tenant token locker for Injective. Anyone can deposit
**cw20 tokens** or **native denoms** (including token-factory subdenoms), declare
an unlock schedule, and later withdraw at maturity. One deployed contract serves
unlimited users — every lock is identified by a unique `id`.

Use cases:
- **LP locks** — credibly burn liquidity until a future date
- **Team / treasury vesting** — public, on-chain proof of allocation schedules
- **OTC escrow** — lock tokens, transfer ownership to the buyer

This contract is intentionally **not** a vesting payment scheduler like
[dao-dao's cw-vesting][cw-vesting] — there's one deployed instance, not one per
recipient, and there is **no admin clawback** of locked funds.

[cw-vesting]: https://github.com/DA0-DA0/dao-contracts/tree/development/contracts/external/cw-vesting

---

## Tech Stack

- **CosmWasm 3.0.5** (cw-std 3.0.5, cw-storage-plus 3.0.1, cw-utils 3.0.0, cw2 3.0.0)
- **Rust 1.88** for local development; **nightly + build-std** for wasm artifacts
  (needed to strip bulk-memory ops that Injective's cosmwasm-vm rejects — see
  [`build_release.sh`](build_release.sh))
- No cw20 crate dep — the two messages we use (`Cw20ReceiveMsg`, `Cw20ExecuteMsg::Transfer`)
  are vendored as [`cw20.rs`](contracts/locker/src/cw20.rs) since upstream `cw20 = "2.0"`
  still pins cw-std to 2.x

---

## Quick Start

```bash
# Dev build + unit tests (12 tests)
cargo build && cargo test --lib

# Build VM-compatible wasm artifact (requires nightly + rust-src)
rustup toolchain install nightly --component rust-src
./build_release.sh
# → artifacts/choice_token_locker.wasm  + checksums.txt

# Integration tests against in-process Injective chain (5 tests, ~3 min cold)
cargo test --test integration

# Generate JSON schemas for frontend TypeScript bindings
cargo run --bin schema -p choice-token-locker
# → schema/*.json
```

---

## Architecture

### State

```rust
struct Config {
    admin: Option<Addr>,           // can update Config; CANNOT touch any Lock
    fee_collector: Option<Addr>,   // receives creation_fee on native locks
    creation_fee: Option<Coin>,    // optional flat fee (native denom only)
}

struct Lock {
    id: u64,
    owner: Addr,                   // recipient at unlock (transferable)
    creator: Addr,                 // immutable provenance
    denom: CheckedDenom,           // Native(String) | Cw20(Addr)
    total: Uint128,                // deposit total (grows on top-up)
    withdrawn: Uint128,            // running total withdrawn
    schedule: Schedule,
    title: Option<String>,
    description: Option<String>,
    created_at: Timestamp,
}
```

**Maps:**
- `LOCKS: Map<u64, Lock>` — primary store
- `LOCKS_BY_OWNER: Map<(&Addr, u64), ()>` — "my locks" pagination
- `LOCKS_BY_DENOM: Map<(&str, u64), ()>` — "all locks of token X" (denom key
  is `native:<d>` or `cw20:<addr>`)

`LOCK_COUNT: Item<u64>` is a monotonic nonce — lock IDs start at 1.

### Schedule types

Three claimable curves are supported:

```rust
enum Schedule {
    /// All-or-nothing at unlock_at. Top-up and Extend ARE allowed
    /// (only while the lock is still locked — both reject once unlock_at has passed).
    Cliff { unlock_at: Timestamp },

    /// Linear vest from start_at to end_at. Top-up and Extend are REJECTED.
    SaturatingLinear { start_at: Timestamp, end_at: Timestamp },

    /// Piecewise-linear: a sorted list of (time, cumulative-claimable) breakpoints.
    /// Final amount must equal lock total. Top-up and Extend REJECTED.
    /// Capped at 50 steps to bound storage and pagination gas.
    PiecewiseLinear { steps: Vec<(Timestamp, Uint128)> },
}
```

`claimable_at(t, total)` semantics:

| Schedule          | t < start | start ≤ t < end                                  | t ≥ end   |
| ----------------- | --------- | ------------------------------------------------ | --------- |
| Cliff             | 0         | —                                                | total     |
| SaturatingLinear  | 0         | `total * (t - start) / (end - start)`            | total     |
| PiecewiseLinear   | 0         | linear interpolation between adjacent breakpoints | total     |

Math is done in `Uint256` internally to avoid overflow; the final value fits in
`Uint128` because `total` does. See [`schedule.rs`](contracts/locker/src/schedule.rs)
for the implementation and unit tests.

### Why top-up / extend are cliff-only

Top-up on a vesting curve is semantically ambiguous: should the new funds
back-vest, or vest going forward? Both answers surprise users. Rather than pick,
v1 simply rejects top-up and extend on `SaturatingLinear` and `PiecewiseLinear`.
If you need to "add more" to a vesting lock, create a second lock.

---

## Messages

### Instantiate

```jsonc
{
  "admin": "inj1...",            // optional, defaults to msg.sender
  "fee_collector": "inj1...",    // optional
  "creation_fee": {              // optional; native only
    "denom": "inj",
    "amount": "1000000000000000000"
  }
}
```

### Execute

| Variant            | Purpose                                                          | Auth          |
| ------------------ | ---------------------------------------------------------------- | ------------- |
| `Lock`             | Create a new lock funded by attached native funds                | anyone        |
| `Receive`          | cw20 entry point (called by the cw20 contract)                   | cw20 contract |
| `TopUp`            | Add to an existing **cliff** lock (rejects once `unlock_at` past) | anyone       |
| `Extend`           | Move a **cliff** lock's `unlock_at` forward (lock must still be locked) | lock.owner |
| `TransferOwner`    | Hand ownership to another address (not self, not the locker)     | lock.owner    |
| `Withdraw`         | Claim up to the currently claimable amount                       | lock.owner    |
| `UpdateConfig`     | Change admin / fee_collector / creation_fee                      | config.admin  |

#### Creating a native lock

```jsonc
{
  "lock": {
    "denom": { "native": "inj" },
    "amount": "500",
    "schedule": { "cliff": { "unlock_at": "1735689600" } },
    "title": "LP lock — INJ/USDT",
    "description": null
  }
}
```

Attach exactly `amount` of the native denom in `funds` (plus the
`creation_fee` if one is configured — both go in the same `Coin[]`).

#### Creating a cw20 lock

cw20 deposits **must** come via the cw20 contract's `Send` hook. Construct the
inner hook payload (base64-encoded `Cw20HookMsg`) and call the cw20:

```jsonc
// Sent to the cw20 contract (not the locker):
{
  "send": {
    "contract": "<locker addr>",
    "amount": "1000000",
    "msg": "<base64 of Cw20HookMsg::Lock { schedule, title, description }>"
  }
}
```

The locker's `Receive` handler treats the cw20 contract address as the lock's
denom, the `rcv.sender` as the new lock owner, and `rcv.amount` as the deposit.

#### Withdrawing

```jsonc
{
  "withdraw": { "id": 1, "amount": null }    // null = withdraw the full claimable
}
```

`amount == None` claims everything currently available. Pre-unlock returns
`StillLocked`. Post-unlock partial withdraws are supported on all schedule types.

### Query

| Variant           | Returns                                                  |
| ----------------- | -------------------------------------------------------- |
| `Config`          | `Config`                                                 |
| `Stats`           | `StatsResponse { total_locks }` — monotonic counter, IDs run `1..=total_locks` |
| `Lock { id }`     | `LockResponse { lock }`                                  |
| `LocksByOwner`    | `LocksResponse { locks }` (paginated, current owner)     |
| `LocksByCreator`  | `LocksResponse { locks }` (paginated, survives `TransferOwner`) |
| `LocksByDenom`    | `LocksResponse { locks }` (paginated, by canonical denom key) |
| `AllLocks`        | `LocksResponse { locks }` (paginated)                    |
| `Claimable`       | `ClaimableResponse { claimable, withdrawn, remaining }`  |
| `ClaimableMany`   | `ClaimableManyResponse { entries }` — batch of up to 100 IDs, unknown IDs return `response: None` |

#### Pagination

All `LocksBy*` / `AllLocks` queries accept:

```rust
{
  start_after: Option<u64>,   // exclusive bound on lock-id; None = first page
  limit: Option<u32>,         // default 30, max 100
  order: Option<SortOrder>,   // "asc" (default) or "desc"
}
```

- With `asc` (default), `start_after` is the **largest id** seen on the previous page.
- With `desc`, `start_after` is the **smallest id** seen on the previous page.
- `LocksByCreator` is provenance-stable: lock IDs persist there regardless of
  later `TransferOwner` calls — handy for sellers auditing OTC issuance.

For `LocksByDenom`, pass the canonical denom key from
[`CheckedDenom::key()`](contracts/locker/src/denom.rs):
`native:<denom>` or `cw20:<address>`.

#### Batched claimable

`ClaimableMany { ids, at }` returns one `ClaimableManyEntry` per requested id:

```jsonc
{
  "entries": [
    { "id": 1, "response": { "claimable": "100", "withdrawn": "0", "remaining": "100" } },
    { "id": 99, "response": null }   // id not found — not an error
  ]
}
```

Frontends listing N locks should fetch the page (1 query) and then call
`ClaimableMany` with the IDs from that page (1 query) — total 2 RPCs instead
of N+1.

---

## Security Model & Invariants

The contract enforces these properties — each has a corresponding test:

1. **Admin cannot move funds.** `admin` can update `Config` but the `Lock` map
   is admin-immutable. Even `UpdateConfig` cannot alter an existing lock's
   `owner`, `total`, `withdrawn`, `schedule`, or `denom`.
2. **No early exit.** `Withdraw` rejects if `block.time < schedule.unlock_at`.
   No code path (admin, creator, owner) can bypass this.
3. **Extend is forward-only AND lock-still-locked-only.** `new_unlock_at >
   current.unlock_at` strictly, AND `current.unlock_at > block.time`. Once a
   cliff has unlocked, it cannot be re-armed.
4. **Native deposits are exact.** `info.funds` must contain exactly one `Coin`
   matching the declared denom; the amount must equal `lock.amount` (plus
   `creation_fee` if configured). Multi-denom attachments rejected.
5. **cw20 amounts are trusted from `Cw20ReceiveMsg`,** never from inner JSON.
6. **Top-up cw20 must match the lock's cw20.** A lock for token A cannot be
   topped up with token B.
7. **Top-up rejects post-unlock.** Misdirected funds revert instead of
   silently flowing to the current lock owner.
8. **TransferOwner rejects self-transfer and contract-address target.**
   Prevents wasted gas and permanently-stranded locks.
9. **Owner-only mutations** (`Extend`, `TransferOwner`, `Withdraw`)
   check `lock.owner == info.sender`. `TopUp` is permissionless by design
   (analogous to anyone funding a public escrow).
10. **Fee config invariants enforced** at `Instantiate` and `UpdateConfig`:
    `creation_fee => fee_collector`, `creation_fee.amount > 0`, and
    `!creation_fee.denom.is_empty()`. Prevents stuck fees and a bricked
    `Lock` entry point.
11. **`PiecewiseLinear.steps` is capped at 50** to bound per-lock storage
    and pagination gas.

### Operational caveats (read before mainnet deploy)

- **Wasm-admin = migration key = effective superuser.** The contract's
  `Config.admin` only gates `UpdateConfig`; it CANNOT migrate the code. The
  chain-level wasm admin (set on `MsgInstantiateContract.admin`) can
  `MsgMigrateContract` to any other code — including a malicious one that
  drains every lock. Mainnet deployments should set the wasm admin to a
  **multisig or timelock**, or instantiate with `admin: None` for an
  immutable contract (forfeits the ability to patch bugs later).
- **Token-factory tokens with mutable admin.** If a token-factory subdenom's
  metadata admin can freeze/burn balances, the locker cannot prevent that —
  locked tokens may become unwithdrawable. Treat deposit acceptance as a
  per-token trust decision.
- **TopUp is permissionless.** Anyone may top up any cliff lock (while still
  locked). Typoing a lock ID irreversibly funds someone else's lock.

### Out of scope (intentional)

- **Staking the locked tokens.** Slashing risk on locked supply is undesirable;
  most LP tokens aren't stakeable anyway.
- **Multi-denom locks.** One denom per lock simplifies accounting and UI.
- **Lock splitting.** Convenient but ~30% more test surface and rarely used;
  use `TransferOwner` for the common case (selling a whole lock).
- **NFT wrapping.** A good v2 — would make locks tradeable on cw721 marketplaces.

---

## Fees

The optional `creation_fee` (native denom only) is deducted from `info.funds`
on `Lock { … }` calls and forwarded to `fee_collector` in the same tx. If no
`fee_collector` is set, the fee stays in the contract.

**cw20 locks are not charged a fee** in v1 — charging a native fee on a cw20
deposit would require a second message and complicate the UX. If both `admin`
and `fee_collector` agree, fees can be re-enabled for cw20 in a migration.

---

## Build

### Dev build (host)

```bash
cargo build              # debug
cargo build --release    # release
```

### Wasm artifact (deployable)

```bash
./build_release.sh
# → artifacts/choice_token_locker.wasm
# → artifacts/checksums.txt
```

The script invokes `cargo +nightly build` with `-Z build-std`,
`target-cpu=mvp`, and `target-feature=-bulk-memory,-multivalue,-reference-types,-sign-ext`.
This is the only setup that produces wasm Injective's chain will accept while
also satisfying cw-std 3.x's transitive dep requirements (which force rustc
≥ 1.85, at which point precompiled `std` contains bulk-memory ops that
Injective's cosmwasm-vm rejects). Standard docker workspace-optimizer images
(0.16, 0.17) cannot strip these ops.

### Schema generation

```bash
cargo run --bin schema -p choice-token-locker
# → schema/choice-token-locker.json   (full API)
# → schema/raw/*.json                  (per-message JSON Schemas)
```

The standalone learning UI at [`frontend/`](frontend/) consumes these — its
[`src/types/locker.ts`](frontend/src/types/locker.ts) is a hand-written 1:1
mirror of the schema. Once that UI is graduated, the long-term home is
`choice_exchange_app/` reusing the same bindings.

---

## Testing

### Unit tests (12, fast)

Pure-Rust tests against `mock_dependencies()`:

```bash
cargo test --lib
```

Covers schedule math (cliff/linear/piecewise), full lock lifecycles, error
paths, and config invariants.

### Integration tests (5, ~3 min cold)

Run against an in-process Injective chain via `injective-test-tube`:

```bash
cargo test --test integration
```

Scenarios:
1. **`native_cliff_lock_full_lifecycle`** — deposit, pre-unlock-reject, warp, withdraw
2. **`cw20_lock_via_send_hook_and_withdraw`** — full cw20 round-trip via `Send` hook
3. **`topup_then_withdraw_sums`** — top-up accumulates correctly
4. **`transfer_owner_lets_new_owner_withdraw`** — ownership move + auth checks
5. **`creation_fee_charged_and_forwarded`** — fee deducted + sent to fee_collector

The cw20-base wasm is reused from
[`aggregation_contract/cw20_base/cw20_base.wasm`](../aggregation_contract/cw20_base/cw20_base.wasm).
Refresh the locker artifact before running integration tests:

```bash
./build_release.sh
cargo test --test integration
```

---

## Repository Layout

```
token-locker/
├── Cargo.toml              workspace + dep versions
├── rust-toolchain.toml     pinned to 1.88.0 for host builds
├── .cargo/config.toml      target-feature overrides (informational; build_release.sh re-applies)
├── build_release.sh        nightly + build-std wasm artifact build
├── artifacts/              wasm + checksum (generated)
├── cw20_base/              cw20-base wasm for integration tests
├── schema/                 JSON schemas (generated)
├── tests/integration.rs    injective-test-tube scenarios
├── frontend/               standalone React + TS UI (Vite); see frontend/README.md
└── contracts/locker/
    ├── Cargo.toml
    └── src/
        ├── lib.rs
        ├── contract.rs     instantiate / execute / query / migrate
        ├── msg.rs          InstantiateMsg, ExecuteMsg, QueryMsg, Cw20HookMsg, responses
        ├── state.rs        Config, Lock, storage maps
        ├── schedule.rs     Schedule enum + claimable_at()
        ├── denom.rs        UncheckedDenom / CheckedDenom + transfer_msg
        ├── cw20.rs         vendored Cw20ReceiveMsg / Cw20ExecuteMsg::Transfer
        ├── error.rs        ContractError
        ├── bin/schema.rs   schema generator (cfg-gated off for wasm32)
        └── tests.rs        unit tests
```

---

## Roadmap

- **v1 (current):** cliff + vesting schedules, top-up + extend on cliff,
  transferable owner, partial withdraws, optional creation fee.
- **v2 (post-deploy):** cw721 wrap (lock-as-NFT, tradeable on marketplaces),
  optional cw20 creation fee path.
- **Frontend (current):** standalone React + TS UI at [`frontend/`](frontend/)
  covering Create / My Locks / Explore / Admin against the generated schema.
  Designed to graduate into `choice_exchange_app/` once the UX is settled.
