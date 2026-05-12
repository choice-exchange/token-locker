import { WalletStrategy } from "@injectivelabs/wallet-strategy";
import { MsgBroadcaster } from "@injectivelabs/wallet-core";
import { getNetworkEndpoints } from "@injectivelabs/networks";
import { Wallet } from "@injectivelabs/wallet-base";
import { Web3Exception } from "@injectivelabs/exceptions";
import { Network } from "@injectivelabs/networks";
import type { Msgs } from "@injectivelabs/sdk-ts";
import type { NetworkKey } from "../constants";
import { NETWORKS } from "../constants";

let strategy: WalletStrategy | null = null;
let strategyNetwork: NetworkKey | null = null;

export function getWalletStrategy(network: NetworkKey): WalletStrategy {
    if (!strategy || strategyNetwork !== network) {
        strategy = new WalletStrategy({
            chainId: NETWORKS[network].chainId,
            strategies: {},
        });
        strategyNetwork = network;
    }
    return strategy;
}

export type SupportedWallet = typeof Wallet.Keplr | typeof Wallet.Leap;

export async function selectAndConnect(
    network: NetworkKey,
    wallet: SupportedWallet,
): Promise<string> {
    const s = getWalletStrategy(network);
    await s.setWallet(wallet);
    const addresses = await s.getAddresses();
    if (addresses.length === 0) {
        throw new Web3Exception(new Error("No addresses linked in this wallet."));
    }
    return addresses[0];
}

export async function broadcast(
    network: NetworkKey,
    injectiveAddress: string,
    msgs: Msgs | Msgs[],
    memo = "Choice Token Locker UI",
) {
    const s = getWalletStrategy(network);
    const networkEnum = network === "mainnet" ? Network.Mainnet : Network.Testnet;
    const broadcaster = new MsgBroadcaster({
        walletStrategy: s,
        simulateTx: true,
        network: networkEnum,
        endpoints: getNetworkEndpoints(networkEnum),
        gasBufferCoefficient: 1.1,
    });
    return await broadcaster.broadcastV2({
        injectiveAddress,
        msgs,
        memo,
    });
}
