import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

const fromRoot = createRequire(resolve("package.json"));
const fromRedteam = createRequire(resolve("tests/redteam/package.json"));
const fromPromptfoo = createRequire(fromRedteam.resolve("promptfoo"));
const { parseXML, XmlNode } = fromRoot("@aws-sdk/xml-builder");
const { S3Client, ListObjectsV2Command } = fromPromptfoo("@aws-sdk/client-s3");

test("AWS XML preserves Unicode, old named entities and unknown references", () => {
  const xml =
    '<Response id="1"><Key>&#x1F600; &#128512; &#x00000041; &euro; &frac12; &amp; &unrecognized;</Key></Response>';
  assert.deepEqual(parseXML('\ufeff<?xml version="1.0"?><Root>value</Root>'), {
    Root: "value",
  });
  assert.deepEqual(parseXML(xml), {
    Response: { id: "1", Key: "😀 😀 A € ½ & &unrecognized;" },
  });
  assert.equal(
    parseXML("<r>&#x110000; &#9999999;</r>").r,
    "&#x110000; &#9999999;",
  );
  assert.equal(parseXML("<r>&#xD800;&#0;</r>").r, "");
  const encoded = XmlNode.of("Name", "a\rb 😀 < &").toString();
  assert.equal(parseXML(encoded).Name, "a\rb 😀 < &");
});

test("AWS XML rejects unsafe names, duplicate attributes, invalid syntax and excess depth", () => {
  for (const name of ["__proto__", "constructor", "prototype"]) {
    assert.throws(
      () => parseXML(`<r><${name}>value</${name}></r>`),
      /invalid xml name/i,
    );
    assert.throws(() => parseXML(`<r ${name}="value"/>`), /invalid xml name/i);
  }
  assert.deepEqual(
    parseXML("<r><toString>x</toString><toString>y</toString></r>"),
    { r: { __toString: ["x", "y"] } },
  );
  assert.deepEqual(parseXML("<r><isPrototypeOf>x</isPrototypeOf></r>"), {
    r: { isPrototypeOf: "x" },
  });
  assert.throws(
    () => parseXML('<r id="1" id="2"/>'),
    /duplicate attribute|is repeated/i,
  );
  assert.throws(
    () => parseXML("<r id=unquoted/>"),
    /must be quoted|without value/i,
  );
  assert.throws(
    () => parseXML("<r><item></r>"),
    /mismatched tags|expected closing tag/i,
  );
  assert.throws(() => parseXML("<1/>"), /invalid name/i);
  assert.throws(() => parseXML("<r>\u0000</r>"), /invalid control character/i);
  assert.throws(() => parseXML("<r/><s/>"), /unexpected content after root/i);
  assert.throws(
    () => parseXML("<r/>trailing"),
    /unexpected content after root/i,
  );
  assert.doesNotThrow(() => parseXML("<r/><!--comment--><?pi value?>"));
  assert.doesNotThrow(() => parseXML("<n>".repeat(256) + "</n>".repeat(256)));
  assert.throws(
    () => parseXML("<n>".repeat(258) + "</n>".repeat(258)),
    /maximum nesting exceeded/i,
  );
});

test("DOCTYPE internal entities retain prior behavior with bounded expansion", () => {
  const makeXml = (size, count) =>
    `<!DOCTYPE r [<!ENTITY e "${"x".repeat(size)}">]><r>${"&e;".repeat(count)}</r>`;
  assert.equal(parseXML(makeXml(5, 2)).r, "xxxxxxxxxx");
  assert.equal(parseXML('<!DOCTYPE r [<!ENTITY e "a>b">]><r>&e;</r>').r, "a>b");
  assert.throws(
    () => parseXML('<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r><s/>'),
    /unexpected content after root/i,
  );
  assert.throws(
    () => parseXML(makeXml(1024, 1000)),
    /expanded content length limit/i,
  );
  assert.throws(
    () => parseXML(makeXml(1, 10001)),
    /entity expansion count limit/i,
  );
  // A rejected response must not poison the shared decoder for the next call.
  assert.equal(parseXML(makeXml(5, 2)).r, "xxxxxxxxxx");
  assert.throws(
    () =>
      parseXML(
        '<!DOCTYPE r [<!ENTITY e SYSTEM "file:///synthetic-path">]><r>&e;</r>',
      ),
    /external entities are not supported/i,
  );
});

test("real S3 deserialization preserves characters in an object key", async () => {
  let captured;
  const xml =
    '\ufeff<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test</Name><Contents><Key>report&#x1F600;&euro;.txt</Key><Size>3</Size><ETag>&quot;etag&quot;</ETag></Contents><IsTruncated>false</IsTruncated></ListBucketResult>';
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "TESTACCESS", secretAccessKey: "TESTSECRET" },
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: {
      handle: async (request) => {
        captured = request;
        return {
          response: {
            statusCode: 200,
            headers: { "content-type": "application/xml" },
            body: Readable.from([Buffer.from(xml)]),
          },
        };
      },
    },
  });
  try {
    const output = await client.send(
      new ListObjectsV2Command({ Bucket: "local-bucket" }),
    );
    assert.equal(output.Contents[0].Key, "report😀€.txt");
    assert.equal(output.Contents[0].Size, 3);
    assert.equal(output.IsTruncated, false);
    assert.equal(captured.method, "GET");
  } finally {
    client.destroy();
  }
});
