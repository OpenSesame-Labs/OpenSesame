/**
 * The screen in front of the tabbed ceremony: Default, Minimal, Full,
 * Custom. Choice objects, the same road as the front door.
 *
 * Default comes first, says it is the recommended one and is where the
 * keyboard lands (ADR 0221): first-run testers took the first road they
 * saw, and while that was Minimal they sealed a vault with no password
 * type in it. Each road says what the vault will hold in plain words, and
 * one line above them says the choice is not final. It is a statement, not
 * a question title.
 *
 * The choices are one keyboard group: Tab reaches them in document
 * order (the door's roads are the same), and the arrow keys walk
 * the row — Left/Right by one, Home/End to the edges — so the
 * whole row is reachable without Tab-ing through every road.
 */

import { type KeyboardEvent, useRef } from "react";
import {
  IconCheck,
  IconDownload,
  IconLayers,
  IconSettings,
} from "../../components/Icons.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import "../door.css";

export type ConfigurationChoice = "minimal" | "default" | "full" | "custom";

const CHOICES: ReadonlyArray<{
  id: ConfigurationChoice;
  name: string;
  kind: string;
  Icon: typeof IconCheck;
  /** The one a person with no reason to choose otherwise should take. */
  recommended?: true;
}> = [
  {
    id: "default",
    name: "Default",
    kind: "Recommended. Passwords, passkeys, cards and notes, plus sign-in, connections and access.",
    Icon: IconCheck,
    recommended: true,
  },
  {
    id: "minimal",
    name: "Minimal",
    kind: "Plain secrets and files only. No password, card or note types until you turn them on.",
    Icon: IconDownload,
  },
  {
    id: "full",
    name: "Full",
    kind: "Everything this build can run, switched on.",
    Icon: IconLayers,
  },
  {
    id: "custom",
    name: "Custom",
    kind: "Pick each capability yourself, one tab at a time.",
    Icon: IconSettings,
  },
];

export function SetupConfiguration({
  busy,
  pending,
  onChoose,
}: {
  busy: boolean;
  pending: ConfigurationChoice | null;
  onChoose: (id: ConfigurationChoice) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const targetRef = useGuideTarget<HTMLFieldSetElement>("setup.configurations");
  const move = (event: KeyboardEvent, at: number) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const edge =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? CHOICES.length - 1
          : null;
    if (step === 0 && edge === null) return;
    event.preventDefault();
    const next = edge ?? (at + step + CHOICES.length) % CHOICES.length;
    const choice = CHOICES[next];
    if (!choice) return;
    refs.current[next]?.focus();
  };
  return (
    <>
      <p className="door__lede capset__lede">
        Choose what this vault holds. Any choice can be changed later in
        Settings, under Features.
      </p>
      <fieldset
        ref={targetRef}
        className="capset__roads"
        aria-label="Setup configuration"
      >
        {CHOICES.map((choice, at) => (
          <button
            key={choice.id}
            ref={(node) => {
              refs.current[at] = node;
            }}
            type="button"
            className={choice.recommended ? "road road--lead" : "road"}
            aria-label={choice.name}
            aria-describedby={`setup-config-${choice.id}`}
            aria-busy={pending === choice.id}
            disabled={busy}
            onClick={() => onChoose(choice.id)}
            onKeyDown={(event) => move(event, at)}
          >
            <span className="road__mark" aria-hidden="true">
              <choice.Icon size={20} />
            </span>
            <span className="road__name">{choice.name}</span>
            <span className="road__kind" id={`setup-config-${choice.id}`}>
              {choice.kind}
            </span>
          </button>
        ))}
      </fieldset>
    </>
  );
}
