/**
 * Settings → Guided tours: the row acts — it opens Support on its Tutorials
 * tab (ADR 0158), so the walkthroughs have one named, findable home beside
 * the `?` mark. A build with no support provider draws no row at all.
 */

import { useContext } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlay } from "../../components/Icons.js";
import { SupportContext } from "../../tutorial/support-context.js";

export function GuidedToursRow() {
  const support = useContext(SupportContext);
  if (!support) return null;
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
      </div>
    </section>
  );
}
