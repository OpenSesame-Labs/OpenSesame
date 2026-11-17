import {
  CHANNEL_CAPABILITIES,
  type NotificationChannelKind,
} from "@opensesame/os-domain";
import type {
  ChannelAdapter,
  ChannelDeliverInput,
  ChannelDeliveryOutcome,
  ChannelRenderInput,
  ChannelUpdateInput,
} from "../notifications.js";

export interface TestChannelOptions {
  configured?: boolean;
  outcome?: ChannelDeliveryOutcome;
  /** One result or exception per send. Exhaustion throws instead of silently succeeding. */
  deliveryScript?: readonly (ChannelDeliveryOutcome | Error)[];
  throwOnDeliver?: boolean;
  throwOnRender?: boolean;
  canUpdate?: boolean;
  throwOnUpdate?: boolean;
}

export interface TestChannelAdapter extends ChannelAdapter {
  readonly rendered: readonly ChannelRenderInput[];
  readonly sent: readonly ChannelDeliverInput[];
  readonly updated: readonly ChannelUpdateInput[];
  /** Clear recordings and rewind the delivery script. */
  reset(): void;
  /** Clear recordings and refuse further use. */
  close(): Promise<void>;
}

/** In-process worker port double. It does not model a provider's wire protocol. */
export function createTestChannelAdapter(
  kind: NotificationChannelKind,
  options: TestChannelOptions = {},
): TestChannelAdapter {
  if (options.deliveryScript && (options.outcome || options.throwOnDeliver)) {
    throw new Error(
      "deliveryScript cannot be combined with outcome or throwOnDeliver",
    );
  }
  const script = options.deliveryScript?.map((step) =>
    step instanceof Error ? step : structuredClone(step),
  );
  const { throwOnDeliver, throwOnRender, canUpdate, throwOnUpdate } = options;
  const configured = options.configured !== false;
  const outcome = options.outcome
    ? structuredClone(options.outcome)
    : undefined;
  const rendered: ChannelRenderInput[] = [];
  const sent: ChannelDeliverInput[] = [];
  const updated: ChannelUpdateInput[] = [];
  let nextDelivery = 0;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("test channel adapter is closed");
  };
  const reset = () => {
    assertOpen();
    rendered.length = 0;
    sent.length = 0;
    updated.length = 0;
    nextDelivery = 0;
  };
  const adapter: TestChannelAdapter = {
    kind,
    rendered,
    sent,
    updated,
    isConfigured: () => {
      assertOpen();
      return configured;
    },
    capabilities: () => {
      assertOpen();
      return structuredClone(CHANNEL_CAPABILITIES[kind]);
    },
    render: (input) => {
      assertOpen();
      rendered.push(structuredClone(input));
      if (throwOnRender) throw new Error("render exploded");
      // This fake does not know how to apply the real channel's disclosure
      // rules to arbitrary outbox payloads. Keep every level conservative.
      return {
        eventType: input.eventType,
        confidentiality: input.confidentiality,
      };
    },
    deliver: async (input) => {
      assertOpen();
      sent.push(structuredClone(input));
      if (!configured) {
        return { ok: false, retryable: false, error: "unconfigured" };
      }
      if (throwOnDeliver) throw new TypeError("socket hang up");
      if (script) {
        const step = script[nextDelivery++];
        if (!step) throw new Error("test channel delivery script exhausted");
        if (step instanceof Error) throw step;
        return structuredClone(step);
      }
      return structuredClone(
        outcome ?? { ok: true, providerMessageRef: `ref_${kind}` },
      );
    },
    reset,
    close: async () => {
      if (!closed) {
        reset();
        closed = true;
      }
    },
  };
  if (canUpdate !== false) {
    adapter.update = async (input) => {
      assertOpen();
      updated.push(structuredClone(input));
      if (!configured) throw new Error("test channel adapter is unconfigured");
      if (throwOnUpdate) throw new Error("provider 500: <html>...");
    };
  }
  return adapter;
}
