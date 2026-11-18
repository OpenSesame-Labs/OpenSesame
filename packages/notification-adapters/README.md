# @opensesame/notification-adapters

The Identity plane's notification channel adapters: one `ChannelAdapter`
contract and seven providers (Slack, Microsoft Teams, Telegram, WeChat, an SMS
bridge, Web Push and a generic webhook). An adapter renders a message, hands
it to a provider, and, where the provider signs its callbacks, verifies who a
callback came from. It decides nothing: settlement lives in
`@opensesame/os-domain`'s `evaluateDirectSettlement`, which is fed the facts
an adapter produced.

## Where it fits

- **Used by:** [`packages/control-plane`](../../packages/control-plane) and
  [`packages/identity-worker`](../../packages/identity-worker).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (channel kinds,
  capability records, confidentiality levels),
  [`@opensesame/webhooks`](../webhooks) (Standard Webhooks signing for the
  SMS and generic-webhook adapters, and its public-only sender for the Teams
  and generic-webhook adapters) and
  [`@opensesame/oauth-provider`](../oauth-provider) (its safe-fetcher, for
  public-only delivery).
- An adapter's capabilities come from the os-domain catalogue; no adapter
  declares its own.
- All HTTP goes through an injected `fetch`, and provenance is checked over
  the raw bytes the provider sent.
- `RenderInput` has no field for a comparison code, and requester-supplied
  text is sanitized before rendering.
- Web Push and Teams endpoints are posted to only if every resolved address is
  public, with no redirects and the connection pinned to the verified address
  (`src/public-endpoint.ts`).

## Surface

| Area | Exports |
|---|---|
| Contract (`contract.ts`) | `ChannelAdapter` (`isConfigured`, `capabilities`, `render`, `deliver`, optional `verifyCallback` and `update`), `RenderInput`, `DeliveryOutcome`, `refuse` |
| Adapters (`adapters/`) | `createSlackAdapter`, `createTeamsAdapter`, `createTelegramAdapter`, `createWeChatAdapter`, `createSmsAdapter`, `createWebPushAdapter`, `createGenericWebhookAdapter` |
| Registry (`registry.ts`) | `createAdapterRegistry` |
| Rendering (`templates.ts`) | `renderNotification`, `sanitizeUntrustedText`, length limits |
| Web Push configuration (`webpush-env.ts`) | `loadVapidIdentity`, `readVapidPublicKey`, `pushSubscriptionRefusal`, `generateVapidKeyPair` |
| Helpers | `callbackDigest`, `secretsEqual`, `bytesEqual`, base64url, `classifyHttpStatus`, `DELIVERY_TIMEOUT_MS`, `isHttpsUrl` |
| `duressAlert` | Duress alert delivery mapping and a local delivery double; delivered is not received, and received is not acknowledged |

## Develop

```bash
npm run test -w @opensesame/notification-adapters
npm run typecheck -w @opensesame/notification-adapters
npm run generate:vapid -w @opensesame/notification-adapters [mailto:you@example.com]
```

`@opensesame/notification-adapters/test-support` provides a stand-in Web Push
service (`startPushStandIn`) that verifies the VAPID token with `jws` and
decrypts `aes128gcm` with `http_ece`, plus `mintPushSubscription` for real
P-256 keys. Its API is documented at the top of
`test-support/push-standin.ts`; tests and `verify:push` import it, production
code never does.

The test-support entry point also exports `createSlackStandIn`. It implements
the `fetchImpl` seam used by the real Slack adapter and recognizes JSON
`chat.postMessage` and `chat.update` requests with a configured test bot token.
The stand-in records requests and messages, returns deterministic message
references, and signs form-encoded interactions only for buttons on a current
message. It uses WebCrypto HMAC-SHA256 over the raw form bytes; the adapter
still has to verify the signature and the claimed identity itself.

```typescript
import { createSlackAdapter } from "@opensesame/notification-adapters";
import { createSlackStandIn } from "@opensesame/notification-adapters/test-support";

const botToken = "test-bot";
const signingSecret = "test-signing-key";
const slack = createSlackStandIn({ botToken, signingSecret });
const adapter = createSlackAdapter({
  botToken,
  signingSecret,
  apiBaseUrl: slack.apiBaseUrl,
  fetchImpl: slack.fetchImpl,
});
// Deliver through adapter, then use slack.signedInteraction(...) with a
// recorded message, button, test identity, and timestamp.
slack.failNext({ kind: "http", status: 503 }); // or an API/transport failure
// The next adapter delivery receives the selected failure.
slack.reset(); // clears messages, request recordings, and queued failures
await slack.close();
```

Every instance is isolated, rejects unknown origins, and never falls back to
the network. Reset and close reject pending request bodies and ask their streams
to cancel without waiting on the producer. It models only the subset above;
it does not validate the full Slack API or prove interoperability with Slack.
A valid callback proves only that the stand-in signed those bytes, not that a human was
authenticated, that a binding matches, or that a decision was settled; replay
prevention belongs to the caller. Use synthetic credentials and decision
tokens because request and message recordings retain their bodies in memory.

The suite runs offline against recorded `fetch` calls. Provider logic belongs
in this package and nowhere else.

## Related

- [ADR 0084](../../docs/adr/0084-external-authorization-notifications.md) —
  external authorization notifications
- [`docs/operators/notification-channels.md`](../../docs/operators/notification-channels.md)
  — channel capability matrix and per-provider setup
- [`docs/security/notification-approval-threat-model.md`](../../docs/security/notification-approval-threat-model.md)
