/** No Better Auth, Node adapters, storage, or server session authority. */

export type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
export {
  type VerifiedRegistration,
  type WebAuthnRpConfig,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "./passkey-verification.js";
