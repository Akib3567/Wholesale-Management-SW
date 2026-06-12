import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

interface ApiState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

/** Tiny fetch-on-mount hook; call reload() after mutations. */
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
): ApiState<T> & { reload: () => void } {
  const [state, setState] = useState<ApiState<T>>({ data: undefined, error: undefined, loading: true });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fetcher()
      .then((data) => alive && setState({ data, error: undefined, loading: false }))
      .catch((e: unknown) => {
        if (!alive) return;
        const message = e instanceof ApiError ? e.message : 'Request failed';
        setState((s) => ({ ...s, error: message, loading: false }));
      });
    return () => {
      alive = false;
    };
    // deps are caller-provided; tick forces reload()
  }, [...deps, tick]);

  return { ...state, reload };
}
