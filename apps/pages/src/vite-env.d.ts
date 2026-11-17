/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** `1` or `true` ships the fresh-vault Passwords offer. Unset omits it. */
  readonly VITE_PWA_OFFER_PASSWORDS_ONBOARDING?: string;
  /** `1` or `true` lets a verify build stall plan activation. Unset omits the delay. */
  readonly VITE_VERIFY_ACTIVATION_STALL?: string;
  /** Milliseconds. Read only when `DEV` or `VITE_VERIFY_ACTIVATION_STALL` is set. */
  readonly VITE_VERIFY_ACTIVATION_DELAY_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
