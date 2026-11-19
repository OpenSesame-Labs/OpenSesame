# UI state-machine review queue

This is a reviewed starting catalog of important Pages journeys and shared
controls, not exhaustive discovery or proof coverage. The transitions and
invariants below are proposed verification obligations: each needs its own
review of authority, state ownership, asynchronous work, and failure cases.
An entry is not a claim that the invariant already holds. The
[evidence ledger](../formal-verification/README.md) records the narrower
claims actually checked, their dependencies, and limits. In particular, a
finite model and generated tests do not prove that React refines the model.

Priority P0 identifies authority, authentication, or vault safety; P1 covers
user intent and state preservation; P2 covers shared interaction behavior.
Existing browser scripts named below are available evidence mechanisms, not
assertions that they passed on a particular commit or exercise every edge.

## Authentication and consent

### P0: Front door, passkey ceremony, and vault session

- **Entry and transitions:** `apps/pages/src/screens/UnlockScreen.tsx` chooses
  the front door, setup, vault selection, or unlock form. Its
  `unlock/use-passkey-ceremony.ts` starts, cancels, and changes authenticator
  attachment; `packages/app-core/src/lib/vault/store-unlock-session.ts` owns
  unlock-session retirement. Transitions include empty/locked, busy, second
  step, open, cancelled, failed, and a switch to a different vault.
- **Candidate invariants:** a retired attempt cannot open the current vault;
  changing method or leaving cancels the prompt and clears held ceremony
  material; a failed or cancelled ceremony does not claim success; guest and
  setup choices remain reachable when their conditions apply.
- **Evidence and gap:** `VaultInteraction.tla` and
  `packages/app-core/src/lib/vault/vault-interaction.property.test.ts` cover a
  bounded retired-attempt/lease abstraction, not the full screen or WebAuthn.
  `UnlockScreen.held-root.test.tsx` and `UnlockScreen.guest.test.tsx` exercise
  examples; `apps/pages/scripts/verify-auth-flow.mjs` is a browser journey.
  Missing: a model covering screen selection, second-step cancellation,
  authenticators, and vault switches together, with actual asynchronous browser
  outcomes and a justified implementation refinement.

### P0: Federated sign-in and callback

- **Entry and transitions:**
  `packages/app-core/src/browser/oidc/transaction.ts` prepares and completes a
  configured OIDC transaction; `packages/app-core/src/lib/federation-pending.ts`
  manages the legacy pending record. Starts, callbacks, cancellation, expiry,
  duplicate responses, logout, and concurrent attempts affect whether exchange
  may begin.
- **Candidate invariants:** a mismatched, expired, retired, or consumed attempt
  cannot start an exchange; a completion belongs to the transaction and owner
  that initiated it; rejection does not silently authenticate another session.
- **Evidence and gap:** `spec/auth-verification/AuthAdmission.lean` proves an
  abstract exchange-admission decision; `LegacyPkcePending.tla` checks the
  separate legacy pending-slot abstraction, and their paired property tests
  exercise selected TypeScript behavior. `verify-provider-auth.mjs` is a
  browser/provider harness. Missing: a composed UI-to-callback state machine
  and implementation refinement, including browser storage races, session
  creation, actual provider behavior, and complete OAuth/OIDC conformance.

### P0: Local application and agent consent

- **Entry and transitions:**
  `apps/pages/src/modules/identity.local-iam/AuthorizeConsentScreen.tsx` and
  `apps/pages/src/screens/useLocalConsent.ts` parse and load an application
  request, select a person, verify a passkey, approve or deny, and expose
  waiting/connected/approved/active/closed status. A request or vault change
  retires the previous hook generation and channel.
- **Candidate invariants:** invalid registration, redirect, scopes, or agent
  cannot be approved; approval follows a current verified session and explicit
  consent; denial or retirement cannot later authorize through a stale result;
  a closed session is not represented as active.
- **Evidence and gap:** `apps/pages/scripts/verify-local-iam.mjs` contains a
  browser flow for person and agent approval, denial, session check, and
  revocation. No matching model or generated sequence test for this whole
  consent screen is registered in the reviewed ledger. Add adversarial
  cancellation, changed-request, duplicate-click, and late-result coverage;
  verify the actual issuer/channel boundary separately.

### P0: Access-request approval

- **Entry and transitions:**
  `apps/pages/src/sections/access/RequestApproval.tsx` presents an approver and
  optional code for a pending request;
  `packages/app-core/src/sections/access/request-approval-model.ts` invokes
  the duress gate and submits approve/deny decisions. The row can become
  decided or disappear while a decision is in progress.
