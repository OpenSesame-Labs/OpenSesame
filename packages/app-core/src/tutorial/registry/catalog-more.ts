import { SETUP_TARGETS } from "./setup-catalog.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const GUIDE_TARGETS_MORE: readonly GuideTargetDescriptor[] = [
  ...SETUP_TARGETS,
  {
    id: "settings.tailnet-sync",
    description:
      "Pair this vault with a tailnet drive, check its status, sync or disconnect. The drive stores the encrypted vault.",
    role: "ceremony",
    routes: ["/settings/features/networking"],
    capabilityId: "vault.drive.sync",
  },
  {
    id: "nav.settings.item-types",
    description: "Open Item types to install and configure vault item types.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "vault.item_types.list",
  },
  {
    id: "settings.item-types",
    description:
      "Search and enable built-in item types. A type with existing items cannot be disabled. Manage custom types and repositories below the list.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "vault.item_types.install",
  },
  {
    id: "settings.install",
    description: "Install OpenSesame as an app on this device.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "app.install",
  },
  {
    id: "vault.export",
    description:
      "Opens the export sheet to save an encrypted vault backup. Use your existing vault unlock method to open the backup on another device.",
    role: "ceremony",
    routes: ["/vault"],
    capabilityId: "vault.export",
  },
];
