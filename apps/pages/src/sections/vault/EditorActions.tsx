import { type VaultItem, passwordMethod } from "@opensesame/vault-core";
import { Link } from "react-router";
import { IconCheck, IconX } from "../../components/Icons.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { hasNoGeneratedPassword } from "./account-secrets.js";

/**
 * Render after all fields so keyboard and visual order agree. The save is the
 * shared \`.go\` square with its verb beside it, so the row that ends the
 * editor names what it does instead of being two bare glyphs on a line.
 */
export function EditorActions({
  busy,
  label,
  closeTo,
  item,
}: {
  busy: boolean;
  label: string;
  closeTo: string;
  item: VaultItem;
}) {
  // A walkthrough may point at Save; it never presses it.
  const guideRef = useGuideTarget<HTMLButtonElement>("item.editor.save");
  const password = item.kind === "account" ? passwordMethod(item) : undefined;
  const pepperEmpty =
    password !== undefined && hasNoGeneratedPassword(password);
  return (
    <div className="editor__actions go-row">
      <button
        ref={guideRef}
        type="submit"
        className="go"
        disabled={busy}
        aria-busy={busy}
        aria-label={label}
        title={label}
        data-guide-pepper-recovery={pepperEmpty ? "save" : undefined}
      >
        <IconCheck size={18} />
      </button>
      <span className="go-verb" aria-hidden="true">
        {label}
      </span>
      <Link
        data-pane-close={busy ? undefined : ""}
        className="icon-btn"
        aria-label="Cancel"
        title="Cancel"
        to={closeTo}
      >
        <IconX size={17} />
      </Link>
    </div>
  );
}
