/**
 * One tutorial per integration: what a section of Settings › Integrations
 * lists, and what connecting one of its providers does and does not send.
 *
 * An integration is a third party a feature connects to, configured by
 * reference on the connector's own page, so every tour here is the same walk:
 * it navigates to the page, points at the section heading, and says in a
 * closing step what a connection holds. None of them depends on the feature
 * it extends being on. The sections that already have a task-shaped tour —
 * Backups — are not repeated here; `INTEGRATION_TUTORIALS` below says
 * which tutorial an integration opens. The switches are Settings › Features,
 * and `feature-goals.ts` tours those.
 *
 * Authored, checked-in prose; compiled by the same parser and validator model
 * output goes through (ADR 0088).
 */

import type { IntegrationId } from "../../lib/capabilities/integrations.js";
import type { GuideGoalDescriptor } from "./goals.js";

export const INTEGRATION_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "integration.services",
    title: "Connect a service",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.services"',
      'say "Services groups developer APIs, productivity, communication, storage and CRM connections."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.services"',
      'focus "integration.services" "Each tile opens the service configuration page. Choose its documented authentication method and permissions there." side=bottom',
      'success "Opening this list does not authorize provider access. The connection uses its approved route when you authorize or request a provider operation."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.identity",
    title: "Connect an identity provider",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.identity"',
      'say "Connect an identity provider to let people sign in with an existing account."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.identity"',
      'focus "integration.identity" "Select a provider to open its configuration." side=bottom',
      'success "A connection\'s credential is sealed in the vault. Nothing is sent to a provider until you connect it."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.encryption",
    title: "Review encryption options",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.encryption"',
      'say "Review the available encryption options, including browser, hardware and cloud keys."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.encryption"',
      'focus "integration.encryption" "Select a provider to open its configuration." side=bottom',
      'success "Credentials for cloud key services are encrypted in your vault. Nothing is sent until you connect a provider."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.certificates",
    title: "Connect a certificate authority",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.certificates"',
      'say "Connect a certificate authority to use it with OpenSesame."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.certificates"',
      'focus "integration.certificates" "Select an authority to open its configuration." side=bottom',
      'success "Nothing is sent to an authority until you connect it. Certificates themselves are vault items, added from the vault."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.password-managers",
    title: "Connect a password manager",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.password-managers"',
      'say "Connect a supported password manager to use it alongside your vault."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.password-managers"',
      'focus "integration.password-managers" "Select a password manager to open its configuration." side=bottom',
      'success "Nothing is read from the manager until you connect it. Agents cannot read its values."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.cloud-secret-storage",
    title: "Connect a cloud secret store",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.cloud-secret-storage"',
      'say "Cloud secret storage lists the stores this installation can connect to — AWS, Azure, Google Cloud, Doppler, Vault, OpenBao and others."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.cloud-secret-storage"',
      'focus "integration.cloud-secret-storage" "Select a store to open its configuration." side=bottom',
      'success "The connection credential is encrypted in your vault. Nothing is sent to the store until you connect it."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.payments",
    title: "Connect a payment provider",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.payments"',
      'say "The Wallet\'s budgets and passes can work with providers you connect — wallet passes and card issuers. An agent is given a budget; it is never given a card number."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.payments"',
      'focus "integration.payments" "Select a provider to open its configuration." side=bottom',
      'success "Nothing is sent to a provider until you connect it, and its credential is sealed in the vault."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.password-reset",
    title: "Connect a password-reset runtime",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.password-reset"',
      'say "Password reset can use a computer-use runtime you configure. Its model provider is connected separately in AI."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.password-reset"',
      'focus "integration.password-reset" "Choose Vercel Sandbox, E2B or Browserbase CDP here. Each runtime opens its own configuration page." side=bottom',
      'success "Opening this list does not contact a provider. Configuration and each reset require your approval."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.ai",
    title: "Connect an AI provider",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.ai"',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.ai"',
      'focus "integration.ai" "Connect an agent harness or AI model provider here. Voice and inference model choices are in Settings › Features › AI." side=bottom',
      'success "A provider connection holds its configuration and a credential sealed in this vault. Nothing is sent until you connect it."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.networking",
    title: "Connect a tailnet provider",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.networking"',
      'say "Connect a provider to reach your other devices through a tailnet."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.networking"',
      'focus "integration.networking" "Select a provider to open its configuration." side=bottom',
      'success "Nothing is sent to a provider until you connect it, and its credential is sealed in the vault."',
      "end",
    ].join("\n"),
  },
];

/**
 * The tutorial each section of Settings › Integrations opens: its own tour
 * above, or the task-shaped tour that already covers it.
 */
export const INTEGRATION_TUTORIALS = {
  identity: "integration.identity",
  encryption: "integration.encryption",
  certificates: "integration.certificates",
  backups: "settings.backup",
  "password-managers": "integration.password-managers",
  "cloud-secret-storage": "integration.cloud-secret-storage",
  payments: "integration.payments",
  "password-reset": "integration.password-reset",
  ai: "integration.ai",
  networking: "integration.networking",
  services: "integration.services",
} as const satisfies Readonly<Record<IntegrationId, string>>;
