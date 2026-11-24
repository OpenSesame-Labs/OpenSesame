import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_TASKBUS_RESPONSE_KEYS,
  GetTaskBusResponseSchema,
  PingTaskBusResponseSchema,
  PutTaskBusRequestSchema,
  PutTaskBusResponseSchema,
  TaskBusConfigSchema,
} from "../taskbus.js";
import { taskBusOpenApi } from "../taskbus.openapi.js";

const sampleConfig = {
  backend: "nats" as const,
  nats_url: "nats://127.0.0.1:4222",
  source: "stored" as const,
  status: "ok",
  last_error: null,
};

describe("taskbus contract", () => {
  it("parses operator GET/PUT/PING shapes", () => {
    expect(TaskBusConfigSchema.parse(sampleConfig).backend).toBe("nats");
    expect(
      GetTaskBusResponseSchema.parse({ taskbus: sampleConfig }).taskbus.source,
    ).toBe("stored");
    expect(
      PutTaskBusRequestSchema.parse({
        backend: "nats",
        nats_url: "nats://box.tail.ts.net:4222",
      }).nats_url,
    ).toContain("tail");
    expect(
      PutTaskBusResponseSchema.parse({
        taskbus: sampleConfig,
        applied: true,
      }).applied,
    ).toBe(true);
    expect(
      PingTaskBusResponseSchema.parse({
        ok: true,
        taskbus: { ...sampleConfig, status: "reachable" },
      }).ok,
    ).toBe(true);
  });

  it("rejects http URLs and unknown fields", () => {
    expect(() =>
      PutTaskBusRequestSchema.parse({
        backend: "nats",
        nats_url: "http://127.0.0.1:4222",
      }),
    ).toThrow();
    expect(() =>
      TaskBusConfigSchema.parse({ ...sampleConfig, access_token: "leak" }),
    ).toThrow();
    for (const key of FORBIDDEN_TASKBUS_RESPONSE_KEYS) {
      expect(() =>
        TaskBusConfigSchema.parse({ ...sampleConfig, [key]: "secret" }),
      ).toThrow();
    }
  });

  it("allows memory backend without nats_url", () => {
    expect(
      TaskBusConfigSchema.parse({
        backend: "memory",
        source: "default",
        status: "ok",
      }).backend,
    ).toBe("memory");
  });
});

describe("taskbus OpenAPI contract suite", () => {
  it("documents GET/PUT/PING paths with auth and status codes", () => {
    const paths = taskBusOpenApi.paths;
    expect(paths["/api/v1/operator/taskbus"].get.responses).toMatchObject({
      "200": expect.anything(),
      "401": expect.anything(),
      "403": expect.anything(),
    });
    expect(paths["/api/v1/operator/taskbus"].put.responses).toMatchObject({
      "200": expect.anything(),
      "400": expect.anything(),
      "409": expect.anything(),
    });
    expect(paths["/api/v1/operator/taskbus/ping"].post.responses).toMatchObject(
      {
        "200": expect.anything(),
        "422": expect.anything(),
      },
    );
  });

  it("keeps OpenAPI schema enums aligned with Zod parsers", () => {
    const cfg = taskBusOpenApi.components.schemas.TaskBusConfig;
    expect(cfg.properties.backend.enum).toEqual(["memory", "nats"]);
    expect(cfg.properties.source.enum).toEqual(["env", "stored", "default"]);
    expect(cfg.additionalProperties).toBe(false);

    const put = taskBusOpenApi.components.schemas.PutTaskBusRequest;
    expect(put.additionalProperties).toBe(false);
    expect(() =>
      PutTaskBusRequestSchema.parse({
        backend: "nats",
        nats_url: "nats://127.0.0.1:4222",
        extra: true,
      }),
    ).toThrow();
  });

  it("Zod accepts fixtures that match OpenAPI success bodies", () => {
    const config = {
      backend: "nats" as const,
      nats_url: "tls://box.tail.ts.net:4222",
      source: "stored" as const,
      status: "applied",
      last_error: null,
    };
    expect(
      GetTaskBusResponseSchema.parse({ taskbus: config }).taskbus.status,
    ).toBe("applied");
    expect(
      PutTaskBusResponseSchema.parse({ taskbus: config, applied: true })
        .applied,
    ).toBe(true);
    expect(
      PingTaskBusResponseSchema.parse({
        ok: false,
        taskbus: { ...config, status: "unreachable" },
        hint: "Host could not reach NATS",
      }).ok,
    ).toBe(false);
  });

  it("forbids secret fields on TaskBusConfig schema", () => {
    const props = Object.keys(
      taskBusOpenApi.components.schemas.TaskBusConfig.properties,
    );
    for (const leak of [
      "access_token",
      "refresh_token",
      "client_secret",
      "webhook_secret",
      "private_key",
      "pem",
    ]) {
      expect(props).not.toContain(leak);
    }
  });
});
