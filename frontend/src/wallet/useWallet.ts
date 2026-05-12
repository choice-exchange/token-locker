import { create } from "zustand";
import { persist } from "zustand/middleware";
import { INITIAL_NETWORK, NETWORKS } from "../constants";
import type { NetworkKey } from "../constants";
import type { SupportedWallet } from "./walletStrategy";

interface WalletState {
    network: NetworkKey;
    setNetwork: (n: NetworkKey) => void;

    address: string | null;
    setAddress: (a: string | null) => void;

    wallet: SupportedWallet | null;
    setWallet: (w: SupportedWallet | null) => void;

    lockerOverride: string;
    setLockerOverride: (s: string) => void;
}

export const useWallet = create<WalletState>()(
    persist(
        (set) => ({
            network: INITIAL_NETWORK,
            // Switching network drops the connected address — chain-IDs differ.
            setNetwork: (n) => set({ network: n, address: null, wallet: null }),

            address: null,
            setAddress: (a) => set({ address: a }),

            wallet: null,
            setWallet: (w) => set({ wallet: w }),

            lockerOverride: "",
            setLockerOverride: (s) => set({ lockerOverride: s.trim() }),
        }),
        {
            name: "tl.wallet",
            partialize: (s) => ({
                network: s.network,
                lockerOverride: s.lockerOverride,
            }),
        },
    ),
);

/** Reactive helper: locker contract for the active network (override > env). */
export function useLockerAddress(): string {
    const network = useWallet((s) => s.network);
    const override = useWallet((s) => s.lockerOverride);
    return override || NETWORKS[network].lockerAddress;
}
