import * as kdbxweb from "kdbxweb";
import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../../../host.js";
import { createTestHost } from "../../../../test-host.js";
import { keepassKdbx } from "./kdbx.js";

afterEach(() => configureHost(createTestHost()));

describe("Node KDBX AES compatibility", () => {
  it.each([3, 4])(
    "opens a version %i database without browser workers",
    async (version) => {
      configureHost(createTestHost({ worker: undefined }));
      const credentials = new kdbxweb.Credentials(
        kdbxweb.ProtectedValue.fromString("node test password"),
      );
      const database = kdbxweb.Kdbx.create(credentials, "Node proof");
      if (version === 3) {
        database.setVersion(3);
        database.header.keyEncryptionRounds = 10;
      } else {
        database.setKdf(kdbxweb.Consts.KdfId.Aes);
        const parameters = database.header.kdfParameters;
        if (!parameters) throw new Error("missing v4 KDF parameters");
        parameters.set(
          "R",
          kdbxweb.VarDictionary.ValueType.UInt64,
          new kdbxweb.Int64(10),
        );
      }
      const item = database.createEntry(database.getDefaultGroup());
      item.fields.set("Title", "Node AES entry");
      item.fields.set(
        "Password",
        kdbxweb.ProtectedValue.fromString("node secret"),
      );
      const result = await keepassKdbx.parse({
        fileName: "node-aes.kdbx",
        text: "",
        headers: null,
        json: null,
        bytes: new Uint8Array(await database.save()),
        password: "node test password",
      });
      expect(result.items[0]).toMatchObject({
        name: "Node AES entry",
        password: "node secret",
      });
    },
  );
});
