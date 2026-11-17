import type { FederatedProviderSummary } from "@opensesame/app-core/lib/providers.js";

export type SignInPanelProps = (
  | {
      placement: "primary";
      providers: FederatedProviderSummary[];
      onUseLocalOnly: () => void;
    }
  | { placement: "secondary"; providers: FederatedProviderSummary[] }
) & {
  onSignedIn?: () => void;
  /** Return to a pending ceremony after a federated sign-in. */
  returnTo?: string;
  /** Same-origin callback for a link opened in another tab or device. */
  magicLinkReturnTo?: string;
};
