import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CapabilitySwitch } from "../../../src/sections/settings/CapabilitySwitch.js";
import "../../../src/styles.css";

type Intent = {
  checked: boolean;
  requests: number;
  accepted: number;
  rejected: number;
  disabled: number;
};

function Fixture() {
  const [on, setOn] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [allow, setAllow] = useState(true);
  const [requests, setRequests] = useState(
    new URLSearchParams(location.search).has("mutant") ? 1 : 0,
  );
  const [intent, setIntent] = useState<Intent>({
    checked: false,
    requests: 0,
    accepted: 0,
    rejected: 0,
    disabled: 0,
  });

  return (
    <main
      onPointerDownCapture={(event) => {
        const target = event.target;
        if (
          event.button !== 0 ||
          !(target instanceof Element) ||
          !target.closest('[role="switch"]')
        )
          return;
        // This expectation is recorded from the user's attempt before the
        // component's callback. It does not rely on the callback firing.
        setIntent((previous) => ({
          checked: !disabled && allow ? !previous.checked : previous.checked,
          requests: previous.requests + Number(!disabled),
          accepted: previous.accepted + Number(!disabled && allow),
          rejected: previous.rejected + Number(!disabled && !allow),
          disabled: previous.disabled + Number(disabled),
        }));
      }}
    >
      <h1>Capability switch</h1>
      <fieldset disabled={disabled}>
        <CapabilitySwitch
          label="Example capability"
          on={on}
          onToggle={() => {
            setRequests((current) => current + 1);
            if (allow) setOn((current) => !current);
          }}
        />
      </fieldset>
      <button
        data-testid="permission"
        type="button"
        onClick={() => setAllow(!allow)}
      >
        {allow ? "Reject requests" : "Allow requests"}
      </button>
      <button
        data-testid="availability"
        type="button"
        onClick={() => setDisabled(!disabled)}
      >
        {disabled ? "Enable switch" : "Disable switch"}
      </button>
      <output data-testid="expected-checked">{String(intent.checked)}</output>
      <output data-testid="expected-requests">{intent.requests}</output>
      <output data-testid="actual-requests">{requests}</output>
      <output data-testid="accepted-attempts">{intent.accepted}</output>
      <output data-testid="rejected-attempts">{intent.rejected}</output>
      <output data-testid="disabled-attempts">{intent.disabled}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
