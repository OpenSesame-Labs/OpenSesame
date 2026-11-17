import type { PasskeyCredential } from "@opensesame/auth-upstream";
import { createMemoryPasskeyCredentialStore } from "@opensesame/auth-upstream";
import fc from "fast-check";
import { expect, it } from "vitest";

type Owner = "alice" | "bob";
type Event = {
  operation: "register" | "remove" | "read" | "confirm";
  owner: Owner;
  counter: number | undefined;
  slot: 0 | 1;
};
type RecordModel = { owner: Owner; generation: string; counter: number };
type Store = ReturnType<typeof createMemoryPasskeyCredentialStore>;

const events: fc.Arbitrary<Event> = fc.record({
  operation: fc.constantFrom("register", "remove", "read", "confirm"),
  owner: fc.constantFrom("alice", "bob"),
  counter: fc.constantFrom(undefined, 0, 1, 2, 3),
  slot: fc.constantFrom(0, 1),
});

async function confirmSnapshot(
  store: Store,
  current: RecordModel | undefined,
  snapshot: RecordModel | undefined,
  actual: PasskeyCredential | undefined,
  counter: number | undefined,
): Promise<RecordModel | undefined> {
  const validCounter =
    counter === undefined ||
    (counter === 0
      ? current?.counter === 0
      : current !== undefined && counter > current.counter);
  const expected =
    current !== undefined &&
    snapshot !== undefined &&
    current.generation === snapshot.generation &&
    validCounter;
  if (!actual) {
    expect(snapshot).toBeUndefined();
    return current;
  }

  expect(await store.advance("key", actual.generation, counter)).toBe(expected);
  if (expected && current && counter !== undefined && counter > 0) {
    current.counter = counter;
  }
  return current;
}

it("preserves ownership, registration identity, and counters across generated interleavings", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(events, { minLength: 1, maxLength: 60 }),
      async (sequence) => {
        const store = createMemoryPasskeyCredentialStore();
        let current: RecordModel | undefined;
        let nextGeneration = 0;
        const snapshots: (RecordModel | undefined)[] = [undefined, undefined];
        const actualSnapshots: (PasskeyCredential | undefined)[] = [
          undefined,
          undefined,
        ];
        for (const event of sequence) {
          if (event.operation === "register") {
            const record = {
              owner: event.owner,
              generation: String(++nextGeneration),
              counter: 0,
            };
            const expected = current === undefined;
            expect(
              await store.create({
                credentialId: "key",
                principalId: record.owner,
                generation: record.generation,
                publicKey: new Uint8Array([1]),
                counter: 0,
              }),
            ).toBe(expected);
            if (expected) current = record;
          } else if (event.operation === "remove") {
            const expected = current?.owner === event.owner;
            expect(await store.remove("key", event.owner)).toBe(expected);
            if (expected) current = undefined;
          } else if (event.operation === "read") {
            snapshots[event.slot] = current && { ...current };
            actualSnapshots[event.slot] = await store.get("key");
          } else {
            current = await confirmSnapshot(
              store,
              current,
              snapshots[event.slot],
              actualSnapshots[event.slot],
              event.counter,
            );
          }
          const actual = await store.get("key");
          expect(actual?.principalId).toBe(current?.owner);
          expect(actual?.generation).toBe(current?.generation);
          expect(actual?.counter).toBe(current?.counter);
        }
      },
    ),
    { numRuns: 500 },
  );
});
