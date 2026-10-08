import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Run `load` on mount and whenever `deps` change; `reload()` runs it again.
 * A result that arrives after unmount, or after a newer load, is dropped.
 */
export function useLoad(load, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(run)
      .then(
        (data) => { if (seq.current === mine) setState({ data, error: null, loading: false }); },
        (error) => { if (seq.current === mine) setState({ data: null, error, loading: false }); },
      );
  }, [run]);

  useEffect(() => {
    reload();
    return () => { seq.current += 1; };
  }, [reload]);

  return { ...state, reload };
}
