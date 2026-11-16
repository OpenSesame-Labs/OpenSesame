import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectorModes } from "../../../src/sections/connections/connect/ConnectorModes.js";
import "../../../src/sections/connections/connect/connect.css";

const options = [
  { id: "app", label: "GitHub App" },
  { id: "token", label: "Personal access token" },
  { id: "unavailable", label: "Unavailable", disabled: true },
] as const;
type Method = (typeof options)[number]["id"];

function Fixture() {
  const [value, setValue] = useState<Method>("app");
  const [locked, setLocked] = useState(false);
  const [violation, setViolation] = useState(false);
  return (
    <main>
      <h1>Connector method</h1>
      <ConnectorModes
        label="Connection method"
        value={value}
        options={options}
        disabled={locked}
        onChange={(next) => {
          if (locked || next === "unavailable") setViolation(true);
          setValue(next);
        }}
      />
      <button type="button" onClick={() => setLocked(!locked)}>
        {locked ? "Unlock" : "Lock"}
      </button>
      <output data-testid="selection">
        {new URLSearchParams(location.search).has("mutant") ? "token" : value}
      </output>
      <output data-testid="violation">{String(violation)}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
