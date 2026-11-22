export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: Error) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function readiness(): Deferred<void> {
  const ready = deferred<void>();
  // A disconnect can leave nobody awaiting readiness. Keep the rejection
  // observable to callers without turning an idle close into an unhandled one.
  void ready.promise.catch(() => {});
  return ready;
}
