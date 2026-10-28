import { useEffect, useState } from "react";

/** Runs `load` when `key` changes; { loading, error, data }. A stale answer is dropped. */
export default function useLoad(load, key) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null, data: null });
    load()
      .then((data) => live && setState({ loading: false, error: null, data }))
      .catch((err) => live && setState({ loading: false, error: err.message, data: null }));
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
