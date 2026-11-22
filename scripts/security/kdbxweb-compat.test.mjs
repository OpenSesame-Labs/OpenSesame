import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { root } from "./patched-dependencies.mjs";

const fromCore = createRequire(resolve(root, "packages/app-core/package.json"));
const sdk = fromCore("kdbxweb");
const minified = fromCore("kdbxweb/dist/kdbxweb.min.js");
const hash = fromCore("hash-wasm");
const fromSdk = createRequire(fromCore.resolve("kdbxweb"));
const xmlVersion = fromSdk("@xmldom/xmldom/package.json").version;
const credentials = (value) =>
  new sdk.Credentials(sdk.ProtectedValue.fromString(value));
sdk.CryptoEngine.setArgon2Impl(
  async (password, salt, memory, iterations, length, parallelism, type) => {
    const fn =
      type === sdk.CryptoEngine.Argon2TypeArgon2id
        ? hash.argon2id
        : hash.argon2d;
    const bytes = await fn({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      parallelism,
      iterations,
      memorySize: memory,
      hashLength: length,
      outputType: "binary",
    });
    return new Uint8Array(bytes).buffer;
  },
);

test("patched metadata installs its exact supported XML parser", () => {
  assert.equal(xmlVersion, "0.8.15");
  assert.equal(
    fromCore("kdbxweb/package.json").dependencies["@xmldom/xmldom"],
    "0.8.15",
  );
});

test("valid XML whitespace survives, illegal controls are still discarded, malformed XML fails closed", () => {
  for (const reader of [sdk, minified]) {
    const doc = reader.XmlUtils.parse(
      "<Root><V>Tab\there\nline</V><Bad>x\u0000\u0007\u000b\u000cy</Bad></Root>",
    );
    assert.equal(
      doc.getElementsByTagName("V")[0].textContent,
      "Tab\there\nline",
    );
    assert.equal(doc.getElementsByTagName("Bad")[0].textContent, "xy");
    for (const input of [
      "<Root><missing></Root>",
      '<Root broken="1" broken="2"/>',
      '<!DOCTYPE Root [<!ENTITY ext SYSTEM "file:///synthetic-path">]><Root>&ext;</Root>',
    ]) {
      assert.throws(() => reader.XmlUtils.parse(input), /bad xml/i, input);
    }
  }
});

test("SDK serializers preserve carriage returns in text without modifying the DOM", () => {
  for (const reader of [sdk, minified]) {
    const doc = reader.XmlUtils.parse(
      '<Root xmlns:p="urn:proof"><p:V p:id="fixed"/></Root>',
    );
    const element = doc.getElementsByTagNameNS("urn:proof", "V")[0];
    const value = "__KDBX_CR_T_0__\r&<__KDBX_CR_C_0__\r\nlast";
    element.textContent = value;
    const attribute = "a\rb\tc\nd";
    doc.documentElement.setAttribute("data-value", attribute);
    const cdataValue = "__KDBX_CR_C_1__\r&<\r\nlast";
    const cdata = doc.createCDATASection(cdataValue);
    doc.documentElement.appendChild(cdata);
    const comment = doc.createComment("comment\rkept");
    doc.documentElement.appendChild(comment);
    const serialized = reader.XmlUtils.serialize(doc);
    assert.match(serialized, /&#13;/);
    assert.ok(serialized.includes("<!--comment\rkept-->"));
    assert.equal(comment.data, "comment\rkept");
    assert.equal(cdata.data, cdataValue);
    assert.equal(element.textContent, value);
    const roundTrip = reader.XmlUtils.parse(serialized);
    assert.equal(
      roundTrip.documentElement.getAttribute("data-value"),
      attribute,
    );
    assert.equal(roundTrip.documentElement.textContent, value + cdataValue);
    const parsed = reader.XmlUtils.parse(serialized).getElementsByTagNameNS(
      "urn:proof",
      "V",
    )[0];
    assert.equal(parsed.getAttributeNS("urn:proof", "id"), "fixed");
    assert.equal(parsed.textContent, value);
    // XML-mandated normalization of raw document line endings is unchanged.
    assert.equal(
      reader.XmlUtils.parse("<Root>a\rb</Root>").documentElement.textContent,
      "a\nb",
    );
  }
});

for (const variant of ["v3-aes", "v4-aes", "v4-argon2d", "v4-argon2id"])
  test(`Node roundtrip ${variant}`, async () => {
    const key = credentials("test password");
    const db = sdk.Kdbx.create(key, "XML compatibility");
    if (variant === "v3-aes") {
      db.setVersion(3);
      db.header.keyEncryptionRounds = 10;
    } else {
      const kdf =
        variant === "v4-aes"
          ? sdk.Consts.KdfId.Aes
          : variant === "v4-argon2d"
            ? sdk.Consts.KdfId.Argon2d
            : sdk.Consts.KdfId.Argon2id;
      db.setKdf(kdf);
      db.header.kdfParameters.set(
        "M",
        sdk.VarDictionary.ValueType.UInt64,
        new sdk.Int64(4 * 1024 * 1024),
      );
      db.header.kdfParameters.set(
        "I",
        sdk.VarDictionary.ValueType.UInt64,
        new sdk.Int64(1),
      );
      db.header.kdfParameters.set(
        "R",
        sdk.VarDictionary.ValueType.UInt64,
        new sdk.Int64(10),
      );
    }
    const nested = db.createGroup(db.getDefaultGroup(), "Group <雪>");
    const entry = db.createEntry(nested);
    entry.fields.set("Title", "Tab\there & <XML>");
    entry.fields.set("UserName", "name\there\rreturns");
    entry.fields.set("Password", sdk.ProtectedValue.fromString("pass\tword"));
    entry.fields.set("Notes", "first\tsecond\r\nthird");
    entry.binaries.set("attachment.bin", new Uint8Array([1, 2, 3, 4]).buffer);
    const bytes = await db.save();
    const loaded = await sdk.Kdbx.load(
      bytes.slice(0),
      credentials("test password"),
    );
    const result = loaded
      .getDefaultGroup()
      .groups.find((g) => g.name === "Group <雪>").entries[0];
    assert.equal(result.fields.get("Title"), "Tab\there & <XML>");
    assert.equal(result.fields.get("UserName"), "name\there\rreturns");
    assert.equal(result.fields.get("Password").getText(), "pass\tword");
    assert.equal(result.fields.get("Notes"), "first\tsecond\r\nthird");
    assert.ok(result.binaries.has("attachment.bin"));
    await assert.rejects(() =>
      sdk.Kdbx.load(bytes.slice(0), credentials("wrong password")),
    );
    const corrupt = new Uint8Array(bytes.slice(0));
    corrupt[corrupt.length - 1] ^= 1;
    await assert.rejects(() =>
      sdk.Kdbx.load(corrupt.buffer, credentials("test password")),
    );
  });
