# Token Locker — standalone React UI

A self-contained Vite + React + TypeScript frontend for the
[Choice Token Locker](../README.md) contract. It is **deliberately separate**
from `choice_exchange_app/`: the goal is to iterate quickly on the locker UX
in isolation, then graft the polished components into the exchange app.

## Quick start

```bash
nvm use            # picks up .nvmrc → node 24
yarn install
cp .env.example .env
# (.env already has the deployed testnet address; edit if needed)
yarn dev           # http://localhost:5180
```

Build:

```bash
yarn build         # tsc -b && vite build → dist/
yarn preview       # serve dist/ locally
```

## Configuration

```env
VITE_SELECTED_NETWORK=testnet                                  # initial network; UI also has a switcher
VITE_LOCKER_ADDRESS_TESTNET=inj1rny5qu2hpu76j3uzjlcqe9l8xgm64qzajj8m37
VITE_LOCKER_ADDRESS_MAINNET=
```

Both env defaults are overridable at runtime from the contract bar in the
header — handy when pointing the same dev server at a fresh deployment
without restarting.

## Feature surface

Mirrors `contracts/locker/src/msg.rs` 1:1:

| Tab          | Coverage                                                                              |
| ------------ | ------------------------------------------------------------------------------------- |
| Create lock  | `Lock` (native) + cw20 `Send` hook; Cliff, SaturatingLinear, Piecewise schedules     |
| My locks     | `LocksByOwner` and `LocksByCreator`; per-lock `Withdraw` / `TopUp` / `Extend` / `TransferOwner` |
| Explore      | `AllLocks` and `LocksByDenom` with paginated `start_after` cursors                   |
| Admin        | `Config` read + `UpdateConfig` with tri-state (leave / set / clear) on each field    |

All list views fetch in two RPCs (`LocksBy*` + `ClaimableMany`) regardless of
page size, matching the contract docstring's "1 page = 2 queries" pattern.

The schedule progress bar uses the same `claimable_at` math as the contract
(`src/utils/schedule.ts`), driven by a 1Hz `useNow()` tick so unlocking is
visible without a chain round-trip.

## Architecture

```
src/
├── types/locker.ts         hand-written TS bindings (mirrors msg.rs)
├── chain/
│   ├── clients.ts          ChainGrpcWasmApi + smartQuery<T>
│   └── locker.ts           Typed query helpers + MsgExecuteContractCompat builders
├── wallet/
│   ├── walletStrategy.ts   WalletStrategy + MsgBroadcaster wiring
│   └── useWallet.ts        Zustand store (network, address, locker override)
├── hooks/
│   ├── useAsync.ts         tiny abort-aware data hook (no react-query dep)
│   ├── useLocker.ts        useConfig / useStats / useLocks*Owner|Creator|Denom / useClaimableMany
│   └── useNow.ts           1Hz wall-clock tick for live claimable
├── utils/
│   ├── time.ts             ns ↔ Date helpers (cosmwasm Timestamps are u64 nanos as string)
│   ├── amount.ts           Decimal-based base-unit conversion
│   └── schedule.ts         port of contracts/locker/src/schedule.rs claimable_at
├── components/             Header, WalletButton, ContractAddressBar, LockCard,
│                           ScheduleProgress, ScheduleBuilder, AmountInput
└── tabs/                   CreateLockTab, MyLocksTab, ExploreTab, AdminTab
```

The wallet wiring closely mirrors `choice_exchange_app/src/utils/walletStrategy.tsx`
so the components can lift cleanly across when this graduates.

## Integration notes (for the future cross-merge)

- **Schedule builder** is reusable as-is; it returns a validated `Schedule`
  union via the `onChange` prop.
- **`ChainGrpcWasmApi` is cached per-network** in `chain/clients.ts`. When
  merged into the exchange app, that cache should be unified with
  `InjectiveAPI.tsx`'s existing instance.
- **No top-level react-query / Apollo** — the locker has only ~8 queries and
  every result is invalidated by a single `onMutated` callback, so a hand-rolled
  `useAsync` was lighter than a new dep. In the exchange app the same patterns
  belong inside the existing Apollo cache scheme.
- **`MsgBroadcaster` simulateTx is on** — same default as the exchange app —
  so the chain rejects malformed messages before they consume gas. If you want
  to skip simulation for one-off pre-signed flows, pass `simulateTx: false`
  in `wallet/walletStrategy.ts:broadcast`.

## Caveats

- Bundle weighs ~2.3 MB (one chunk) because `WalletStrategy` ships every
  wallet adapter — Trezor, WalletConnect, EVM, etc. — even though only Keplr
  and Leap are surfaced. Code-splitting can be added before integration.
- `Buffer` is exposed on `window` in `main.tsx` for sdk-ts internals; the
  exchange app does the same via `vite-plugin-node-polyfills`.
- Token-factory subdenom decimals are not auto-detected — the create-lock form
  asks for a manual decimals selector. For a polished integration, hook this
  up to `ChainGrpcBankApi.fetchDenomsMetadata`.
