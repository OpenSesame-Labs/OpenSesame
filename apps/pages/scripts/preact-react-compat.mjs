/**
 * React 19's optimistic hook is imported by React Router 8 even when an app
 * uses only its declarative BrowserRouter. Preact does not export the hook.
 * Its transition implementation is synchronous, so the matching client
 * semantics are a reducer-backed optimistic value that resets as soon as the
 * authoritative value changes.
 */
export * from "preact/compat";

import compat, { useReducer, useRef } from "preact/compat";

export function useOptimistic(authoritative, reducer = (_state, next) => next) {
  const state = useRef({ authoritative, optimistic: authoritative });
  const [, render] = useReducer((value) => value + 1, 0);
  if (!Object.is(state.current.authoritative, authoritative)) {
    state.current = { authoritative, optimistic: authoritative };
  }
  const update = (action) => {
    state.current.optimistic = reducer(state.current.optimistic, action);
    render();
  };
  return [state.current.optimistic, update];
}

export default { ...compat, useOptimistic };
