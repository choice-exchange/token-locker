import { Network } from "@injectivelabs/networks";
import { ChainId } from "@injectivelabs/ts-types";

export type NetworkKey = "testnet" | "mainnet";

export interface NetworkConfig {
    key: NetworkKey;
    label: string;
    chainId: ChainId;
    networkEnum: Network;
    explorerUrl: string;
    lockerAddress: string;
}

const envInitial = (import.meta.env.VITE_SELECTED_NETWORK as NetworkKey) || "testnet";
const envTestnetLocker = (import.meta.env.VITE_LOCKER_ADDRESS_TESTNET as string) || "";
const envMainnetLocker = (import.meta.env.VITE_LOCKER_ADDRESS_MAINNET as string) || "";

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
    testnet: {
        key: "testnet",
        label: "Testnet",
        chainId: ChainId.Testnet,
        networkEnum: Network.Testnet,
        explorerUrl: "https://testnet.explorer.injective.network",
        lockerAddress: envTestnetLocker,
    },
    mainnet: {
        key: "mainnet",
        label: "Mainnet",
        chainId: ChainId.Mainnet,
        networkEnum: Network.Mainnet,
        explorerUrl: "https://injscan.com",
        lockerAddress: envMainnetLocker,
    },
};

export const INITIAL_NETWORK: NetworkKey = NETWORKS[envInitial] ? envInitial : "testnet";
