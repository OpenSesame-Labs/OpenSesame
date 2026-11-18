import assert from "node:assert/strict";
import { test } from "vitest";
import {
  agUiBrowserEntry,
  readAgUiBrowserInputs,
  renderAgUiSseClient,
  validateAgUiBrowserSource,
} from "./ag-ui-browser-entry.mjs";

const input = readAgUiBrowserInputs();

test("the boundary exposes only source-mapped official SSE transport leaves", () => {
  const source = renderAgUiSseClient();
  assert.match(source, /parseSSEStream/);
  assert.match(source, /runHttpRequest/);
  assert.doesNotMatch(source, /transformHttpEventStream|parseProtoStream/);
  assert.match(input.officialSources.http, /export const runHttpRequest/);
  assert.match(input.officialSources.sse, /export const parseSSEStream/);
});

test("every reviewed upstream AG-UI input is content pinned", () => {
  assert.throws(
    () =>
      validateAgUiBrowserSource(
        "dist/index.mjs.map",
        `${input.sources["dist/index.mjs.map"].source}\n`,
      ),
    /pin mismatch/,
  );
  assert.doesNotThrow(() => readAgUiBrowserInputs());
});

test("the build plugin rewires only the owned transport", () => {
  const plugin = agUiBrowserEntry();
  plugin.buildStart();
  const transport = input.packageRoot.replace(
    /node_modules\/@ag-ui\/client$/,
    "packages/app-core/src/tutorial/agents/ag-ui/transport.ts",
  );
  assert.match(plugin.resolveId("@ag-ui/client", transport), /ag-ui-sse/);
  assert.equal(plugin.resolveId("@ag-ui/client", "/fixture/other.ts"), null);
  const entry = plugin.load("\0opensesame-ag-ui-sse-client");
  assert.match(entry, /parseSSEStream/);
  for (const id of entry.matchAll(/from "([^"]+)"/g)) {
    assert.equal(typeof plugin.load(JSON.parse(`"${id[1]}"`)), "string");
  }
});
