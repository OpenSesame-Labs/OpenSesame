/**
 * One built-in item type as a switch (ADR 0165).
 *
 * The whole row is the switch, so a thumb anywhere on it changes the type
 * and a finger never has to find a 24px track. Its name is the type's title;
 * what it is doing — off, on its way, on, failed — is a sentence the glyph
 * and a visually hidden description carry, never a word painted on the row.
 * A type the open vault already holds items of, or one a capability put on,
 * has no switch to press: it is drawn as a plain row with its count or mark.
 */

import type { PackRow } from "@opensesame/app-core/sections/settings/item-type-packs-model.js";
import { useCallback } from "react";
import { StatusMark } from "../../../components/StatusMark.js";
import { useOptionalGuideTarget } from "../../../tutorial/registry/react.jsx";

function End({ row }: { row: PackRow }) {
  // On because another type needs it: no count to show, only the reason.
  if (row.control === "held" && row.held === 0) {
    return <StatusMark tone="ok" label={row.sentence} />;
  }
  if (row.control === "held") {
    return (
      <span
        className="pack__held"
        role="img"
        aria-label={row.sentence}
        title={row.sentence}
      >
        {row.held}
      </span>
    );
  }
  if (row.control === "managed") {
    return <StatusMark tone="ok" label={row.sentence} />;
  }
  return (
    <>
      {row.busy ? (
        <span className="pack__spin" aria-hidden="true" />
      ) : row.phase === "failed" ? (
        <StatusMark tone="err" label={row.sentence} />
      ) : null}
      <span className="pack__track" aria-hidden="true" />
    </>
  );
}

function Face({ row }: { row: PackRow }) {
  return (
    <>
      <span className="itype__ext">{row.extension}</span>
      <span className="itype__text">
        <span className="itype__name">{row.title}</span>
        <span className="itype__summary pack__summary">{row.summary}</span>
        <span className="itype__meta">{row.facts}</span>
      </span>
      <span className="pack__end">
        <End row={row} />
      </span>
    </>
  );
}

export function PackRowView({
  row,
  onToggle,
}: {
  row: PackRow;
  onToggle: (row: PackRow) => void;
}) {
  const described = `pack-${row.id}-sentence`;
  const install = useOptionalGuideTarget<HTMLElement>(
    row.id === "account" && row.phase !== "on"
      ? "settings.account-pack"
      : undefined,
  );
  const ready = useOptionalGuideTarget<HTMLElement>(
    row.id === "account" && row.phase === "on"
      ? "settings.account-ready"
      : undefined,
  );
  // Stable across renders: a fresh closure per render would make React run
  // the null→element cycle on every update, unmounting and remounting both
  // targets each time the row re-renders. The hook's own refs are stable
  // until their id changes, so this callback changes identity exactly when
  // the registrations themselves must.
  const bind = useCallback(
    (element: HTMLElement | null) => {
      install(element);
      ready(element);
    },
    [install, ready],
  );
  if (row.control !== "switch") {
    return (
      <li className="pack pack--fixed" data-phase={row.phase}>
        <div ref={bind} className="pack__hit">
          <Face row={row} />
        </div>
      </li>
    );
  }
  return (
    <li className="pack" data-phase={row.phase}>
      <button
        ref={bind}
        type="button"
        role="switch"
        className="pack__hit"
        aria-checked={row.checked}
        aria-busy={row.busy}
        aria-label={row.title}
        aria-describedby={described}
        onClick={() => onToggle(row)}
      >
        <Face row={row} />
      </button>
      <span id={described} className="visually-hidden">
        {row.sentence}
      </span>
    </li>
  );
}
