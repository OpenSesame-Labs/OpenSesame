import type { RefObject } from "react";
import type { ApprovalOrganizations } from "./use-approval-organizations.js";

/** The organization a device joins, drawn only when there is a choice. */
export function DeviceOrganizationField({
  id,
  organizations,
  disabled,
  selectRef,
}: {
  id: string;
  organizations: ApprovalOrganizations;
  disabled: boolean;
  selectRef: RefObject<HTMLSelectElement | null>;
}) {
  const { rows, chosen, choose } = organizations;
  if (!rows || rows.length < 2) return null;
  return (
    <div className="field">
      <label htmlFor={id}>Organization</label>
      <select
        id={id}
        ref={selectRef}
        value={chosen}
        disabled={disabled}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">Choose an organization</option>
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
          </option>
        ))}
      </select>
    </div>
  );
}
