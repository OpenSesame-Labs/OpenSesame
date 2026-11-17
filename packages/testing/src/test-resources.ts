/** A started test service or other disposable test resource. */
export interface TestResource {
  close(): void | Promise<void>;
}

/** Owns one test's resources and closes them in reverse acquisition order. */
export class TestResourceScope implements TestResource {
  private readonly resources: TestResource[] = [];
  private readonly pending = new Set<Promise<TestResource>>();
  private closing: Promise<void> | undefined;
  private closed = false;

  use<T extends TestResource>(resource: T): T {
    if (this.closed) throw new Error("test resource scope is closed");
    return this.register(resource);
  }

  /** Track a start before it runs, so a concurrent setup failure cannot leak it. */
  acquire<T extends TestResource>(start: () => T | Promise<T>): Promise<T> {
    if (this.closed) throw new Error("test resource scope is closed");
    const acquisition = Promise.resolve()
      .then(start)
      .then((resource) => this.register(resource));
    this.pending.add(acquisition);
    void acquisition.then(
      () => this.pending.delete(acquisition),
      () => this.pending.delete(acquisition),
    );
    return acquisition;
  }

  private register<T extends TestResource>(resource: T): T {
    if (Object.is(resource, this))
      throw new Error("test resource scope cannot own itself");
    if (this.resources.includes(resource)) {
      throw new Error("test resource is already registered");
    }
    this.resources.push(resource);
    return resource;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = Promise.resolve().then(() => this.closeAll());
    }
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    // Acquisitions already in flight may finish after the test has failed.
    // They register their resources before this wait completes.
    await Promise.allSettled(this.pending);
    for (const resource of this.resources.reverse()) {
      try {
        await resource.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.resources.length = 0;
    if (errors.length)
      throw new AggregateError(errors, "test resource cleanup failed");
  }
}

/** Close acquired resources on success, setup failure, or assertion failure. */
export async function withTestResources<T>(
  run: (scope: TestResourceScope) => T | Promise<T>,
): Promise<T> {
  const scope = new TestResourceScope();
  let result: T;
  try {
    result = await run(scope);
  } catch (error) {
    try {
      await scope.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "test and cleanup failed",
      );
    }
    throw error;
  }
  await scope.close();
  return result;
}