- **Candidate invariants:** only an eligible person may decide a still-pending
  request; refused or duress-gated approval does not submit; the decision is
  bound to the reviewed request and cannot be consumed twice.
- **Evidence and gap:** `LocalRequestsPanel.test.tsx` exercises rendered
  approval examples and `apps/pages/scripts/verify-local-iam.mjs` includes a
  local request journey. No whole approval state-machine model or generated
  UI/interleaving property is registered in the reviewed ledger. A model must
  include policy changes, concurrent decisions, and transaction binding rather
  than assuming a UI selection conveys authority.

## Navigation and user intent

### P1: Support context and walkthrough routing

- **Entry and transitions:** `apps/pages/src/tutorial/use-support-route.ts`
  observes router location and optional route contributions, synchronizes
  support context, accepts a gate override, and installs a guide navigator.
  Contributions may appear or disappear after arrival.
- **Candidate invariants:** context updates alone do not navigate; GitHub
  setup keeps its own context before its optional route loads; unrelated
  siblings do not inherit it; a gate is not entered by guide navigation.
- **Evidence and gap:** `TutorialRoute.tla` checks a finite, settled-effects
  abstraction; `tutorial-route.property.test.tsx` drives the real hook with
  generated sequences; `verify-tutorials.mjs` walks authored tours in a
  browser. The model does not cover every route, the guide compiler, first-visit
  eligibility, arbitrary interleavings of React effects, or user cancellation
  in a running tour. Add explicit properties for those boundaries.

### P1: Shell navigation and capability removal

- **Entry and transitions:** `apps/pages/src/components/AppShell.tsx` and
  `packages/app-core/src/webmcp/navigation.ts` handle visible section routes
  and capability-checked navigation. People may navigate while optional
  sections are added or removed; removal can invalidate the current section.
- **Candidate invariants:** an explicit valid navigation is not mistaken for
  removal; loss of the current capability does not leave its controls usable;
  navigation offered to an agent remains subject to the current capability
  lease and does not expose unavailable routes.
- **Evidence and gap:** `AppShell.route-fallback.test.tsx` covers explicit
  navigation versus removal examples; `webmcp/navigation.test.ts` exercises
  navigation authority. No composed shell/lease state-machine model or
  generated registration-and-navigation sequences are registered in the
  reviewed ledger. Add browser checks for focus and destination after removal.

## Vault editing and persistence

### P1: Draft, save, cancel, and update

- **Entry and transitions:** `apps/pages/src/sections/vault/ItemEditor.tsx`
  creates or edits a draft, changes type and fields, saves, reports errors,
  and registers a draft saver. Navigation, lock, a route change, or a waiting
  service-worker update can occur while an edit is dirty.
- **Candidate invariants:** an invalid or failed save does not report success;
  the latest intended values are saved at most once per accepted operation;
  navigation or update cannot silently substitute a different draft or discard
  unsaved work without the defined user choice.
- **Evidence and gap:** `ItemEditor.routes.test.tsx` covers representative
  drafts and invalid saves; `verify-sw-dirty-edit.mjs` exercises one real
  update-during-edit journey. No model or generated interleaving tests for the
  entire editor/update lifecycle are registered in the reviewed ledger. Include
  lock, failed persistence, changing item and delayed save completion.

### P1: Import and restore

- **Entry and transitions:** `apps/pages/src/sections/vault/import/ImportSheet.tsx`
  and `packages/app-core/src/sections/vault/import/model.ts` interpret a chosen
  source, show a preview or credential step, apply an import, and report
  success or failure. The source may be replaced or the sheet closed while work
  is pending.
- **Candidate invariants:** preview and commit refer to the chosen source and
  current vault; closing or repicking prevents stale work from presenting a
  successful import; failed parsing, unlock, or apply does not claim success.
- **Evidence and gap:** `ImportSheet.stale.test.tsx` distinguishes a stale
  build from wrong credentials; `ImportSheet.imported.test.tsx` and
  `model.test.ts` cover examples. No combined source/preview/apply model or
  generated race suite is registered in the reviewed ledger. Add a browser
  journey for repick and cancellation during a delayed import.

### P1: GitHub backup configuration and activation

- **Entry and transitions:**
  `apps/pages/src/sections/connections/BackupEnableSwitch.tsx` reflects the
  configured local backup target managed by
  `packages/app-core/src/lib/backup.ts`. A target may be created, changed,
  enabled, disabled, deleted, or have a sync confirmation recorded.
