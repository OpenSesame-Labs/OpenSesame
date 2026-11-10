/**
 * Settings → Guided tours: the rows act (ADR 0158).
 *
 * The first opens Support on its Tutorials tab, so the walkthroughs have one
 * named, findable home beside the `?` mark. The second chooses what happens
 * the first time a screen is met (ADR 0221): its tour starts by itself (the
 * default), is offered, or neither — and the same choice governs the recommendations that
 * follow an act. The third forgets which tours and recommendations this
 * device already answered, so they are offered again as on a new device.
 *
 * A build with no support provider draws no section at all.
 */

import {
  type GuidanceMode,
  forgetGuidanceAnswers,
  setGuidanceMode,
} from "@opensesame/app-core/lib/guidance.js";
import { useContext, useRef } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlay, IconRefresh } from "../../components/Icons.js";
import { landFocus } from "../../lib/focus.js";
import { useGuidance } from "../../lib/use-guidance.js";
import { SupportContext } from "../../tutorial/support-context.js";

const MODES: readonly { value: GuidanceMode; label: string }[] = [
  { value: "auto", label: "Start the tour" },
  { value: "offer", label: "Offer the tour" },
  { value: "off", label: "Do nothing" },
];

export function GuidedToursRow() {
  const support = useContext(SupportContext);
  const guidance = useGuidance();
  const modeRef = useRef<HTMLSelectElement>(null);
  if (!support) return null;
  const answered = guidance.tours.length + guidance.recommendations.length;
  return (
    <section className="panel" id="settings-guided-tours">
      <div className="panel__head">
        <div>
          <h2>Guided tours</h2>
        </div>
      </div>
      <div className="panel__body">
        <div className="keyed-row">
          <p className="set__danger-target">
            Walkthroughs that show, step by step, on the real controls.
          </p>
          <IconKey
            label="Open guided tours"
            onClick={() => support.open("tutorials")}
          >
            <IconPlay size={16} />
          </IconKey>
        </div>
        <div className="sw">
          <label className="sw__name" htmlFor="settings-guidance-mode">
            On a screen you have not seen
          </label>
          <select
            id="settings-guidance-mode"
            ref={modeRef}
            className="sw__select"
            aria-label="On a screen you have not seen"
            value={guidance.mode}
            onChange={(event) => {
              const next = MODES.find(
                (mode) => mode.value === event.target.value,
              );
              if (next) setGuidanceMode(next.value);
            }}
          >
            {MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </div>
        {answered > 0 ? (
          <div className="keyed-row">
            <p className="set__danger-target">
              {answered === 1
                ? "1 tour or recommendation already answered."
                : `${answered} tours and recommendations already answered.`}
            </p>
            <IconKey
              label="Offer tours and recommendations again"
              onClick={() => {
                forgetGuidanceAnswers();
                // This row goes with its answers, and its key with it: the
                // keyboard is handed to the setting that stays.
                landFocus(modeRef.current);
              }}
            >
              <IconRefresh size={16} />
            </IconKey>
          </div>
        ) : null}
      </div>
    </section>
  );
}
