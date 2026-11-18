import { describe, expect, it } from "vitest";
import { keepassKdbx } from "./kdbx.js";
import { checkAesKdfBudget } from "./kdbx-aes-kdf-budget.js";

const magic = [3, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5];
const u16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const u32 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  value >>> 24,
];
const u64 = (value: bigint) => [
  ...u32(Number(value & 0xffff_ffffn)),
  ...u32(Number(value >> 32n)),
];
const field = (major: number, id: number, value: number[]) => [
  id,
  ...(major === 3 ? u16(value.length) : u32(value.length)),
  ...value,
];
const header = (major: number, ...fields: number[][]) =>
  new Uint8Array([
    ...magic,
    ...u16(1),
    ...u16(major),
    ...fields.flat(),
    ...field(major, 0, []),
  ]);
const item = (type: number, key: number[], value: number[]) => [
  type,
  ...u32(key.length),
  ...key,
  ...u32(value.length),
  ...value,
];
const dictionary = (...items: number[][]) => [0, 1, ...items.flat(), 0];
const v3 = (rounds: bigint) => header(3, field(3, 6, u64(rounds)));
const v4 = (type: number, rounds: number[]) =>
  header(4, field(4, 11, dictionary(item(type, [82], rounds))));

describe("KDBX AES work screen", () => {
  it("allows the documented limit and rejects larger KDBX 3 counts", () => {
    expect(() => checkAesKdfBudget(v3(1n << 24n))).not.toThrow();
    expect(() => checkAesKdfBudget(v3((1n << 24n) + 1n))).toThrow(
      /work budget/,
    );
    expect(() => checkAesKdfBudget(v3((1n << 64n) - 1n))).toThrow(
      /work budget/,
    );
  });

  it.each([0x04, 0x0c, 0x05, 0x0d])(
    "screens numeric dictionary type %i",
    (type) => {
      const encode =
        type === 0x04 || type === 0x0c ? (n: bigint) => u32(Number(n)) : u64;
      expect(() =>
        checkAesKdfBudget(v4(type, encode(1n << 24n))),
      ).not.toThrow();
      expect(() =>
        checkAesKdfBudget(v4(type, encode((1n << 24n) + 1n))),
      ).toThrow(/work budget/);
    },
  );

  it("screens repeated fields and the UTF-8 BOM that kdbxweb removes from keys", () => {
    const huge = item(0x05, [0xef, 0xbb, 0xbf, 82], u64(1n << 40n));
    const small = item(0x05, [82], u64(1n));
    expect(() =>
      checkAesKdfBudget(
        header(3, field(3, 6, u64(1n << 40n)), field(3, 6, u64(1n))),
      ),
    ).toThrow(/work budget/);
    expect(() =>
      checkAesKdfBudget(header(4, field(4, 11, dictionary(huge, small)))),
    ).toThrow(/work budget/);
    expect(() =>
      checkAesKdfBudget(
        header(
          4,
          field(4, 11, dictionary(small)),
          field(4, 11, dictionary(small)),
        ),
      ),
    ).toThrow(/header/);
  });

  it("refuses truncated, malformed, and excessively long headers", () => {
    for (const valid of [v3(1n), v4(0x05, u64(1n))]) {
      for (let length = 0; length < valid.length; length++) {
        expect(() => checkAesKdfBudget(valid.subarray(0, length))).toThrow();
      }
    }
    expect(() => checkAesKdfBudget(header(3, field(3, 6, [1, 2])))).toThrow(
      /header/,
    );
    expect(() => checkAesKdfBudget(v4(0x05, [1, 2, 3, 4]))).toThrow(/header/);
    expect(() =>
      checkAesKdfBudget(
        header(4, field(4, 11, [0, 1, 0x05, ...u32(0xffff_ffff)])),
      ),
    ).toThrow(/header/);
    expect(() =>
      checkAesKdfBudget(
        new Uint8Array([
          ...magic,
          ...u16(1),
          ...u16(4),
          11,
          ...u32(0xffff_ffff),
        ]),
      ),
    ).toThrow(/header/);
    const long = new Uint8Array(1024 * 1024 + 6);
    long.set([...magic, ...u16(1), ...u16(4), 1, ...u32(1024 * 1024)]);
    expect(() => checkAesKdfBudget(long)).toThrow(/header/);
  });

  it.each([v3(1n << 40n), v4(0x05, u64(1n << 40n))])(
    "rejects hostile rounds through the public importer before decryption",
    async (bytes) => {
      await expect(
        keepassKdbx.parse({
          fileName: "hostile.kdbx",
          bytes,
          password: "test",
          text: "",
          headers: null,
          json: null,
        }),
      ).rejects.toThrow(/work budget/);
    },
  );
});
