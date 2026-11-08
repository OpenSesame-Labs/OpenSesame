/**
 * The guided start of an import: where the passwords live now, how that
 * place exports them, and only then the file picker.
 *
 * A person setting up does not have "a file" yet — they have passwords in
 * Chrome. This sheet is the Chrome-style first-run ceremony the app can
 * honestly offer: OpenSesame cannot read a browser or another manager
 * itself, and says so. What it can do is walk the export: pick the
 * source, follow that product's own export steps (the adapter's checked-in
 * hint, so the words cannot drift from the parser that will read the
 * result), then choose the file — which opens the import sheet every
 * import already uses, where it is read on this device and previewed
 * before anything is sealed. Detection still verifies the file; the
 * source chosen here is guidance, never a forced parse.
 */

import {
  type SourceId,
  adapterFor,
} from "@opensesame/app-core/lib/vault/import/index.js";
import { useState } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { IconDownload } from "../../../components/Icons.js";
import "./import.css";

/** The sources a first run plausibly comes from, browsers first. */
const SOURCES: readonly { id: SourceId; name: string }[] = [
  { id: "chromium-csv", name: "Chrome, Edge or Brave" },
  { id: "firefox-csv", name: "Firefox" },
  { id: "apple-csv", name: "Safari or Apple Passwords" },
  { id: "bitwarden-json", name: "Bitwarden" },
  { id: "1password-1pux", name: "1Password" },
  { id: "generic-csv", name: "Another manager, or a file I already have" },
];

export function ImportSourceSheet({
  onPick,
  onClose,
}: {
  /** The person has the exported file: open the picker for it. */
  onPick: () => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<SourceId>("chromium-csv");
  const adapter = adapterFor(selected);
  return (
    <CeremonySheet
      title="Import passwords"
      mark={<IconDownload size={20} />}
      onClose={onClose}
    >
      <div className="import-source">
        <p className="import-source__lede">Where are your passwords now?</p>
        <div
          className="import-source__tiles"
          role="radiogroup"
          aria-label="Source"
        >
          {SOURCES.map((source) => (
            <button
              key={source.id}
              type="button"
              aria-pressed={selected === source.id}
              className="btn choice import-source__tile"
              onClick={() => setSelected(source.id)}
            >
              {source.name}
            </button>
          ))}
        </div>
        {adapter ? (
          <div className="import-source__steps">
            <h3>Export from {adapter.shortName} first</h3>
            <p>{adapter.hint}</p>
          </div>
        ) : null}
        <ul className="import-source__facts">
          <li>
            OpenSesame cannot read your browser itself. The exported file is
            read only on this device, and you preview everything before anything
            is sealed.
          </li>
          <li>
            An exported passwords file is usually plain text anyone could read.
            Delete it once the import finishes.
          </li>
        </ul>
        <button type="button" className="btn choice" onClick={onPick}>
          Choose the exported file
        </button>
      </div>
    </CeremonySheet>
  );
}
