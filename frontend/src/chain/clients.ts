import { ChainGrpcWasmApi } from "@injectivelabs/sdk-ts";
import { getNetworkEndpoints, Network } from "@injectivelabs/networks";
import type { NetworkKey } from "../constants";

const wasmApiCache = new Map<NetworkKey, ChainGrpcWasmApi>();

export function getWasmApi(network: NetworkKey): ChainGrpcWasmApi {
    let api = wasmApiCache.get(network);
    if (!api) {
        const endpoints = getNetworkEndpoints(
            network === "mainnet" ? Network.Mainnet : Network.Testnet,
        );
        api = new ChainGrpcWasmApi(endpoints.grpc);
        wasmApiCache.set(network, api);
    }
    return api;
}

/**
 * Run a smart-contract query. Returns the decoded JSON payload.
 * Throws on chain error.
 */
export async function smartQuery<T>(
    network: NetworkKey,
    contract: string,
    msg: unknown,
): Promise<T> {
    const api = getWasmApi(network);
    const res = await api.fetchSmartContractState(
        contract,
        msg as Record<string, unknown>,
    );
    const bytes = res.data as Uint8Array;
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as T;
}
