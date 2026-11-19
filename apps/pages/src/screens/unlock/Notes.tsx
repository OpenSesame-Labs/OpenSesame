/** The two standing notes on the unlock form: storage that will not last, and a lockout. */

import type { UnlockTabId } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import type { VaultHeader } from "@opensesame/vault-core";
import type { Ref } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconArrowRight, IconPasskey } from "../../components/Icons.js";

/** A browser that keeps nothing across tabs. Said once, on the form, because it changes what is safe to store. */
export function DurabilityNote({ durable }: { durable: boolean }) {
  if (durable) return null;
  return (
    <output className="note note--warn">
      <span>
        This browser gives this app no persistent storage, so the vault will be
        gone when the tab closes — private windows and some embedded browsers do
        this. Do not put your only copy of anything in here.
      </span>
    </output>
  );
}

/** Too many wrong tries: how long until the next. */
export function LockoutNote({
  lockedFor,
  failedAttempts,
}: {
  lockedFor: number;
  failedAttempts: number;
}) {
  if (lockedFor <= 0) return null;
  return (
    <output className="note note--warn">
      <span>
        {failedAttempts} failed attempts. Try again in {lockedFor}s.
      </span>
    </output>
  );
}

/** The key form's acknowledgement or reminder, followed by its storage notice. */
export function FormNotes({
  firstRun,
  activeMethod,
  acceptRef,
  ackGuideRef,
  accepted,
  setAccepted,
  header,
  awaitingSecondStep,
  durable,
}: {
  firstRun: boolean;
  activeMethod: UnlockTabId;
  acceptRef: Ref<HTMLInputElement>;
  ackGuideRef?: Ref<HTMLLabelElement>;
  accepted: boolean;
  setAccepted: (value: boolean) => void;
  header: VaultHeader | null;
  awaitingSecondStep: boolean;
  durable: boolean;
}) {
  return (
    <>
      {firstRun ? (
        <div className="unlock__terms">
          <p id="master-help">
            {activeMethod === "passkey"
              ? "If you lose access to this passkey, you cannot recover items encrypted on this device. If the passkey cannot secure this vault, choose PIN instead."
              : "There is no recovery. Forget this PIN and the encrypted items on this device are unreadable — by you and by us."}
          </p>
          <label className="check" ref={ackGuideRef}>
            <input
              type="checkbox"
              ref={acceptRef}
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>I understand this vault cannot be recovered.</span>
          </label>
        </div>
      ) : header?.hint && activeMethod === "password" && !awaitingSecondStep ? (
        <p className="unlock__hint">
          <strong>Reminder:</strong> {header.hint}
        </p>
      ) : null}
      <DurabilityNote durable={durable} />
    </>
  );
}

/** The notice, failure state and one submit action form one tutorial surface. */
export function SealActions({
  guideRef,
  buttonRef,
  error,
  lockedFor,
  failedAttempts,
  disabled,
  busy,
  goVerb,
  ceremony,
  showAction,
  ...notes
}: Parameters<typeof FormNotes>[0] & {
  guideRef: Ref<HTMLDivElement> | undefined;
  buttonRef: Ref<HTMLButtonElement>;
  error: string | null;
  lockedFor: number;
  failedAttempts: number;
  disabled: boolean;
  busy: boolean;
  goVerb: string;
  ceremony: boolean;
  showAction: boolean;
}) {
  return (
    <div className="unlock__seal-actions" ref={guideRef}>
      <FormNotes {...notes} />
      <FailureNotice id="unlock:error" title="Unlock" message={error} />
      <LockoutNote lockedFor={lockedFor} failedAttempts={failedAttempts} />
      {showAction ? (
        <div className="go-row">
          <button
            ref={buttonRef}
            type="submit"
            className="go"
            disabled={disabled}
            aria-busy={busy}
            aria-label={goVerb}
            title={goVerb}
          >
            {ceremony ? (
              <IconPasskey size={18} />
            ) : (
              <IconArrowRight size={18} />
            )}
          </button>
          <span className="go-verb" aria-hidden="true">
            {goVerb}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function UnlockSteps({
  awaitingSecondStep,
  authenticatorOnly,
}: {
  awaitingSecondStep: boolean;
  authenticatorOnly: boolean;
}) {
  return (
    <ol className="steps" aria-label="Unlock steps">
      <li
        className={
          awaitingSecondStep ? "steps__seg is-done" : "steps__seg is-now"
        }
      >
        <span className="steps__bar" />
        <span className="steps__label">1 · Key</span>
      </li>
      <li className={awaitingSecondStep ? "steps__seg is-now" : "steps__seg"}>
        <span className="steps__bar" />
        <span className="steps__label">
          {authenticatorOnly ? "2 · Authenticator code" : "2 · Code"}
        </span>
      </li>
    </ol>
  );
}