- **Candidate invariants:** an absent target is shown off; ordinary creation
  starts off; replacing a binding does not retain its old sync confirmation;
  an enabled indicator alone does not assert that remote credentials work or
  that a backup has succeeded.
- **Evidence and gap:** `GitHubConnection.tla` models local target operations;
  `github-connection-lifecycle.property.test.ts` and
  `BackupEnableSwitch.lifecycle.property.test.tsx` exercise generated local
  transitions. `verify-github-app-browser.mjs` uses an independent local
  provider fixture. The model does not establish remote authorization, sync
  success, or truthfulness across all asynchronous provider failures; add those
  observations and their lifecycle to the verification plan.

## Shared primitives

### P1: Transient notification reading and expiry

- **Entry and transitions:** `apps/pages/src/components/ToastStack.tsx` shows
  a notice, tracks pointer and keyboard reading, pauses and resumes its timer,
  and removes it on dismissal or expiry. A user may move the pointer away
  while a keyboard control is still focused, or leave focus while hovering.
- **Candidate invariants:** time does not run out while either reading state
  is active; dismissal does not run the notice action; the remaining time is
  preserved across a pause; a notice remains identifiable and dismissible.
- **Evidence and gap:** `ToastReading.tla` checks a finite abstraction of
  reading, time, same-card interval restart and dismissal;
  `ToastStack.reading.test.tsx` exercises the React timer with generated
  interaction sequences. A prerelease fault control checks that TLC rejects a
  timer that runs while only one input is reading and an update that keeps the
  old remaining time. Neither proves the implementation, browser event
  delivery, screen-reader announcements, notification-tray persistence, every
  layout, or liveness.

### P1: Gate notification arrival and attention

- **Entry and transitions:** `apps/pages/src/components/Notices.tsx` and
  `NoticeCorner.tsx` surface errors and claim notices while a gate is open.
  Notices arrive, are focused, replaced, dismissed, or remain in the tray;
  unrelated notices can arrive at the same time.
- **Candidate invariants:** a focused notice keeps its own actions when a
  newer one arrives; an unrelated arrival does not erase the latest claim;
  a gate notification does not acquire a second overlay of the same message.
- **Evidence and gap:** `NoticeCorner.behavior.test.tsx` exercises selected
  arrival sequences, focus changes and tray retention in the real components.
  The ledger has no TLA+ model or implementation proof for this lifecycle;
  add one that accounts for concurrent delivery and browser accessibility.

### P2: Connector method and controlled capability switch

- **Entry and transitions:**
  `apps/pages/src/sections/connections/connect/ConnectorModes.tsx` selects a
  provider method; `apps/pages/src/sections/settings/CapabilitySwitch.tsx`
  requests a change whose owner may accept or reject it. Pointer, keyboard,
  disabled fieldset, and isolated SDK-agent actions can initiate attempts.
- **Candidate invariants:** blocked modes and disabled switches make no
  request; a rejected controlled change does not claim a new value; one
  enabled action produces the intended selection or one request.
- **Evidence and gap:** `ConnectorModes.tla` and `SharedControl.tla` have
  paired React property tests and Bombadil fixture properties under
  `apps/pages/test/ui-properties/`. SDK agent discovery is tested in isolation.
  Missing: production-authorized SDK action integration, async parent
  persistence/lease behavior, assistive-technology combinations, and a proof of
  the SDK, React, or browser implementation.

### P2: Modal focus and roving tabs

- **Entry and transitions:** `apps/pages/src/lib/modal-focus.ts` moves focus on
  opening and handles Tab, Escape, and closing stacked sheets;
  `apps/pages/src/screens/use-roving-tabs.ts` manages tab selection and focus
  on arrows, Home, and End.
- **Candidate invariants:** opening chooses usable focus, Tab remains within
  the active modal, Escape closes only the top eligible surface, closing
  restores a valid trigger, and a tablist has one reachable selected stop.
- **Evidence and gap:** `apps/pages/src/lib/modal-focus.test.tsx` covers
  examples and `apps/pages/scripts/verify-keyboard.mjs` is a browser keyboard
  gate. The reviewed ledger registers `RovingTabs.tla`, a generated React
  sequence test and a Bombadil keyboard fixture (`tabsCoverage` requires Left,
  Right, Home and End) for a stable, enabled tablist; they assume the parent
  accepts selection. There is no paired formal model and generated sequence
  suite for nested modals or dynamically changing tab sets. Include removed
  or disabled triggers and focus targets in further checks.
