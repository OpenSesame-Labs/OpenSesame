import {
  type VaultBody,
  VaultCorruptError,
  type VaultHeader,
  WrongPasswordError,
  emptyBody,
  importVaultKey,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import {
  noteVaultBodyPersisted,
  recordActivityEvent,
} from "../activity-log.js";
import {
  DECOY_SCRATCH_TOMB,
  isGuestSessionTomb,
  markDecoySession,
} from "../duress/store/decoy-scratch.js";
import { createDuressVaultActivationHost } from "../duress/store/vault-activation-host.js";
import { sessionRootDigestFromKey } from "../duress/store/vault-session-digest.js";
import { guestEpochGuard } from "../guest-return-epoch.js";
import { activateGuestTomb } from "../guest-session-context.js";
import { isGuestVaultId, isIsolatedGuestVaultId } from "../guest-vault-id.js";
/** Vault session store: unlocked body in memory, sealed to OPFS, key dropped on lock (ADR 0063). */
import { kvDelete } from "../kv.js";
import { lastGuestVaultId, writeLastVaultId } from "../last-vault.js";
import {
  type GuestSessionPerson,
  activateIsolatedGuestPerson,
} from "../local-guest.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  deleteFile,
  deletePlaintextFile,
  lockTomb,
  readPlaintextFile,
  readSealedFile,
  unlockTomb,
} from "../vfs.js";
import { type TombWriteTurn, withTombWriteTurn } from "../vfs-write-order.js";
import { stampedEdit } from "./body-edits.js";
import { recoverLiveGuestPromotion } from "./guest-vault-promotion.js";
import { headerCarriesGate } from "./header-gate.js";
import { type ItemWriteHost, originalItemWriteHost } from "./item-writes.js";
import {
  announceVaultDestroyed,
  emitVaultLock,
  onVaultDestroyed,
} from "./lock-events.js";
import {
  adoptedMasterWrap,
  headerWithoutPassword,
  noteMasterWrap,
  wrapMoved,
} from "./master-wrap.js";
import { bindNewVaultMaterialHeader } from "./new-factor-bound-material-data.js";
import { withNewVaultScopeGuard } from "./new-vault-scope-guard.js";
import * as PeerBodyRefresh from "./ordinary-peer-body-refresh.js";
import {
  sealNewVaultWithPasskey,
  wrapVaultKeyWithCeremony,
} from "./passkey-unlock-session.js";
import type { PasskeyCreateOptions } from "./protection/adapters/webauthn-prf-ceremony.js";
import { VaultProtectionBrowserService } from "./protection/browser-service.js";
import { ProtectionError } from "./protection/errors.js";
import { ProtectionSessionGuard } from "./protection/session-guard.js";
import { spendRecoveryCode } from "./recovery-codes.js";
import { type SentCode, sendCode, verifyCode } from "./remote-code.js";
import { RetiredInteractionQueue } from "./retired-interaction-queue.js";
import type { RetiredLoginData } from "./retired-login-operation.js";
import { carryForkUnlockedIntoActiveScope } from "./scope-carry-fork.js";
import { carryOpenActiveScopeWithCurrentKey } from "./scope-carry-open.js";
import { rekeyTomb } from "./seal-rebind.js";
import {
  CodeSendGuard,
  assertSecondStepPending,
  finishSecondStepUnlock,
} from "./second-step-guard.js";
import {
  heldTotpCode,
  withSelfAuthenticatorRegistration,
} from "./self-authenticator.js";
import { loadVaultBody } from "./store-body.js";
import {
  applyStoreBodyChange,
  refreshedStoreBody,
  withFreshStoreBody,
} from "./store-body-writes.js";
import { createStoreCredentialApi } from "./store-credential-api.js";
import * as StoreDeviceKey from "./store-device-key.js";
import type { FreshBody } from "./store-fresh.js";
import * as GuestMaterial from "./store-guest-material.js";
import {
  guestProtectionActive,
  protectGuestTomb,
} from "./store-guest-protection.js";
import {
  guestScopeAfterLock,
  retireEphemeralStorage,
} from "./store-guest-scope.js";
import {
  deviceHoldsSealedVault,
  readTombHeader,
  sharesWrapRecord,
} from "./store-header.js";
import * as HeaderPublication from "./store-header-publication.js";
import { seedHoneyVault } from "./store-honey.js";
import { bindSealedImport } from "./store-import-entry.js";
import { createStoreItemOperations } from "./store-item-operations.js";
import {
  type DriveSnapshotInput,
  type SealedSnapshot,
  type SnapshotMerge,
  mergeSnapshotInto,
} from "./store-merge.js";
import { initializeNewVaultFiles } from "./store-new-vault-persistence.js";
import { acquireGuestAwareLease } from "./store-open-lease.js";
import {
  captureStoreOperation,
  requireExistingUnlock,
} from "./store-operation-check.js";
import { StorePreferences } from "./store-preferences.js";
import { createStorePreferencesApi } from "./store-preferences-api.js";
import { buildVaultState, exportStoredVault } from "./store-presentation.js";
import { createStorePrimaryApi } from "./store-primary-api.js";
import { retiredPasswordLogin } from "./store-retired-login.js";
import { writeBody } from "./store-seal.js";
import { createStoreSecondStepApi } from "./store-second-step-api.js";
import * as TombDestruction from "./store-tomb-destruction.js";
import { StoreListeners, StoreView } from "./store-view.js";
import { StoreWriteQueue } from "./store-write-queue.js";
import { discardTombCaches } from "./tomb-migration.js";
import {
  type CodeChannel,
  type TotpGateRecord,
  type VaultUnlocks,
  createPasskeyUnlockCeremony,
  hasSecondStep,
  headerWithoutUnlock,
  openText,
  openTotpSecret,
  totpCodeMatches,
} from "./unlock-methods.js";
import { withBodyWriteLockOrBare } from "./vault-shared-locks.js";

export { PREFS_CONFIG_PATH, PREFS_SOURCE_CONFIG_PATH } from "./prefs-io.js";
/** Guest-beside-vault tomb — isolated, throwaway, never a project id. */
export { GUEST_TOMB, deviceHoldsSealedVault, readTombHeader, sharesWrapRecord };

import { PIN_MISS, unwrapPassword, unwrapPin } from "./primary-unwrap.js";
import {
  ATTEMPTS_KEY,
  type VaultScope,
  guestVaultScope,
  scopedVaultScope,
} from "./store-scope.js";
import {
  assertNotLockedOut,
  readAttempts,
  recordFailedUnlock,
} from "./unlock-attempts.js";

export {
  VAULT_PREFS_REVISION,
  type VaultPrefs,
  assertMasterPasswordPolicy,
  defaultPrefs,
  normalizeVaultPrefs,
} from "./prefs.js";
export { ATTEMPTS_KEY };

import { installVaultStoreBoot } from "./store-boot.js";
import { type VaultState, bindGuestSessionStore } from "./store-state.js";
import {
  StoreUnlockSession,
  type UnlockAttempt,
} from "./store-unlock-session.js";

export type { VaultState, VaultStatus } from "./store-state.js";

