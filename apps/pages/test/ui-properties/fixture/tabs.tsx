import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useRovingTabs } from "../../../src/screens/use-roving-tabs.js";
import "../../../src/styles.css";

const names = ["Account", "Identity", "Security", "Recovery"];
type Key = "ArrowLeft" | "ArrowRight" | "Home" | "End";
type Coverage = Record<Key, number>;

function destination(key: string, at: number): number | null {
  if (key === "ArrowLeft") return at === 0 ? names.length - 1 : at - 1;
  if (key === "ArrowRight") return at === names.length - 1 ? 0 : at + 1;
  if (key === "Home") return 0;
  if (key === "End") return names.length - 1;
  return null;
}

function Fixture() {
  const [selected, select] = useState(0);
  const [expected, setExpected] = useState(
    new URLSearchParams(location.search).has("mutant") ? 1 : 0,
  );
  const [coverage, setCoverage] = useState<Coverage>({
    ArrowLeft: 0,
    ArrowRight: 0,
    Home: 0,
    End: 0,
  });
  const { tabProps } = useRovingTabs({
    count: names.length,
    index: selected,
    select,
  });
  useEffect(() => {
    document
      .querySelector<HTMLButtonElement>('[role="tab"][tabindex="0"]')
      ?.focus();
  }, []);
  return (
    <main
      onPointerDownCapture={(event) => {
        const target = event.target;
        if (event.button !== 0 || !(target instanceof HTMLElement)) return;
        const index = names.indexOf(target.textContent ?? "");
        if (index >= 0) setExpected(index);
      }}
      onKeyDownCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const at = names.indexOf(target.textContent ?? "");
        const next = destination(event.key, at);
        if (at < 0 || next === null) return;
        const key: Key =
          event.key === "ArrowLeft" ||
          event.key === "ArrowRight" ||
          event.key === "Home"
            ? event.key
            : "End";
        setExpected(next);
        setCoverage((previous) => ({ ...previous, [key]: previous[key] + 1 }));
      }}
    >
      <h1>Keyboard tab navigation</h1>
      <div role="tablist" aria-label="Example tabs">
        {names.map((name, index) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={selected === index}
            onClick={() => select(index)}
            {...tabProps(index)}
          >
            {name}
          </button>
        ))}
      </div>
      <output data-testid="expected">{expected}</output>
      {Object.entries(coverage).map(([key, value]) => (
        <output key={key} data-testid={`count-${key}`}>
          {value}
        </output>
      ))}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
