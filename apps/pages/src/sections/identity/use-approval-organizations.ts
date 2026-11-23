/**
 * The organizations a device approval can join, for the approval form.
 *
 * An account with several asks the person to choose one; with one or none
 * the Identity API picks. A list that could not be read is a tray notice
 * with Retry, never a box on the page, and the form stays shut until then.
 */

import {
  type DeviceApprovalOrganization,
  NO_ACTIVE_DEVICE_ORGANIZATION,
  deviceApprovalOrganizationSeams,
} from "@opensesame/app-core/lib/device-approval-organizations.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { useEffect, useState } from "react";

export const DEVICE_ORGANIZATIONS_NOTICE = "identity.device-organizations";

export type ApprovalOrganizations = {
  /** Null until the list is read. */
  rows: DeviceApprovalOrganization[] | null;
  chosen: string;
  choose: (id: string) => void;
  /** Whether the form may be sent with the current choice. */
  ready: boolean;
  /** Whether the person still has to choose. */
  needsChoice: boolean;
};

function failureWords(error: Error | null): string {
  return error?.message === NO_ACTIVE_DEVICE_ORGANIZATION
    ? NO_ACTIVE_DEVICE_ORGANIZATION
    : "Could not load organizations.";
}

export function useApprovalOrganizations(
  online: boolean,
): ApprovalOrganizations {
  const [rows, setRows] = useState<DeviceApprovalOrganization[] | null>(null);
  const [chosen, choose] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!online) return;
    void attempt;
    let active = true;
    setRows(null);
    deviceApprovalOrganizationSeams.listOrganizations().then(
      (next) => {
        if (!active) return;
        dismissNotice(DEVICE_ORGANIZATIONS_NOTICE);
        setRows(next);
        choose(next.length === 1 ? (next[0]?.id ?? "") : "");
      },
      (error: Error | null) => {
        if (!active) return;
        setStatusNotice({
          id: DEVICE_ORGANIZATIONS_NOTICE,
          tone: "err",
          title: "Device approval",
          body: failureWords(error),
          retry: () => setAttempt((value) => value + 1),
        });
      },
    );
    return () => {
      active = false;
    };
  }, [online, attempt]);

  useEffect(() => () => dismissNotice(DEVICE_ORGANIZATIONS_NOTICE), []);

  const needsChoice = rows !== null && rows.length > 1 && !chosen;
  return {
    rows,
    chosen,
    choose,
    ready: rows !== null && !needsChoice,
    needsChoice,
  };
}