import type {
  LocalCanaryCommand,
  LocalCanaryResult,
  LocalRetiredCommand,
  LocalRetiredInspection,
  LocalVaultPrimary,
  LocalVaultStarted,
} from "@opensesame/vault-core/local-vault-security.js";
import { copyCapturedOwnerPrimaryRequest } from "./captured-owner-primary-request.js";
import {
  RetiredOperationEntries,
  RetiredOperationExchange,
  copyRetiredCommand,
} from "./retired-operation-exchange.js";
import { copyRetiredOwnerCanaryCommand } from "./retired-owner-canary.js";
import {
  type RetiredOwnerAuthenticationInput,
  runRetiredOwnerAuthentication,
  runRetiredOwnerOperation,
} from "./retired-owner-operation.js";
import {
  presentRetiredOwnerStarted,
  retireRetiredOwnerTask,
} from "./retired-owner-presentation.js";

export class VaultStore {
  readonly #retiredEntries = new RetiredOperationEntries();
  readonly #canaryEntries = new RetiredOperationEntries<LocalCanaryResult>();
  #vaultKey: CryptoKey | null = null;
  /** Raw VK for enroll-only wrapKey substitutes; wiped on lock and cancel. */
  #rawVaultKey: Uint8Array | null = null;
  /** Primary unwrap succeeded; waiting on optional TOTP before activating. */
  #pendingVaultKey: CryptoKey | null = null;
  /** A seed offered for enrollment; discarded unless a code confirms it. */
  #pendingTotpSecret: string | null = null;
  /** A code the Identity API sent and has not yet been asked about. */
  #pendingCode: SentCode | null = null;
  /** The address a code enrollment is confirming, until its first code matches. */
  #pendingCodeAddress: { channel: CodeChannel; to: string } | null = null;
  #body: VaultBody = emptyBody();
  #header: VaultHeader | null = null;
  #preferences = new StorePreferences();
  #preferencesApi = createStorePreferencesApi({
    preferences: this.#preferences,
    open: () => this.#vaultKey !== null,
    tomb: () => this.#scope.tomb,
    changed: () => {
      this.#persistPrefs();
      this.#armIdleTimer();
      this.#emit();
    },
  });
  #view = new StoreView();
  #primaryApi = createStorePrimaryApi(() => this.#passkeyUnlockHost());
  #credentialApi = createStoreCredentialApi({
    context: () => this.#protectionOperation().context,
    header: () => this.#header,
    raw: () => this.#requireRaw(),
    unlockedHeader: () => this.#requireUnlocked().header,
    allowMutation: () => {
      if (this.#retiredSynthetic) this.#requireGenuineSession();
    },
    allowCreation: () => this.#requireEmptyVault(),
    tomb: () => this.#scope.tomb,
    publishHeader: (header, check) => this.#persistHeader(header, check),
    publishNew: (header, key, raw, check) =>
      this.#persistNewVault(header, key, raw, check),
  });

  #secondStepApi = createStoreSecondStepApi({
    requireUnlocked: () => this.#requireUnlocked(),
    ephemeral: () => this.#ephemeral,
    totpSecret: () => this.#pendingTotpSecret,
    setTotpSecret: (secret) => {
      this.#pendingTotpSecret = secret;
    },
    pendingCode: () => this.#pendingCode,
    setPendingCode: (code) => {
      this.#pendingCode = code;
    },
    pendingCodeAddress: () => this.#pendingCodeAddress,
    setPendingCodeAddress: (address) => {
      this.#pendingCodeAddress = address;
    },
    persistHeader: (header) => this.#persistHeader(header),
    registerSelfAuthenticator: (gate) => this.#registerSelfAuthenticator(gate),
    header: () => this.#header,
    trashItem: (id) => this.trashItem(id),
    cancelCodeEnrollment: () => this.cancelCodeEnrollment(),
  });
  #unlockSession = new StoreUnlockSession({
    scope: () => this.#scope,
    original: () => this.#protectionOperation(),
    close: () => this.lock({ recordLastVault: false }),
    frozen: () => this.#refuseWhileFrozen(),
    clearPending: () => {
      this.#pendingVaultKey = null;
    },
    setKey: (key) => {
      this.#vaultKey = key;
    },
    loadBody: (id, key, check) => loadVaultBody(id, key, this.#header, check),
    setBody: (body, mark) => {
      this.#body = body;
      this.#sealMark = mark;
      syncInstalledTypes(body.itemTypes);
    },
    setGuestPerson: (person, epoch) => {
      this.#guestPerson = person;
      this.#guestIdentityOwner = activateIsolatedGuestPerson(person);
      activateGuestTomb(this.#scope.tomb, epoch, !person || !!person.localOnly);
    },
    bodyPort: () => this.#bodyPort(),
    preferences: this.#preferences,
    protection: () => this.#protection,
    acquire: (tomb) => this.#acquireSessionLease(tomb),
    commit: (lease) => this.#commitSessionLease(lease),
    emit: () => this.#emit(),
    completed: () => {
      this.touch();
      this.#armIdleTimer();
      this.#emit();
    },
  });
  #sendGuard = new CodeSendGuard();
  /** Serializes body writes so overlapping mutations cannot land out of order. */
  #writeQueue = new StoreWriteQueue();
  #openLease: { tomb: string; release: () => Promise<void> } | null = null;
  #stopDestroyWatch: (() => void) | null = null;
  #itemOperations = createStoreItemOperations({
    body: () => this.#body,
    items: () => this.getSnapshot().items,
    mutate: (change) => this.#mutate(change),
    writes: (check) => this.#writes(check),
  });
  /** The seal of the body this tab last wrote or read; another writer's differs. */
  #sealMark: string | null = null;
  #lockHandlers = new StoreListeners();
  #scope: VaultScope = scopedVaultScope();
  /** Guest/this-tab: key never wrapped; lock must not leave a wrap-less header. */
  #ephemeral = false;
  #guestPerson: GuestSessionPerson | null = null;
  #guestIdentityOwner: symbol | null = null;
  #guestVfsOwner: symbol | null = null;
  #guestDestroyRetry = new TombDestruction.GuestDestroyRetry();
  #retiredInteractions = new RetiredInteractionQueue();
  #retiredSynthetic: { data: RetiredLoginData; origin: VaultScope } | null =
    null;
  #sessionGuard = new ProtectionSessionGuard();
  #protection: VaultProtectionBrowserService;

  constructor() {
    this.#header = this.#readHeader();
    StoreDeviceKey.registerBodyPort(this, () => this.#bodyPort());
    this.#protection = new VaultProtectionBrowserService({
      isGuestOrEphemeral: () =>
        this.#ephemeral || isGuestSessionTomb(this.#scope.tomb),
      getHeader: () => this.#header,
      requireRawRoot: () => this.#requireRaw(),
      isUnlocked: () => this.#vaultKey !== null && this.#header !== null,
      persistHeader: (next, check, turn) =>
        this.#persistHeader(next, check, turn),
      replaceRawVaultKey: (next, check, turn) =>
        this.#replaceRawVaultKey(next, check, turn),
      withRootWriteTurn: (work, check) => this.#withRootWriteTurn(work, check),
      session: this.#sessionGuard,
    });
    this.#view.publish(this.#build());
  }

  /** Root-protection lifecycle for the active vault session. */
  get protection(): VaultProtectionBrowserService {
    return this.#protection;
  }

  /** Re-read plaintext state after OPFS hydration fills the KV cache. */
  rehydrate(): void {
    if (
      this.#vaultKey ||
      this.#pendingVaultKey ||
      this.#unlockSession.trustedKey
    )
      return;
    // Reload opens the last authorized account's unlock — guest included. Its
    // header is read like any tomb's; `headerCarriesGate` keeps a wrap-less
    // guest record from posing as a locked vault.
    const guest = lastGuestVaultId();
    this.#scope = guest ? guestVaultScope(guest) : scopedVaultScope();
    const header = this.#readHeader();
    this.#header = guest && !headerCarriesGate(header) ? null : header;
    this.#emit();
  }

  /** Drop the previous project session and read the active project's header. */
  loadActiveProjectScope(): void {
    // Explicit project swap — lock() must not keep the destination tomb as last-vault.
    this.lock({ recordLastVault: false });
    this.#scope = scopedVaultScope();
    this.#header = this.#readHeader();
    writeLastVaultId(this.#scope.tomb);
    this.#emit();
  }

  /** Carry this unlock into the active project (shared device key). */
  async forkUnlockedIntoActiveScope(): Promise<void> {
    if (this.#retiredSynthetic) this.#requireGenuineSession();
    await carryForkUnlockedIntoActiveScope({
      vaultKey: this.#vaultKey,
      header: this.#header,
      ephemeral: this.#ephemeral,
      scope: this.#scope,
      sessionRootDigest: () => this.#sessionRootDigest(),
      assignScope: (next) => {
        this.#scope = next;
      },
      assignHeader: (next) => {
        this.#header = next;
      },
      assignBody: () => {
        this.#body = emptyBody();
      },
      clearPendingVaultKey: () => {
        this.#pendingVaultKey = null;
      },
      persistPrefs: () => this.#persistPrefs(),
      persist: () => this.#persist(),
      touch: () => this.touch(),
      armIdleTimer: () => this.#armIdleTimer(),
      emit: () => this.#emit(),
      nextScope: scopedVaultScope,
    });
  }

  activeTomb(): string {
    return this.#scope.tomb;
  }

  /** Await in-flight body persists before duress activation or scope carries. */
  async flushPendingWrites(): Promise<void> {
    await this.#writeQueue.pending().catch(() => undefined);
    await this.#retiredInteractions.drain();
  }

  #sessionRootDigest = (): Promise<string | null> =>
    sessionRootDigestFromKey(this.#vaultKey, this.#ephemeral);

  /** Host surface for duress activation coordination (STORE-E). */
  duressActivationHost() {
    return createDuressVaultActivationHost({
      activeTomb: () => this.#scope.tomb,
      ephemeral: () => this.#ephemeral,
      header: () => this.#header,
      vaultKey: () => this.#vaultKey,
      flushPendingWrites: () => this.flushPendingWrites(),
      cancelPendingOps: () => this.#protection.cancelPendingOps(),
      sessionGeneration: () => this.#sessionGuard.generation,
    });
  }

  /** Equal wrap material means this session's key also opens `other`. False while locked. */
  sharesKeyWith(other: VaultHeader | null): boolean {
    if (!this.#vaultKey || !this.#header || !other) return false;
    if (this.#ephemeral) return false;
    return sharesWrapRecord(this.#header, other);
  }

  /** Open the active project when wraps match; lock the previous tomb first. */
  async openActiveScopeWithCurrentKey(): Promise<void> {
    if (this.#retiredSynthetic) this.#requireGenuineSession();
    await carryOpenActiveScopeWithCurrentKey({
      cancelPendingOps: () => this.#protection.cancelPendingOps(),
      vaultKey: this.#vaultKey,
      header: this.#header,
      ephemeral: this.#ephemeral,
      scope: this.#scope,
      body: this.#body,
      sessionRootDigest: () => this.#sessionRootDigest(),
      lockHandlers: [...this.#lockHandlers],
      activateSession: (key) => this.#unlockSession.activate(key),
      assignScope: (next) => {
        this.#scope = next;
      },
      assignHeader: (next) => {
        this.#header = next;
      },
      assignBody: (next) => {
        this.#body = next;
      },
      assignVaultKey: (key) => {
        this.#vaultKey = key;
      },
      emit: () => this.#emit(),
      nextScope: scopedVaultScope,
    });
  }

  #readHeader = (): VaultHeader | null => readTombHeader(this.#scope.tomb);

  #persistPrefs(): void {
    if (!this.#vaultKey) return;
    this.#writeQueue.persistPreferences(
      this.#preferences,
      this.#scope.tomb,
      () => this.#scope.tomb,
      () => {
        this.#armIdleTimer();
        this.#emit();
      },
    );
  }

  #build(): VaultState {
    return buildVaultState({
      header: this.#header,
      open: this.#vaultKey !== null,
      pending: this.#pendingVaultKey !== null,
      ephemeral: this.#ephemeral,
      tomb: this.#scope.tomb,
      body: this.#body,
      prefs: this.#preferences.prefs,
      attempts: readAttempts(this.#scope.attempts),
      trustedUnlock: this.#unlockSession.trustedView,
    });
  }

  #emit = (): void => this.#view.publish(this.#build());

  subscribe = this.#view.subscribe;
  getSnapshot = this.#view.getSnapshot;

  // —— session ——————————————————————————————————————————————

  #stashRaw(raw: Uint8Array): void {
    this.#zeroRaw();
    this.#rawVaultKey = raw;
  }

  #zeroRaw(): void {
    this.#rawVaultKey?.fill(0);
    this.#rawVaultKey = null;
  }

  #requireRaw = (): Uint8Array => {
    if (this.#retiredSynthetic) this.#requireGenuineSession();
    return PeerBodyRefresh.requireOriginalRawRoot(this.#rawVaultKey);
  };

  /** Captures cancellation and original state only, never owner authority. */
  #protectionOperation(check?: () => void) {
    return captureStoreOperation(
      () => ({
        scope: this.#scope,
        session: this.#sessionGuard,
        key: this.#vaultKey,
        raw: this.#rawVaultKey,
        header: this.#header,
      }),
      check,
    );
  }

  #withRootWriteTurn(
    work: (turn: TombWriteTurn) => Promise<void>,
    check?: () => void,
  ): Promise<void> {
    const original = this.#protectionOperation(check);
    return this.#writeQueue.rootTurn(
      original.scope.tomb,
      () => this.#refreshBody(original),
      work,
      original.context,
      () => original.closeOriginal(() => this.lock()),
    );
  }

  /** Root-rotate: re-seal the tomb's files and the body under the new VK. */
  async #replaceRawVaultKey(
    next: Uint8Array,
    check?: () => void,
    turn?: TombWriteTurn,
  ): Promise<void> {
    const { vaultKey: previous } = this.#requireUnlocked(
      "rotating the vault key",
    );
    const original = this.#protectionOperation(check);
    const vaultKey = await rekeyTomb(
      original.scope.tomb,
      previous,
      next,
      original.active,
      turn,
    );
    original.active();
    if (this.#vaultKey !== previous)
      throw new ProtectionError(
        "stale_operation",
        "Original vault root changed.",
      );
    original.adoptRoot(() => {
      this.#stashRaw(next.slice());
      this.#vaultKey = vaultKey;
    });
    await this.#persist(original.active, turn);
    original.active();
  }

  create = this.#credentialApi.create;

  /** First-run seal under a passkey PRF wrap — no master password required. */
  async createWithPasskey(
    signal?: AbortSignal,
    options?: PasskeyCreateOptions,
  ): Promise<void> {
    this.#requireEmptyVault();
    const original = this.#protectionOperation();
    await sealNewVaultWithPasskey(
      (header, key, raw) => {
        original.active();
        return withNewVaultScopeGuard(
          original.scope.tomb,
          original.context,
          (check) => this.#persistNewVault(header, key, raw, check),
        );
      },
      signal,
      options,
    );
  }

  /** Point unlock at GUEST_TOMB without opening it; lock keeps the last guest. */
  prepareGuestUnlock(tomb: string = GUEST_TOMB): void {
    if (
      this.#vaultKey ||
      this.#pendingVaultKey ||
      this.#unlockSession.trustedKey
    ) {
      this.lock();
    } else {
      this.#unlockSession.reset();
      this.#zeroRaw();
      this.#protection.cancelPendingOps();
    }
    this.#scope = guestVaultScope(tomb);
    const header = this.#readHeader();
    this.#header = headerCarriesGate(header) ? header : null;
    this.#vaultKey = null;
    this.#pendingVaultKey = null;
    this.#ephemeral = false;
    this.#body = emptyBody();
    if (this.#header) writeLastVaultId(tomb);
    this.#emit();
  }

  async createGuest(
    options?: GuestMaterial.GuestCreationOptions,
    externalCheck?: () => void,
  ): Promise<void> {
    const operation = this.#protectionOperation(externalCheck);
    const { epoch: guestEpoch, check } = guestEpochGuard(operation.active);
    if (this.#vaultKey || this.#pendingVaultKey) {
      throw new Error("Lock the open vault before continuing as a guest.");
    }
    const opened = await GuestMaterial.prepareGuestOpen(
      options,
      check,
      (tomb) => this.#acquireSessionLease(tomb),
      (held) => this.#abandonSessionLease(held),
    );
    try {
      check();
    } catch (error) {
      await GuestMaterial.abandonPreparedGuest(opened, (held) =>
        this.#abandonSessionLease(held),
      );
      throw error;
    }
    const { scope, transient, lease, prepared } = opened;
    const person = GuestMaterial.guestActor(opened.person, guestEpoch, options);
    const { header, vaultKey, rawVaultKey } = prepared;
    this.#scope = scope;
    activateGuestTomb(scope.tomb, guestEpoch, person?.localOnly === true);
    this.#header = header;
    this.#commitSessionLease(lease);
    this.#vaultKey = vaultKey;
    this.#stashRaw(rawVaultKey);
    this.#pendingVaultKey = null;
    this.#body = emptyBody();
    this.#ephemeral = true;
    this.#guestPerson = person;
    this.#guestVfsOwner = transient;
    if (person) this.#guestIdentityOwner = activateIsolatedGuestPerson(person);
    unlockTomb(this.#scope.tomb, vaultKey);
    GuestMaterial.recordGuestOrigin(options);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  createWithPin = this.#credentialApi.createWithPin;

  async #persistNewVault(
    header: VaultHeader,
    vaultKey: CryptoKey,
    rawVaultKey: Uint8Array,
    check: () => void = this.#protectionOperation().context,
  ): Promise<void> {
    const scope = this.#scope;
    let boundHeader: VaultHeader;
    let lease: { tomb: string; release: () => Promise<void> } | null = null;
    try {
      boundHeader = await bindNewVaultMaterialHeader(header, rawVaultKey);
      check();
      lease = await this.#acquireSessionLease(scope.tomb);
    } catch (error) {
      await this.#abandonSessionLease(lease);
      rawVaultKey.fill(0);
      throw error;
    }
    this.#header = boundHeader;
    this.#vaultKey = vaultKey;
    this.#stashRaw(rawVaultKey);
    this.#pendingVaultKey = null;
    this.#body = emptyBody();
    this.#ephemeral = false;
    unlockTomb(this.#scope.tomb, vaultKey);
    try {
      await initializeNewVaultFiles(
        scope.tomb,
        boundHeader,
        check,
        () => this.#persist(check),
        () => this.#preferences.load(() => this.#scope.tomb),
      );
      this.#commitSessionLease(lease);
    } catch (error) {
      await this.#abandonSessionLease(lease);
      if (this.#scope !== scope || this.#vaultKey !== vaultKey) {
        rawVaultKey.fill(0);
        throw error;
      }
      // A vault whose header never reached disk cannot be unlocked again, so
      // leave nothing behind that would claim otherwise.
      this.#header = null;
      this.#vaultKey = null;
      lockTomb(this.#scope.tomb);
      this.#zeroRaw();
      this.#body = emptyBody();
      void deletePlaintextFile(this.#scope.tomb, HEADER_PATH);
      void deleteFile(this.#scope.tomb, BODY_PATH);
      this.#emit();
      throw error;
    }
    kvDelete(this.#scope.attempts);
    writeLastVaultId(this.#scope.tomb);
    this.touch();
    this.#armIdleTimer();
    this.#emit();
  }

  #assertNotLockedOut(): void {
    assertNotLockedOut(this.#scope.attempts);
  }

  #recordFailedUnlock(): void {
    recordFailedUnlock(this.#scope.attempts);
    this.#emit();
  }

  /** A frozen device refuses even a right credential, counts it, and zeroes the root. */
  #refuseWhileFrozen = PeerBodyRefresh.frozenAuthenticationRefusal(
    () => this.#scope.tomb,
    () => this.#recordFailedUnlock(),
    () => this.#vaultKey !== null,
    () => this.cancelTotpChallenge(),
  );

  async #loadBody(vaultKey: CryptoKey, check: () => void): Promise<VaultBody> {
    return loadVaultBody(this.#scope.tomb, vaultKey, this.#header, check);
  }

  #requireTrustedUnlock(key: CryptoKey, attempt: UnlockAttempt): Promise<void> {
    return this.#unlockSession.requireTrusted(key, attempt);
  }

  confirmTrustedContact(principalId: string): Promise<void> {
    return this.#unlockSession.confirmTrusted(principalId);
  }

  cancelTrustedUnlock(): void {
    this.#unlockSession.cancelTrusted();
  }

  /** Hold a shared open lock while an unlock or create makes the key usable. */
  async #acquireSessionLease(
    tomb: string,
  ): Promise<{ tomb: string; release: () => Promise<void> } | null> {
    if (this.#openLease?.tomb === tomb) return null;
    return acquireGuestAwareLease(tomb);
  }

  #commitSessionLease(
    lease: { tomb: string; release: () => Promise<void> } | null,
  ): void {
    if (!lease) return;
    const previous = this.#openLease;
    this.#openLease = lease;
    this.#stopDestroyWatch ??= onVaultDestroyed((tomb) => {
      if (tomb === this.#scope.tomb) this.lock({ recordLastVault: false });
    });
    if (previous) void previous.release().catch(() => undefined);
  }

  async #abandonSessionLease(
    lease: { tomb: string; release: () => Promise<void> } | null,
  ): Promise<void> {
    if (lease) await lease.release().catch(() => undefined);
  }

  #releaseSessionLease(): void {
    const lease = this.#openLease;
    this.#openLease = null;
    this.#stopDestroyWatch?.();
    this.#stopDestroyWatch = null;
    if (lease && isIsolatedGuestVaultId(lease.tomb))
      GuestMaterial.releaseGuestLease(lease, this.#writeQueue.pending());
    else if (lease) void lease.release().catch(() => undefined);
  }

  /** After primary unwrap: either activate or park the key for a second step. */
  async #afterPrimaryUnwrap(
    vaultKey: CryptoKey,
    miss?: string,
    attempt: UnlockAttempt = this.#unlockSession.begin(),
  ) {
    attempt.check();
    this.#refuseWhileFrozen(miss);
    if (hasSecondStep(this.#header)) {
      this.#pendingVaultKey = vaultKey;
      this.#unlockSession.arm(attempt);
      const gate = this.#header?.unlocks?.totp;
      if (gate?.selfItemId) {
        const body = await this.#loadBody(vaultKey, attempt.check);
        attempt.check();
        const code = await heldTotpCode(gate, body);
        attempt.check();
        if (code !== null) {
          try {
            await this.confirmTotp(code);
            return;
          } catch {
            // A failed self-code may ask again only while its original unlock lives.
            attempt.check();
          }
        }
      }
      this.#sendGuard.reset();
      this.#emit();
      return;
    }
    await this.#requireTrustedUnlock(vaultKey, attempt);
  }

  async unlock(password: string): Promise<void> {
    this.#assertNotLockedOut();
    const attempt = this.#unlockSession.begin();
    if (await this.#retiredPasswordLogin(password)) return;
    attempt.check();
    if (!this.#header) throw new Error("There is no vault on this device yet.");
    const record = () => {
      attempt.check();
      this.#recordFailedUnlock();
    };
    await this.#openWithRaw(
      await unwrapPassword(this.#header, password, record),
      undefined,
      attempt,
    );
  }

  async unlockWithPin(pin: string): Promise<void> {
    this.#assertNotLockedOut();
    const attempt = this.#unlockSession.begin();
    if (!this.#header) throw new Error("There is no vault on this device yet.");
    const record = () => {
      attempt.check();
      this.#recordFailedUnlock();
    };
    const raw = await unwrapPin(this.#header, pin, record);
    await this.#openWithRaw(raw, PIN_MISS, attempt);
  }

  #retiredPasswordLogin(password: string): Promise<boolean> {
    return retiredPasswordLogin(password, {
      ephemeral: () => this.#ephemeral,
      scope: () => this.#scope,
      generation: () => this.#sessionGuard.generation,
      key: () => this.#vaultKey,
      pending: () => this.#pendingVaultKey !== null,
      failed: () => this.#recordFailedUnlock(),
      lock: (recordLastVault) => this.lock({ recordLastVault }),
      mark: (data, origin) => {
        this.#retiredSynthetic = { data, origin };
      },
      marked: (origin) => this.#retiredSynthetic?.origin === origin,
      create: (check) =>
        this.createGuest({ decoy: true, scratch: true }, check),
      seed: (tomb) => seedHoneyVault(this, tomb),
      note: () => this.#noteRetiredInteraction("vault_read"),
    });
  }

  #noteRetiredInteraction(
    action: "vault_read" | "vault_export" | "vault_write" | "authority_denied",
  ): void {
    const session = this.#retiredSynthetic;
    if (!session) return;
    this.#retiredInteractions.enqueue(session.data, action);
  }

  #requireGenuineSession(): void {
    if (this.isGenuineSession()) return;
    this.#noteRetiredInteraction("authority_denied");
    throw new Error("Unlock the owner vault first.");
  }

  #requireEmptyVault(): void {
    if (this.#retiredSynthetic) this.#requireGenuineSession();
    if (isGuestVaultId(this.#scope.tomb))
      throw new Error("Start a guest session before protecting its vault.");
    if (this.#header || this.#vaultKey || this.#pendingVaultKey)
      throw new Error("A vault already exists here. Unlock it instead.");
  }

  /** A primary secret opened the root: keep it, then park it or activate. */
  async #openWithRaw(
    raw: Uint8Array,
    miss: string | undefined,
    attempt: UnlockAttempt,
  ): Promise<void> {
    try {
      attempt.check();
      this.#unlockSession.retainPrimary(attempt);
      this.#stashRaw(raw);
      const key = await importVaultKey(raw);
      attempt.check();
      await this.#afterPrimaryUnwrap(key, miss, attempt);
    } catch (error) {
      raw.fill(0);
      throw error;
    }
  }

  probePasskeyCeremony = this.#primaryApi.probePasskeyCeremony;
  unlockWithHeldPrf = this.#primaryApi.unlockWithHeldPrf;
  unlockWithPasskey = this.#primaryApi.unlockWithPasskey;
  unlockWithProtector = this.#primaryApi.unlockWithProtector;
  probeProtector = this.#primaryApi.probeProtector;
  unlockWithHeldProtectorRoot = this.#primaryApi.unlockWithHeldProtectorRoot;

  #passkeyUnlockHost() {
    const attempt = this.#unlockSession.begin();
    return {
      header: () => {
        attempt.check();
        return this.#header;
      },
      assertNotLockedOut: () => {
        attempt.check();
        this.#assertNotLockedOut();
      },
      recordFailedUnlock: () => {
        attempt.check();
        this.#recordFailedUnlock();
      },
      stashRaw: (raw: Uint8Array) => {
        try {
          attempt.check();
          this.#unlockSession.retainPrimary(attempt);
          this.#stashRaw(raw);
        } catch (error) {
          raw.fill(0);
          throw error;
        }
      },
      afterPrimaryUnwrap: (key: CryptoKey, miss?: string) =>
        this.#afterPrimaryUnwrap(key, miss, attempt),
    };
  }

  async confirmTotp(code: string): Promise<void> {
    this.#assertNotLockedOut();
    const pending = this.#pendingVaultKey;
    const gate = this.#header?.unlocks?.totp;
    if (!pending || !gate) {
      throw new Error("Enter a primary unlock method first.");
    }
    const attempt = this.#unlockSession.current();
    const original = this.#protectionOperation();
    const secret = await openTotpSecret(pending, gate);
    attempt.check();
    const ok = await totpCodeMatches(secret, code, gate.digits, gate.period);
    attempt.check();
    if (!ok) {
      this.#recordFailedUnlock();
      throw new WrongPasswordError("That authenticator code is not valid.");
    }
    await finishSecondStepUnlock(pending, this.#pendingVaultKey, (k) =>
      this.#requireTrustedUnlock(k, attempt),
    );
    // A gate with no registration yet gets one now (ADR 0113), unless a
    // trusted-contact challenge is holding the key before the vault opens.
    if (
      !gate.selfItemId &&
      !this.#unlockSession.trustedKey &&
      this.#vaultKey === pending &&
      JSON.stringify(this.#header?.unlocks?.totp) === JSON.stringify(gate)
    ) {
      await this.#registerSelfAuthenticator(gate, original.context);
    }
  }

  cancelTotpChallenge(): void {
    this.#unlockSession.cancel();
  }

  /** Step 2 by email/text: send a code to the sealed address. */
  async requestSecondStepCode(channel: CodeChannel): Promise<SentCode> {
    this.#assertNotLockedOut();
    const pending = this.#pendingVaultKey;
    const record = this.#header?.unlocks?.[channel];
    if (!pending || !record) {
      throw new Error("Enter a primary unlock method first.");
    }
    const attempt = this.#unlockSession.current();
    this.#sendGuard.assertCanSend();
    const to = await openText(pending, record.toWrap);
    attempt.check();
    const sent = await sendCode(channel, to);
    attempt.check();
    this.#sendGuard.noteSent();
    this.#pendingCode = sent;
    this.#emit();
    return sent;
  }

  /** The code the Identity API sent, if one is outstanding at unlock. */
  pendingSecondStepCode(): SentCode | null {
    return this.#pendingCode;
  }

  /** Verify the Identity code, counting misses toward the ordinary lockout. */
  async confirmRemoteCode(code: string): Promise<void> {
    this.#assertNotLockedOut();
    const pending = this.#pendingVaultKey;
    const sent = this.#pendingCode;
    if (!pending || !sent) {
      throw new Error("Ask for a code first.");
    }
    const attempt = this.#unlockSession.current();
    try {
      await verifyCode(sent.challengeId, code);
    } catch (error) {
      attempt.check();
      this.#recordFailedUnlock();
      throw error;
    }
    attempt.check();
    this.#pendingCode = null;
    await finishSecondStepUnlock(pending, this.#pendingVaultKey, (k) =>
      this.#requireTrustedUnlock(k, attempt),
    );
  }

  /** Spend a recovery code as the second step (see `recovery-codes.ts`). */
  async redeemRecoveryCode(code: string): Promise<void> {
    this.#assertNotLockedOut();
    const pending = this.#pendingVaultKey;
    const header = this.#header;
    const record = header?.unlocks?.recovery;
    if (!pending || !header || !record) {
      throw new WrongPasswordError("That recovery code is not valid.");
    }
    const attempt = this.#unlockSession.current();
    assertSecondStepPending(pending, this.#pendingVaultKey);
    const codesWrap = await spendRecoveryCode(pending, record, code, () => {
      attempt.check();
      this.#recordFailedUnlock();
    });
    attempt.check();
    await this.#persistHeader({
      ...header,
      unlocks: { ...header.unlocks, recovery: { ...record, codesWrap } },
    });
    this.#pendingCode = null;
    attempt.check();
    await this.#requireTrustedUnlock(pending, attempt);
  }

  async #persistHeader(
    proposed: VaultHeader,
    check?: () => void,
    turn?: TombWriteTurn,
  ): Promise<void> {
    const original = this.#protectionOperation(check);
    if (guestProtectionActive(this.#ephemeral, original.scope.tomb) && !turn) {
      return this.#writeQueue.enqueue(() =>
        withBodyWriteLockOrBare(original.scope.tomb, () =>
          withTombWriteTurn(original.scope.tomb, (held) => {
            original.active();
            return this.#persistHeader(proposed, original.context, held);
          }),
        ),
      );
    }
    if (
      this.#ephemeral &&
      this.#guestVfsOwner &&
      (await recoverLiveGuestPromotion(
        original.scope.tomb,
        this.#guestVfsOwner,
        original.active,
      ))
    ) {
      original.active();
      this.#guestVfsOwner = null;
      this.#ephemeral = false;
      writeLastVaultId(original.scope.tomb);
      this.#emit();
    }
    const previous = this.#header;
    const bound = await HeaderPublication.bindOriginalHeaderPolicy(
      previous,
      proposed,
      this.#rawVaultKey,
      Boolean(turn),
      original.active,
    );
    const next = turn
      ? HeaderPublication.withBodyWitness(previous, bound)
      : bound;
    const previousPhysical = readPlaintextFile(
      original.scope.tomb,
      HEADER_PATH,
    );
    original.adoptHeader(next, () => {
      this.#header = next;
    });
    const carry = this.#vaultKey && wrapMoved(previous, next, this.#body);
    const change = (body: VaultBody) => noteMasterWrap(body, next);
    await HeaderPublication.publishOriginalHeader(
      original.scope.tomb,
      () => JSON.stringify(this.#header),
      previousPhysical,
      original.active,
      async () => {
        // A rotated BODY must carry its new wraps before next HEADER publication.
        if (turn && carry)
          await this.#apply(stampedEdit(change), original.active, turn);
      },
      (unchangedPhysical) => {
        if (unchangedPhysical) this.#header = previous;
        this.#emit();
      },
    );
    if (guestProtectionActive(this.#ephemeral, original.scope.tomb)) {
      if (!this.#guestVfsOwner || !this.#guestPerson)
        throw new Error("This guest session cannot be protected.");
      const guestKey = this.#vaultKey;
      if (!guestKey) throw new Error("The guest session has ended.");
      await protectGuestTomb({
        tomb: original.scope.tomb,
        owner: this.#guestVfsOwner,
        person: this.#guestPerson,
        key: guestKey,
        check: original.active,
        turn,
        persist: () => this.#persist(original.active, turn),
      });
      this.#guestVfsOwner = null;
    }
    this.#ephemeral = false;
    this.#emit();
    if (!turn && carry) await this.#mutate(change, original.active);
    original.active();
  }

  #requireUnlocked(reason?: string) {
    if (this.#retiredSynthetic) this.#requireGenuineSession();
    return requireExistingUnlock(this.#vaultKey, this.#header, reason);
  }

  async enrollPasskey(options?: PasskeyCreateOptions): Promise<void> {
    const { header } = this.#requireUnlocked();
    const raw = this.#requireRaw();
    const ceremony = await createPasskeyUnlockCeremony(
      undefined,
      undefined,
      options,
    );
    const record = await wrapVaultKeyWithCeremony(raw, ceremony);
    const unlocks: VaultUnlocks = { ...header.unlocks, passkey: record };
    await this.#persistHeader({ ...header, unlocks });
  }

  async removePasskey(): Promise<void> {
    await this.#removeUnlock("passkey");
  }

  /** Drop one enrolled unlock method, if the vault keeps another primary. */
  async #removeUnlock(method: "passkey" | "pin"): Promise<void> {
    this.#requireUnlocked();
    const next = headerWithoutUnlock(this.#header, method);
    if (next) await this.#persistHeader(next);
  }

  enrollPin = this.#credentialApi.enrollPin;

  async removePin(): Promise<void> {
    await this.#removeUnlock("pin");
  }

  enrollPassword = this.#credentialApi.enrollPassword;

  async removePassword(): Promise<void> {
    this.#requireUnlocked();
    if (this.#header?.wrap)
      await this.#persistHeader(headerWithoutPassword(this.#header));
  }

  beginTotpEnrollment = this.#secondStepApi.beginTotpEnrollment;

  confirmTotpEnrollment = this.#secondStepApi.confirmTotpEnrollment;

  cancelTotpEnrollment = this.#secondStepApi.cancelTotpEnrollment;

  /** Point a gate at its self-authenticator registration (ADR 0113). */
  async #registerSelfAuthenticator(
    gate: TotpGateRecord,
    check?: () => void,
  ): Promise<void> {
    if (!this.#header || !this.#vaultKey) return;
    const original = this.#protectionOperation(check);
    const next = await withSelfAuthenticatorRegistration(
      this.#vaultKey,
      gate,
      this.#header,
      this.#body,
    );
    original.active();
    if (next.item) await this.saveItem(next.item);
    original.active();
    await this.#persistHeader(next.header, original.context);
  }

  removeTotp = this.#secondStepApi.removeTotp;

  beginCodeEnrollment = this.#secondStepApi.beginCodeEnrollment;

  confirmCodeEnrollment = this.#secondStepApi.confirmCodeEnrollment;

  cancelCodeEnrollment = this.#secondStepApi.cancelCodeEnrollment;

  removeCode = this.#secondStepApi.removeCode;

  describeCodeChannel = this.#secondStepApi.describeCodeChannel;

  generateRecoveryCodes = this.#secondStepApi.generateRecoveryCodes;

  recoveryCodes = this.#secondStepApi.recoveryCodes;

  /** Clear the session and parked secrets at the original lock boundary. */
  #clearLockedSessionState(): void {
    this.#vaultKey = null;
    this.#zeroRaw();
    this.#pendingVaultKey = null;
    this.#pendingTotpSecret = null;
    this.#pendingCode = null;
    this.#pendingCodeAddress = null;
    this.#body = emptyBody();
    syncInstalledTypes(undefined);
  }

  /** Run on every lock — used to wipe secrets that left the vault (clipboard). */
  onLock = this.#lockHandlers.subscribe;

  lock = (options?: { recordLastVault?: boolean }): void => {
    this.#unlockSession.reset();
    this.#releaseSessionLease();
    this.#protection.cancelPendingOps();
    const retiredOrigin = this.#retiredSynthetic?.origin;
    this.#retiredSynthetic = null;
    const recordLastVault = options?.recordLastVault !== false;
    const wasUnlocked = this.#vaultKey !== null;
    const lockedTombForLog = this.#scope.tomb;
    const wasGuest = this.#ephemeral;
    const retiredGuestVfs = this.#guestVfsOwner;
    GuestMaterial.retireGuestSession(
      lockedTombForLog,
      this.#guestIdentityOwner,
    );
    this.#guestPerson = null;
    this.#guestIdentityOwner = null;
    this.#guestVfsOwner = null;
    const wasDecoy = markDecoySession(false);
    this.#clearLockedSessionState();
    // Guest sessions are ephemeral — wipe ciphertext, but keep the unlock screen on the last guest.
    const ephemeralTomb = this.#ephemeral ? this.#scope.tomb : null;
    const guestBesideVault = isGuestSessionTomb(ephemeralTomb);
    const lockedTomb = this.#scope.tomb;
    if (this.#ephemeral) {
      this.#header = null;
      this.#ephemeral = false;
    }
    lockTomb(this.#scope.tomb);
    discardTombCaches();
    if (guestBesideVault) {
      const returned = guestScopeAfterLock(
        ephemeralTomb,
        wasDecoy,
        recordLastVault,
      );
      this.#scope = returned.scope;
      this.#header = returned.clearHeader ? null : this.#readHeader();
    } else if (recordLastVault) {
      writeLastVaultId(lockedTomb);
    }
    retireEphemeralStorage(ephemeralTomb, retiredGuestVfs);
    if (retiredOrigin) {
      this.#scope = retiredOrigin;
      this.#header = this.#readHeader();
      if (recordLastVault) writeLastVaultId(retiredOrigin.tomb);
    }
    this.#preferences.stop();
    for (const handler of this.#lockHandlers) handler();
    emitVaultLock();
    if (wasUnlocked && !wasGuest) {
      void recordActivityEvent(lockedTombForLog, {
        category: "vault",
        type: "vault.locked",
        summary: "Vault locked",
        outcome: "succeeded",
      }).catch(() => undefined);
    }
    this.#emit();
  };

  isUnlocked(): boolean {
    return this.#vaultKey !== null;
  }
  isGenuineSession(): boolean {
    return (
      this.#vaultKey !== null &&
      !this.#ephemeral &&
      this.#retiredSynthetic === null &&
      !isGuestSessionTomb(this.#scope.tomb)
    );
  }
  isSyntheticSession(): boolean {
    return this.#retiredSynthetic !== null;
  }
  readSessionRootDigest = () => this.#sessionRootDigest();
  changeMasterPassword = this.#credentialApi.changeMasterPassword;

  // —— persistence ——————————————————————————————————————————

  async #persist(check?: () => void, turn?: TombWriteTurn): Promise<void> {
    const original = this.#protectionOperation(check);
    if (!this.#vaultKey) throw new Error("The vault is locked.");
    const written = await writeBody(
      original.scope.tomb,
      this.#vaultKey,
      this.#body,
      this.#header,
      original.active,
      turn,
    );
    original.active();
    this.#body.rev = written.rev;
    this.#header = written.header;
    // Last: a body that did not finish being recorded is read back, not trusted.
    this.#sealMark = written.mark;
    noteVaultBodyPersisted();
  }

  /** Merge a device snapshot and report local/remote changes (ADR 0144). */
  async mergeSnapshot(input: DriveSnapshotInput): Promise<SnapshotMerge> {
    this.#requireGenuineSession();
    const { vaultKey, header } = this.#requireUnlocked();
    await this.flushPendingWrites();
    const port = this.#bodyPort();
    const merged = await mergeSnapshotInto(port, vaultKey, header, input);
    // Another device's password change arrives in the body (`master-wrap.ts`).
    const adopted = this.#header && adoptedMasterWrap(this.#body, this.#header);
    if (adopted) await this.#persistHeader(adopted);
    return merged;
  }

  /** This vault's header and sealed body as stored, once pending writes land. */
  async sealedSnapshot(): Promise<SealedSnapshot> {
    this.#requireGenuineSession();
    const { header } = this.#requireUnlocked();
    await this.flushPendingWrites();
    const body = readSealedFile(this.#scope.tomb, BODY_PATH);
    if (!body) throw new Error("There is nothing stored to sync yet.");
    return { tomb: this.#scope.tomb, header, body, rev: this.#body.rev ?? 0 };
  }

  /** Apply a mutation and seal it, in the order requested (a rename per keystroke). */
  #mutate(
    change: (body: VaultBody) => void,
    check?: () => void,
  ): Promise<void> {
    return this.#exclusive((apply) => apply(stampedEdit(change)), check);
  }

  #bodyWriteState = () => ({
    key: this.#vaultKey,
    raw: this.#rawVaultKey,
    header: this.#header,
    body: this.#body,
    mark: this.#sealMark,
    readHeader: () => (this.#sharesDisk() ? this.#readHeader() : null),
  });

  #adoptFreshBody = (fresh: FreshBody): void => {
    this.#header = fresh.header;
    if (!fresh.body) return;
    this.#body = fresh.body;
    syncInstalledTypes(fresh.body.itemTypes);
    this.#emit();
  };

  /** The queue precedes the body lease; captured session checks survive every await. */
  #exclusive<T>(
    act: (apply: StoreDeviceKey.ApplyChange) => Promise<T>,
    check?: () => void,
  ): Promise<T> {
    const original = this.#protectionOperation(check);
    return this.#writeQueue.enqueue(() =>
      withFreshStoreBody(
        original,
        this.#bodyWriteState,
        this.#adoptFreshBody,
        () => act((change) => this.#apply(change, original.active)),
      ),
    );
  }

  async #refreshBody(
    original: ReturnType<typeof captureStoreOperation>,
  ): Promise<void> {
    this.#adoptFreshBody(
      await refreshedStoreBody(original, this.#bodyWriteState()),
    );
    original.active();
  }

  /** Refresh every durable vault, including a protected guest, before writing. */
  #sharesDisk(): boolean {
    return !this.#ephemeral && this.#scope.tomb !== DECOY_SCRATCH_TOMB;
  }

  async #apply(
    change: (body: VaultBody) => void,
    check: () => void,
    turn?: TombWriteTurn,
  ): Promise<void> {
    await applyStoreBodyChange({
      state: this.#bodyWriteState(),
      change,
      check,
      persist: () => this.#persist(check, turn),
      rollback: (body) => {
        this.#body = body;
        this.#emit();
      },
    });
    this.touch();
    this.#noteRetiredInteraction("vault_write");
    this.#emit();
  }

  // Body-only APIs retain the original private Store write admission.
  installItemTypeDefinition = this.#itemOperations.installItemTypeDefinition;
  uninstallItemTypeDefinition =
    this.#itemOperations.uninstallItemTypeDefinition;
  saveItem = this.#itemOperations.saveItem;
  saveItems = this.#itemOperations.saveItems;
  trashItem = this.#itemOperations.trashItem;
  restoreItem = this.#itemOperations.restoreItem;
  purgeItem = this.#itemOperations.purgeItem;
  emptyTrash = this.#itemOperations.emptyTrash;
  reconcileTrashedShares = this.#itemOperations.reconcileTrashedShares;
  withdrawItems = this.#itemOperations.withdrawItems;
  restoreWithdrawn = this.#itemOperations.restoreWithdrawn;
  toggleFavorite = this.#itemOperations.toggleFavorite;
  editEnvironments = this.#itemOperations.editEnvironments;
  replaceAll = this.#itemOperations.replaceAll;
  addItems = this.#itemOperations.addItems;
  applyManifestMerge = this.#itemOperations.applyManifestMerge;
  applyImport = this.#itemOperations.applyImport;
  addFolder = this.#itemOperations.addFolder;
  renameFolder = this.#itemOperations.renameFolder;
  deleteFolder = this.#itemOperations.deleteFolder;

  #writes(check?: () => void): ItemWriteHost {
    return originalItemWriteHost(
      this.#protectionOperation(check),
      this.#body.items,
      (change, current) => this.#mutate(change, current),
    );
  }

  // —— export / import ——————————————————————————————————————

  /** Encrypted export — the sealed body plus its header, portable to another device. */
  exportSealed(): string {
    if (!this.#header) throw new Error("There is no vault to export.");
    this.#noteRetiredInteraction("vault_export");
    this.#requireGenuineSession();
    return exportStoredVault(this.#scope.tomb, this.#header);
  }

  /** Import a sealed export with its password, its PIN, or an unwrapped key. */
  importSealed = bindSealedImport(
    () => this.#bodyPort(),
    () => {
      if (this.#retiredSynthetic) this.#requireGenuineSession();
      return this.#protectionOperation().active;
    },
  );

  #bodyPort(): StoreDeviceKey.VaultBodyPort {
    return StoreDeviceKey.makeBodyPort({
      tomb: () => this.#scope.tomb,
      open: () => this.#vaultKey !== null,
      carries: () => this.#sharesDisk(),
      header: () => this.#header,
      body: () => this.#body,
      exclusive: (act) => this.#exclusive(act),
    });
  }

  /** Irreversibly remove the vault from this device. */
  async destroy(): Promise<void> {
    const { scope, transient } = this.#guestDestroyRetry.select(
      this.#scope,
      this.#guestVfsOwner !== null,
      this.isUnlocked(),
    );
    this.lock();
    const returned = this.#scope;
    const retry = transient
      ? this.#guestDestroyRetry.remember(scope, returned)
      : null;
    await TombDestruction.destroyStoredTomb(this.#writeQueue, scope, transient);
    if (retry) this.#guestDestroyRetry.complete(retry);
    if (!transient) announceVaultDestroyed(scope.tomb);
    if (this.#scope !== returned || this.isUnlocked()) return;
    if (isGuestSessionTomb(scope.tomb)) {
      this.#scope = scopedVaultScope();
      this.#header = this.#readHeader();
      writeLastVaultId(this.#scope.tomb);
    } else {
      this.#header = null;
    }
    this.#emit();
  }

  /** Only this Store registers handles after genuine fresh owner authentication. */
  async #beginOwnerOperation<T extends object>(
    primary: LocalVaultPrimary,
    entries: RetiredOperationEntries<T>,
    produce: (input: RetiredOwnerAuthenticationInput<T>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<LocalVaultStarted<T>> {
    if (this.#ephemeral || isGuestSessionTomb(this.#scope.tomb))
      throw new Error("Real owner authentication is required.");
    this.#assertNotLockedOut();
    const selected = copyCapturedOwnerPrimaryRequest(primary);
    const operation = this.#protectionOperation();
    const original = operation.active;
    const release = entries.reserve();
    const exchange = new RetiredOperationExchange<T>(
      this.#sessionGuard.signal,
      signal,
    );
    entries.set(exchange.challenge, exchange);
    const task = produce({
      tomb: operation.scope.tomb,
      primary: selected,
      exchange,
      original,
      failed: () => {
        original();
        this.#recordFailedUnlock();
      },
      headerChanged: (next) =>
        operation.adoptHeader(next, () => {
          this.#header = next;
          this.#emit();
        }),
    }).then((result) => {
      original();
      entries.rememberResult(result, original);
      return result;
    });
    retireRetiredOwnerTask(entries, exchange, task, release);
    return presentRetiredOwnerStarted(entries, exchange);
  }
  beginRetired(
    primary: LocalVaultPrimary,
    command: LocalRetiredCommand,
    signal?: AbortSignal,
  ): Promise<LocalVaultStarted<LocalRetiredInspection>> {
    const copied = copyRetiredCommand(command);
    return this.#beginOwnerOperation(
      primary,
      this.#retiredEntries,
      (input) => runRetiredOwnerOperation({ ...input, command: copied }),
      signal,
    );
  }
  beginCanary(
    primary: LocalVaultPrimary,
    command: LocalCanaryCommand,
    signal?: AbortSignal,
  ): Promise<LocalVaultStarted<LocalCanaryResult>> {
    const copied = copyRetiredOwnerCanaryCommand(command);
    return this.#beginOwnerOperation(
      primary,
      this.#canaryEntries,
      (input) =>
        runRetiredOwnerAuthentication(input, async (data) =>
          (
            await import("../agent-canaries/canary-owner-effects.js")
          ).runCanaryOwnerEffects(
            data,
            copied,
            input.exchange.controller.signal,
          ),
        ),
      signal,
    );
  }
  isCanaryResultCurrent = (result: LocalCanaryResult): boolean =>
    this.#canaryEntries.isResultCurrent(result);
  isRetiredResultCurrent = (result: LocalRetiredInspection): boolean =>
    this.#retiredEntries.isResultCurrent(result);

  // —— preferences and auto-lock ————————————————————————————

  setPrefs = this.#preferencesApi.setPrefs;
  commitPrefs = this.#preferencesApi.commitPrefs;
  writePrefsSource = this.#preferencesApi.writePrefsSource;
  readPrefsSource = this.#preferencesApi.readPrefsSource;

  touch = this.#preferences.touch.bind(this.#preferences);

  #armIdleTimer(): void {
    this.#preferences.arm(this.#vaultKey !== null, () => this.lock());
  }
}

export const vaultStore = bindGuestSessionStore(new VaultStore());
installVaultStoreBoot(vaultStore);

export { VaultCorruptError, WrongPasswordError };
