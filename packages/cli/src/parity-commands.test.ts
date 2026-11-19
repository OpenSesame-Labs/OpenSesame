import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCliAppApprovalBlocked } from "@opensesame/app-core/lib/cli-app-integration/policy-runtime.js";
import type { PasswordAgent } from "@opensesame/app-core/lib/password-agent/index.js";
import {
  createRunGrant,
  describeRunGrant,
} from "@opensesame/app-core/lib/password-agent/run-grant.js";
import { describe, expect, it, vi } from "vitest";
import type { CliAppIntegrationPort } from "./cli-app-integration-client.js";
import { type ParityContext, runChild, runEnv } from "./parity-commands.js";
import { createCredentialStore } from "./parity-credentials.js";
import { openRunGrantStore } from "./parity-lease-node.js";

function agentWithRun(run: PasswordAgent["run"]): PasswordAgent {
  return (
    // SAFETY: runChild only invokes agent.run; the stub implements that method.
    { run } as PasswordAgent
  );
}

function agentWithBroker(
  runBrokered: PasswordAgent["runBrokered"],
  run: PasswordAgent["run"] = async () => 0,
): PasswordAgent {
  return (
    // SAFETY: runChild invokes agent.runBrokered or agent.run; the stub implements both lanes.
    { runBrokered, run } as PasswordAgent
  );
}

function agentWithRunFile(runFile: PasswordAgent["runFile"]): PasswordAgent {
  return (
    // SAFETY: runEnv only invokes agent.runFile after approval; the stub implements that method.
    { runFile } as PasswordAgent
  );
}

function baseCtx(
  overrides: Partial<ParityContext> & {
    agent: PasswordAgent;
  },
): ParityContext {
  return {
    args: ["--env", "TOKEN=op://vault/item/field"],
    child: ["node", "-e", "0"],
    scope: { desktop: true },
    reveal: true,
    store: createCredentialStore(),
    raw: {
      invoke: async () => "",
      run: async () => 0,
      runEnvFile: async () => 0,
    },
    port: {
      invoke: async () => "",
      run: async () => 0,
      runEnvFile: async () => 0,
    },
    privateInput: async () => "",
    privateFile: async () => {},
    ...overrides,
  };
}

describe("parity run approval", () => {
  it("allows an independently authorized, exact run grant once during the app approval pause", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "opensesame-run-grant-pause-"),
    );
    const previous = process.env.OPENSESAME_STATE_DIR;
    process.env.OPENSESAME_STATE_DIR = directory;
    const run = vi.fn(async () => 0);
    const ensureReveal = vi.fn(async () => "approve" as const);
    const args = () => ["--env", "API=op://v/i/f", "--grant", "independent"];
    try {
      const store = await openRunGrantStore();
      try {
        await store.insert(
          createRunGrant({
            id: "independent",
            principal: await store.principal(),
            binding: describeRunGrant({
              assignments: [{ name: "API", reference: "op://v/i/f" }],
            }),
            now: Date.now(),
            uses: 1,
          }),
        );
      } finally {
        store.close();
      }
      const context = () =>
        baseCtx({
          agent: agentWithRun(run),
          args: args(),
          appIntegration: { ensureReveal },
        });
      await expect(runChild(context())).resolves.toBe(0);
      await expect(runChild(context())).rejects.toThrow(
        /invalid, expired, revoked, exhausted/,
      );
      expect(run).toHaveBeenCalledOnce();
      expect(ensureReveal).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(process.env, "OPENSESAME_STATE_DIR");
      else process.env.OPENSESAME_STATE_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses run without app integration approval and does not spawn the child", async () => {
    const run = vi.fn(async () => 0);
    const denyPort: CliAppIntegrationPort = {
      ensureReveal: async () => "deny",
    };
    const agent = agentWithRun(run);
    await expect(
      runChild(
        baseCtx({
          agent,
          appIntegration: denyPort,
        }),
      ),
    ).rejects.toThrow(
      isCliAppApprovalBlocked() ? /temporarily unavailable/i : /denied/i,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("gates a child even when the app port reports approval", async () => {
    const run = vi.fn(async () => 0);
    const approvePort: CliAppIntegrationPort = {
      ensureReveal: async () => "approve",
    };
    const agent = agentWithRun(run);
    const result = runChild(baseCtx({ agent, appIntegration: approvePort }));
    if (isCliAppApprovalBlocked()) {
      await expect(result).rejects.toThrow(/temporarily unavailable/i);
      expect(run).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toBe(0);
      expect(run).toHaveBeenCalledOnce();
    }
  });

  it("refuses env run without approval and does not read the env file", async () => {
    const runFile = vi.fn(async () => 0);
    const denyPort: CliAppIntegrationPort = {
      ensureReveal: async () => "deny",
    };
    const agent = agentWithRunFile(runFile);
    await expect(
      runEnv({
        ...baseCtx({ agent, appIntegration: denyPort }),
        args: ["run", "./env.file"],
      }),
    ).rejects.toThrow(
      isCliAppApprovalBlocked() ? /temporarily unavailable/i : /denied/i,
    );
    expect(runFile).not.toHaveBeenCalled();
  });
});

describe("parity run --agent-proxy", () => {
  const approvePort: CliAppIntegrationPort = {
    ensureReveal: async () => "approve",
  };
  const brokerArgs = [
    "--agent-proxy",
    "--env",
    "TOKEN=os://vault/connections%2Facme%2Fvercel/password",
    "--paths",
    "TOKEN=/v2/user",
    "--methods",
    "TOKEN=GET",
  ];

  it("gates --agent-proxy before routing with its scope flags", async () => {
    const runBrokered = vi.fn(async () => 0);
    const run = vi.fn(async () => 0);
    const agent = agentWithBroker(runBrokered, run);
    const result = runChild(
      baseCtx({ agent, appIntegration: approvePort, args: [...brokerArgs] }),
    );
    if (isCliAppApprovalBlocked()) {
      await expect(result).rejects.toThrow(/temporarily unavailable/i);
      expect(runBrokered).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      return;
    }
    await expect(result).resolves.toBe(0);
    expect(runBrokered).toHaveBeenCalledWith(
      [
        {
          name: "TOKEN",
          reference: "os://vault/connections%2Facme%2Fvercel/password",
        },
      ],
      ["node", "-e", "0"],
      ["TOKEN=/v2/user"],
      ["TOKEN=GET"],
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses --agent-proxy with --mount before any lane runs", async () => {
    const runBrokered = vi.fn(async () => 0);
    const run = vi.fn(async () => 0);
    const agent = agentWithBroker(runBrokered, run);
    await expect(
      runChild(
        baseCtx({
          agent,
          appIntegration: approvePort,
          args: [...brokerArgs, "--mount", "CERT=os://vault/item/cert"],
        }),
      ),
    ).rejects.toThrow(/--agent-proxy.*--mount|--mount.*--agent-proxy/);
    expect(runBrokered).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses --paths without --agent-proxy", async () => {
    const runBrokered = vi.fn(async () => 0);
    const agent = agentWithBroker(runBrokered);
    await expect(
      runChild(
        baseCtx({
          agent,
          appIntegration: approvePort,
          args: ["--env", "TOKEN=op://vault/item/field", "--paths", "TOKEN=/x"],
        }),
      ),
    ).rejects.toThrow(/--agent-proxy/);
    expect(runBrokered).not.toHaveBeenCalled();
  });
});
