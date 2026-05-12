/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_SELECTED_NETWORK?: string;
    readonly VITE_LOCKER_ADDRESS_TESTNET?: string;
    readonly VITE_LOCKER_ADDRESS_MAINNET?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
