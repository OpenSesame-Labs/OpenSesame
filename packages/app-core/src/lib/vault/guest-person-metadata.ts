import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { readLocalDirectory } from "../local-directory.js";
import {
  type GuestSessionPerson,
  isGuestDisplayName,
  isGuestPersonEntry,
} from "../local-guest.js";
import {
  GUEST_TOMB,
  readFile,
  tombFileKey,
  vfsSeams,
  writeFile,
} from "../vfs.js";
import type { TombWriteTurn } from "../vfs-write-order.js";

const PATH = "config/guest-person";
const MAX_BYTES = 8192;

/** Bind the actor to the same vault key and physical tomb as the guest's data. */
export async function writeGuestPerson(
  tomb: string,
  person: GuestSessionPerson,
  check: () => void,
  turn?: TombWriteTurn,
): Promise<void> {
  await writeFile(
    tomb,
    PATH,
    new TextEncoder().encode(JSON.stringify(person)),
    check,
    turn,
  );
  check();
}

export async function readGuestPerson(
  tomb: string,
  check: () => void,
): Promise<GuestSessionPerson> {
  await vfsSeams.refreshRaw?.(tombFileKey(tomb, PATH), MAX_BYTES, check);
  check();
  const bytes = await readFile(tomb, PATH);
  check();
  if (bytes.length > MAX_BYTES) throw new Error("Guest identity is too large.");
  const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !isJsonObject(value) ||
    !isString(value.id) ||
    !/^local_[0-9a-f-]{36}$/u.test(value.id) ||
    !isString(value.name) ||
    !isGuestDisplayName(value.name)
  )
    throw new Error("The guest vault's identity is invalid.");
  const person: GuestSessionPerson = { id: value.id, name: value.name };
  if (value.localOnly === true) person.localOnly = true;
  return person;
}

/** Legacy guests have no actor file; accept only one exact decrypted guest. */
export async function readVaultGuestPerson(
  tomb: string,
  check: () => void,
): Promise<GuestSessionPerson | null> {
  if (tomb !== GUEST_TOMB) return readGuestPerson(tomb, check);
  const directory = await readLocalDirectory(tomb);
  check();
  const guests = directory.entries.filter(isGuestPersonEntry);
  const guest = guests[0];
  return guests.length === 1 && guest
    ? { id: guest.id, name: guest.name }
    : null;
}
