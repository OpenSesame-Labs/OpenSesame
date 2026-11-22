import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  extract,
  fileMap,
  installedPackageDifferences,
} from "../scripts/security/patched-dependencies.mjs";

const require = createRequire(import.meta.url);
const fromPi = createRequire(
  resolve("node_modules/@earendil-works/pi-coding-agent/package.json"),
);
const { parseXML, XmlNode } = require("@aws-sdk/xml-builder");
const { parseXmlBody, parseXmlErrorBody } = fromPi("@aws-sdk/core");
const { BedrockRuntimeClient, InvokeModelCommand } = fromPi(
  "@aws-sdk/client-bedrock-runtime",
);
const workspace = dirname(fileURLToPath(import.meta.url));

test("DeepSec resolves the audited XML builder tarball in its AWS SDK", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(workspace, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(resolve(workspace, "package-lock.json"), "utf8"),
  );
  const selector = "@aws-sdk/xml-builder";
  const relativeTarball =
    "file:../patches/vendor/aws-sdk-xml-builder-3.972.42.tgz";
  assert.equal(manifest.devDependencies[selector], relativeTarball);
  assert.equal(manifest.overrides[selector], `$${selector}`);
  const tarball = readFileSync(
    resolve(workspace, "..", "patches/vendor/aws-sdk-xml-builder-3.972.42.tgz"),
  );
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const copies = Object.entries(lock.packages).filter(([path]) =>
    path.endsWith("node_modules/@aws-sdk/xml-builder"),
  );
  assert.ok(copies.length > 0);
  for (const [, value] of copies) {
    assert.equal(value.version, "3.972.42");
    assert.equal(value.resolved, relativeTarball);
    assert.equal(value.integrity, integrity);
    assert.equal(value.dependencies["fast-xml-parser"], "5.12.1");
  }
  const fromCore = createRequire(fromPi.resolve("@aws-sdk/core"));
  assert.equal(
    realpathSync(fromCore.resolve(selector)),
    realpathSync(require.resolve(selector)),
  );
  const fromBuilder = createRequire(require.resolve(selector));
  const parserPackage = resolve(
    dirname(dirname(fromBuilder.resolve("fast-xml-parser"))),
    "package.json",
  );
  assert.equal(
    JSON.parse(readFileSync(parserPackage, "utf8")).version,
    "5.12.1",
  );
  const temporary = mkdtempSync(join(tmpdir(), "deepsec-xml-builder-"));
  try {
    const expected = fileMap(
      extract(
        resolve(
          workspace,
          "..",
          "patches/vendor/aws-sdk-xml-builder-3.972.42.tgz",
        ),
        temporary,
      ),
    );
    for (const [key] of copies) {
      const installed = resolve(workspace, key);
      assert.deepEqual(
        installedPackageDifferences(
          expected,
          fileMap(installed),
          key,
          lock.packages,
        ),
        [],
        key,
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

const entityXml = (size, count) =>
  `<!DOCTYPE r [<!ENTITY custom "${"x".repeat(size)}">]><r>${"&custom;".repeat(count)}</r>`;

test("SDK XML parser keeps Unicode, entities, attributes, lists and whitespace", () => {
  assert.deepEqual(parseXML('\ufeff<?xml version="1.0"?><Root>value</Root>'), {
    Root: "value",
  });
  assert.equal(parseXML('<!DOCTYPE r [<!ENTITY e "a>b">]><r>&e;</r>').r, "a>b");
  const actual = parseXML(
    `<?xml version="1.0"?><Response id="proof"><Name>A &amp; B &#x1F600; &euro;</Name><Item>one</Item><Item><![CDATA[two & <three>]]></Item><Empty/><Nested><Text>  keep  </Text></Nested></Response>`,
  );
  assert.deepEqual(actual, {
    Response: {
      id: "proof",
      Name: "A & B 😀 €",
      Item: ["one", "two & <three>"],
      Empty: "",
      Nested: { Text: "  keep  " },
    },
  });
  assert.deepEqual(parseXML(entityXml(5, 2)), { r: "xxxxxxxxxx" });
  assert.equal(parseXML(`<r>${"&amp;".repeat(12000)}</r>`).r.length, 12000);
  const encoded = XmlNode.of("Name", "value < & 😀").toString();
  assert.equal(parseXML(encoded).Name, "value < & 😀");
});

test("custom entity expansion and XML depth have bounded limits", () => {
  const safe = parseXML(entityXml(400, 1000));
  assert.equal(safe.r.length, 400000);
  assert.throws(
    () => parseXML(entityXml(1024, 1000)),
    /expanded content length limit/i,
  );
  assert.throws(
    () => parseXML(entityXml(1, 10001)),
    /entity expansion count limit/i,
  );
  assert.equal(parseXML(entityXml(5, 2)).r, "xxxxxxxxxx");
  assert.doesNotThrow(() => parseXML("<n>".repeat(256) + "</n>".repeat(256)));
  assert.throws(
    () => parseXML("<n>".repeat(258) + "</n>".repeat(258)),
    /maximum nest(?:ed tags|ing) exceeded/i,
  );
  assert.throws(() => parseXML("<root><unterminated>"));
});

test("the real AWS XML protocol deserializer preserves error details and propagates limits", async () => {
  const response = Buffer.from(
    "<Error><Code>BadRequest</Code><Message>😀 &amp; &euro; &#x1F600;</Message><RequestId>abc</RequestId></Error>",
  );
  const expected = {
    Code: "BadRequest",
    Message: "😀 & € 😀",
    RequestId: "abc",
  };
  assert.deepEqual(await parseXmlBody(response, {}), expected);
  assert.deepEqual(await parseXmlErrorBody(response, {}), expected);
  await assert.rejects(
    () => parseXmlBody(Buffer.from(entityXml(1024, 1000)), {}),
    /expanded content length limit/i,
  );
});

test("the real Bedrock SDK client still serializes and reads a local stubbed response", async () => {
  let captured;
  const client = new BedrockRuntimeClient({
    region: "us-east-1",
    credentials: { accessKeyId: "TESTACCESS", secretAccessKey: "TESTSECRET" },
    maxAttempts: 1,
    requestHandler: {
      handle: async (request) => {
        captured = request;
        return {
          response: {
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from('{"answer":"ok"}'),
          },
        };
      },
    },
  });
  try {
    const output = await client.send(
      new InvokeModelCommand({
        modelId: "test-model",
        body: Buffer.from('{"prompt":"hello"}'),
        contentType: "application/json",
        accept: "application/json",
      }),
    );
    assert.equal(Buffer.from(output.body).toString(), '{"answer":"ok"}');
    assert.equal(captured.method, "POST");
    assert.match(captured.path, /test-model/);
    assert.equal(Buffer.from(captured.body).toString(), '{"prompt":"hello"}');
  } finally {
    client.destroy();
  }
});
