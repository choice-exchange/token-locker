import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Minimal async data hook — no react-query dep.
 * Re-runs when `deps` change; expose `refresh()` for manual refetch.
 *
 * `fn` receives an AbortSignal; honour it if you do network IO.
 */
export function useAsync<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    deps: unknown[],
): {
    data: T | undefined;
    error: unknown;
    loading: boolean;
    refresh: () => void;
} {
    const [data, setData] = useState<T | undefined>(undefined);
    const [error, setError] = useState<unknown>(undefined);
    const [loading, setLoading] = useState(false);
    const [tick, setTick] = useState(0);
    const abortRef = useRef<AbortController | null>(null);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const stableFn = useCallback(fn, deps);

    useEffect(() => {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setLoading(true);
        setError(undefined);
        stableFn(ac.signal)
            .then((d) => {
                if (!ac.signal.aborted) setData(d);
            })
            .catch((e) => {
                if (!ac.signal.aborted) setError(e);
            })
            .finally(() => {
                if (!ac.signal.aborted) setLoading(false);
            });
        return () => ac.abort();
    }, [stableFn, tick]);

    const refresh = useCallback(() => setTick((t) => t + 1), []);
    return { data, error, loading, refresh };
}
