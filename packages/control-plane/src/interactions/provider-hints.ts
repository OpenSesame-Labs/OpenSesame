import { type ProviderDescriptor, normalizeIssuer } from "./registry.js";

/**
 * Resolve a provider hint (`kc_idp_hint` / `login_hint_provider`) against the
 * offered providers, id first (T7).
 *
 * Precedence is the whole point of this function existing: the day a real
 * `google` registry id sits next to shoo.dev's "Google" label, both match the
 * hint `google`, and the id — the thing a client actually asked for — must
 * win. A matched hint is rendered first and primary and never auto-submitted:
 * an upstream error 303s back to this page, so a page that redirected itself
 * would loop forever (T14).
 */
export function matchProviderHint(
  providers: readonly ProviderDescriptor[],
  hint: string | undefined,
): ProviderDescriptor | undefined {
  const needle = (hint ?? "").trim().toLowerCase();
  if (!needle) return undefined;
  const byId = providers.find(
    (provider) => provider.id.toLowerCase() === needle,
  );
  if (byId) return byId;
  const byIssuer = providers.find(
    (provider) => normalizeIssuer(provider.issuer).toLowerCase() === needle,
  );
  if (byIssuer) return byIssuer;
  const byHost = providers.find((provider) => {
    try {
      return new URL(provider.issuer).host.toLowerCase() === needle;
    } catch {
      return false;
    }
  });
  if (byHost) return byHost;
  const byLabel = providers.find(
    (provider) => provider.label.toLowerCase() === needle,
  );
  if (byLabel) return byLabel;
  // A label that names its broker beside the account kind it fronts —
  // "Google (via shoo.dev)" — still answers to the bare account kind, so a
  // client that has always hinted `google` keeps preselecting the broker
  // when no first-party `google` id is configured.
  return providers.find((provider) =>
    provider.label.toLowerCase().startsWith(`${needle} (`),
  );
}
