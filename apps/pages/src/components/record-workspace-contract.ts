import type { GuideTargetId } from "@opensesame/guide-lang";
import type { ReactNode } from "react";

export type WorkspaceRow = {
  id: string;
  label: string;
  extension?: string;
  to?: string;
  onOpen?: () => void;
  actions?: ReactNode;
  /** False for an add-on that stays in the list and out of the count. */
  counted?: boolean;
};

/** Rows that belong to the section count. An omitted flag counts. */
export function countedWorkspaceRows(
  rows: readonly WorkspaceRow[],
): WorkspaceRow[] {
  return rows.filter((row) => row.counted !== false);
}

export type RecordWorkspaceProps = {
  section: string;
  title: string;
  rootPath: string;
  listPath: string;
  rows: WorkspaceRow[];
  selectedId: string | null;
  commands?: ReactNode;
  createGuide?: GuideTargetId;
  children?: ReactNode;
  status?: ReactNode;
  listHeader?: ReactNode;
  detailOpen?: boolean;
  emptyMessage?: string;
};
