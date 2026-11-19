/** A scoped copy whose commit must be validated alongside its peer stores. */
export interface MemoryStoreFork<T> {
  store: T;
  validate(): boolean;
  commit(): void;
}
