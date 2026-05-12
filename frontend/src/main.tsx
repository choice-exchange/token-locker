import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import App from "./App";
import "./index.css";

// sdk-ts internals use Buffer; vite-plugin-node-polyfills only provides the
// module — exposing it globally avoids "Buffer is not defined" at runtime.
if (typeof window !== "undefined" && !(window as unknown as { Buffer?: unknown }).Buffer) {
    (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
        <ToastContainer
            position="bottom-right"
            theme="dark"
            autoClose={5000}
            newestOnTop
            pauseOnFocusLoss={false}
        />
    </StrictMode>,
);
