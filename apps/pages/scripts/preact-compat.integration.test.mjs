/** @vitest-environment node */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "vite";
import { test } from "vitest";
import { PREACT_COMPAT_ALIASES } from "./preact-compat.mjs";

const fixture = `
import {
  Component, createContext, createElement, forwardRef, memo,
  useContext, useId, useImperativeHandle, useRef, useState,
  useSyncExternalStore, useTransition,
} from "react";
import {createPortal} from "react-dom";
import {createRoot} from "react-dom/client";

const Scope = createContext("missing");
let external = 0;
const listeners = new Set();
class Boundary extends Component {
  constructor(props) { super(props); this.state = {failed: false}; }
  static getDerivedStateFromError() { return {failed: true}; }
  componentDidCatch() {}
  render() {
    return this.state.failed
      ? createElement("span", {id: "caught"}, "caught")
      : this.props.children;
  }
}
function Broken() { throw new Error("fixture boundary"); }

const Imperative = forwardRef(function Imperative(_props, ref) {
  useImperativeHandle(ref, () => ({value: "imperative-ready"}), []);
  return createElement("span", {id: "imperative"}, "imperative-mounted");
});
const ContextValue = memo(function ContextValue() {
  return createElement("span", {id: "context"}, useContext(Scope));
});

function App() {
  const [count, setCount] = useState(0);
  const [breakIt, setBreakIt] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [pending, transition] = useTransition();
  const id = useId();
  const handle = useRef(null);
  const snapshot = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => external,
  );
  return createElement(Scope.Provider, {value: "context-ready"},
    createElement("button", {
      id: "increment",
      onClick: () => transition(() => setCount((value) => value + 1)),
    }, pending ? "pending" : String(count)),
    createElement("button", {
      id: "external",
      onClick: () => { external += 1; for (const listener of listeners) listener(); },
    }, String(snapshot)),
    createElement("button", {id: "error", onClick: () => setBreakIt(true)}, "break"),
    createElement("form", {
      id: "form",
      onSubmit: (event) => { event.preventDefault(); setSubmitted(true); },
    }, createElement("button", {type: "submit"}, submitted ? "submitted" : "submit")),
    createElement("label", {htmlFor: id}, "label"),
    createElement("input", {id}),
    createElement(ContextValue),
    createElement(Imperative, {ref: handle}),
    createPortal(createElement("span", {id: "portal"}, "portal-ready"), document.body),
    createElement(Boundary, null,
      breakIt ? createElement(Broken) : createElement("span", {id: "healthy"}, "healthy")),
    createElement("output", {id: "handle"}, handle.current?.value ?? "waiting"),
  );
}

const root = createRoot(document.querySelector("#root"));
root.render(createElement(App));

const waitFor = async (selector) => {
  for (let index = 0; index < 100; index += 1) {
    if (document.querySelector(selector)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for " + selector + ": " + document.body.innerHTML);
};

export async function drive() {
  await waitFor("#healthy");
  document.querySelector("#increment").click();
  document.querySelector("#external").click();
  document.querySelector("#form button").click();
  document.querySelector("#error").click();
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (document.querySelector("#increment").textContent === "1" &&
        document.querySelector("#external").textContent === "1" &&
        document.querySelector("#form button").textContent === "submitted" &&
        document.querySelector("#caught")) break;
  }
  const result = {
    caught: document.querySelector("#caught")?.textContent,
    context: document.querySelector("#context")?.textContent,
    count: document.querySelector("#increment")?.textContent,
    external: document.querySelector("#external")?.textContent,
    form: document.querySelector("#form button")?.textContent,
    imperative: document.querySelector("#imperative")?.textContent,
    labelBound: document.querySelector("label")?.htmlFor === document.querySelector("input")?.id,
    portal: document.querySelector("#portal")?.textContent,
  };
  root.unmount();
  return result;
}
`;

async function bundle(dir, name, alias) {
  const entry = join(dir, `${name}.mjs`);
  writeFileSync(entry, fixture);
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { alias },
    build: {
      emptyOutDir: false,
      lib: { entry, formats: ["es"], fileName: () => `${name}.bundle.mjs` },
      minify: "terser",
      outDir: dir,
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  return join(dir, `${name}.bundle.mjs`);
}

async function run(file) {
  const dom = new JSDOM('<!doctype html><body><main id="root"></main></body>', {
    url: "https://app.example.test/",
  });
  const previous = new Map();
  for (const name of [
    "Event",
    "HTMLElement",
    "MutationObserver",
    "Node",
    "document",
    "navigator",
    "window",
  ]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
      writable: true,
    });
  }
  try {
    const module = await import(
      `${pathToFileURL(file).href}?run=${Date.now()}`
    );
    return await module.drive();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    dom.window.close();
  }
}

test("the production compatibility renderer matches React's client contract", async () => {
  // Keep the ephemeral entry under the workspace so bare package resolution
  // follows the same node_modules ancestry as the real Pages entry.
  const dir = mkdtempSync(join(process.cwd(), ".preact-contract-"));
  try {
    const react = await bundle(dir, "react", {});
    const compat = await bundle(dir, "preact", PREACT_COMPAT_ALIASES);
    const expected = await run(react);
    assert.deepEqual(await run(compat), expected);
    assert.deepEqual(expected, {
      caught: "caught",
      context: "context-ready",
      count: "1",
      external: "1",
      form: "submitted",
      imperative: "imperative-mounted",
      labelBound: true,
      portal: "portal-ready",
    });
    const shipped = readFileSync(compat, "utf8");
    assert.doesNotMatch(shipped, /react-dom\/cjs|react\.production\.js/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
