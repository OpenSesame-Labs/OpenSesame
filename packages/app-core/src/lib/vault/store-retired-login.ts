/** Open the isolated decoy only while the original credential attempt lives. */
import { WrongPasswordError } from "@opensesame/vault-core";
import { host } from "../../host.js";
import { isRetiredTrapLive } from "../retired-credentials/retention-v2.js";
import {
  type RetiredLoginData,
  readRetiredLoginData,
} from "./retired-login-operation.js";
import type { VaultScope } from "./store-scope.js";

type Port = {
  ephemeral: () => boolean;
  scope: () => VaultScope;
  generation: () => number;
  key: () => CryptoKey | null;
  pending: () => boolean;
  failed: () => void;
  lock: (recordLastVault?: boolean) => void;
  mark: (data: RetiredLoginData, origin: VaultScope) => void;
  marked: (origin: VaultScope) => boolean;
  create: (check: () => void) => Promise<void>;
  seed: (tomb: string) => Promise<void>;
  note: () => void;
};

export async function retiredPasswordLogin(
  password: string,
  port: Port,
): Promise<boolean> {
  if (!host().physicalDeviceRecords || port.ephemeral()) return false;
  const origin = port.scope();
  let generation = port.generation();
  let scope = origin;
  let key: CryptoKey | null = null;
  const check = () => {
    if (
      port.generation() !== generation ||
      port.scope() !== scope ||
      port.key() !== key ||
      port.pending()
    )
      throw new Error("Credential submission ended.");
  };
  check();
  let data: RetiredLoginData | null;
  try {
    data = await readRetiredLoginData(
      origin.tomb,
      password,
      check,
      async (observed) => {
        if (observed.trap.response === "reject") {
          port.failed();
          throw new WrongPasswordError(
            "That password does not open this vault.",
          );
        }
        port.lock(false);
        generation = port.generation();
        port.mark(observed, origin);
        await port.create(check);
        if (
          port.generation() !== generation ||
          !isRetiredTrapLive(
            observed.trap.createdAt,
            observed.trap.expiresAt,
            Date.now(),
          )
        )
          throw new Error("Credential submission ended.");
        await port.seed(origin.tomb);
        scope = port.scope();
        key = port.key();
      },
    );
  } catch (error) {
    if (port.marked(origin)) port.lock();
    throw error;
  }
  check();
  if (!data) return false;
  port.note();
  return true;
}
