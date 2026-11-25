/**
 * The semantic target registry.
 *
 * A support model names controls the way a person does — `nav.connections`,
 * `shell.lock` — and this registry is the only thing that knows what those
 * names point at. The model never sees a selector, never sees an element, and
 * cannot invent an identifier: an id that is not declared in `catalog.ts` is
 * rejected before the runtime reaches the DOM.
 *
 * Mount bindings come from React refs, so a target survives a visual
 * refactor that would break any selector written against the same control.
 */

import type { GuideTargetId, GuideWaitEvent } from "@opensesame/guide-lang";
import type {
  SupportTargetDescription,
  SupportTargetRole,
} from "@opensesame/support-agent";
import { mergedGuideTargets } from "./catalog.js";
import { inDevelopment } from "./dev.js";
import { type GuideRouteId, scopeApplies } from "./routes.js";
import {
  hasVisibleTarget,
  pointableTarget,
  revealVisibleTarget,
} from "./visible-target.js";

export type GuideTargetDescriptor = {
  readonly id: GuideTargetId;
  /**
   * Authored, checked-in prose. Never a user-created label — no vault item
   * name, folder name, account address or connection title may appear here.
   */
  readonly description: string;
  readonly role: SupportTargetRole;
  /** Routes the control can appear on. Empty means "anywhere in the shell". */
  readonly routes: readonly GuideRouteId[];
  /** The ADR-0065 capability this control exercises, when it exercises one. */
  readonly capabilityId: string | null;
  /** A private state marker for authored guides; never include it in model context. */
  readonly authoredOnly?: boolean;
};

type MountedTarget = {
  readonly descriptor: GuideTargetDescriptor;
  readonly element: HTMLElement;
  readonly detach: () => void;
};

type ActivationListener = () => void;

/**
 * The attribute a bound element carries, a space-separated list of the target
 * ids it answers to. Nothing in the app reads it: resolution is the registry's
 * and only the registry's. It exists so a real-browser run can ask the page
 * which element an id stands for, instead of trusting the ring a tour drew.
 */
export const GUIDE_TARGETS_ATTRIBUTE = "data-guide-targets";

function markBound(element: HTMLElement, id: GuideTargetId): void {
  const held = (element.getAttribute(GUIDE_TARGETS_ATTRIBUTE) ?? "")
    .split(" ")
    .filter(Boolean);
  if (!held.includes(id)) {
    element.setAttribute(GUIDE_TARGETS_ATTRIBUTE, [...held, id].join(" "));
  }
}

function markUnbound(element: HTMLElement, id: GuideTargetId): void {
  const left = (element.getAttribute(GUIDE_TARGETS_ATTRIBUTE) ?? "")
    .split(" ")
    .filter((held) => held !== "" && held !== id);
  if (left.length === 0) element.removeAttribute(GUIDE_TARGETS_ATTRIBUTE);
  else element.setAttribute(GUIDE_TARGETS_ATTRIBUTE, left.join(" "));
}

const descriptorsById = new Map<GuideTargetId, GuideTargetDescriptor>();
let indexed: readonly GuideTargetDescriptor[] | null = null;

/**
 * The declared targets, by id, over the live catalog: the core entries plus
 * what approved capabilities contributed. Rebuilt when that catalog moves.
 */
function declared(): ReadonlyMap<GuideTargetId, GuideTargetDescriptor> {
  const live = mergedGuideTargets();
  if (live === indexed) return descriptorsById;
  descriptorsById.clear();
  for (const descriptor of live) {
    if (descriptorsById.has(descriptor.id)) {
      throw new Error(`guide_target_declared_twice:${descriptor.id}`);
    }
    descriptorsById.set(descriptor.id, descriptor);
  }
  indexed = live;
  return descriptorsById;
}

/**
 * Candidates per target, in mount order.
 *
 * A responsive shell renders the same destination twice — Connections is a rail
 * row on a desktop and a tab-bar link on a phone — and exactly one of them is
 * visible at any width. Binding a target to a single element would therefore
 * make every navigation guide fail closed on whichever form factor lost the
 * race, so a target may hold several candidates and resolution picks the first
 * one that can actually be pointed at.
 *
 * A duplicate is now the thing it always should have been: the *same* element
 * registered twice.
 */
const mounted = new Map<GuideTargetId, MountedTarget[]>();
const mountListeners = new Set<() => void>();
const activationListeners = new Map<GuideTargetId, Set<ActivationListener>>();
// Session diagnostics, deduplicated: a control that keeps mounting with an
// undeclared or duplicate id records the id once, not once per mount, so a
// list rendered before its capability lands cannot grow these without bound.
const duplicateMounts = new Set<string>();
const undeclaredMounts = new Set<string>();

function announce(): void {
  for (const listener of [...mountListeners]) listener();
}

function fireActivation(id: GuideTargetId): void {
  const listeners = activationListeners.get(id);
  if (!listeners) return;
  for (const listener of [...listeners]) listener();
}

/** Report a completed action for a target mounted with manual activation. */
export function reportGuideActivation(id: GuideTargetId): void {
  fireActivation(id);
}

/**
 * Hear `id` activate in the same turn as the click or key, before a lock
 * tears the guide down. The wait in `observeGuideTarget` shares this signal.
 */
export function subscribeGuideActivation(
  id: GuideTargetId,
  listener: () => void,
): () => void {
  const listeners = activationListeners.get(id) ?? new Set();
  listeners.add(listener);
  activationListeners.set(id, listeners);
  return () => {
    const live = activationListeners.get(id);
    if (!live) return;
    live.delete(listener);
    if (live.size === 0) activationListeners.delete(id);
  };
}

export type MountOptions = Readonly<{
  /**
   * How the element is activated. `click` (the default) is a click or Enter /
   * Space on it. With `manual`, the control reports a completed action through
   * `reportGuideActivation`, including actions that can fail or use a drag.
   */
  activation?: "click" | "manual";
}>;

/**
 * Binds a declared target to a live element. Returns the unbind function the
 * React effect calls on unmount.
 *
 * Activation is observed passively, in the capture phase, so a guide can tell
 * that the person acted without the tutorial ever standing between them and
 * the control. The listener only reports; it never calls `preventDefault`,
 * never synthesises an event and never activates anything itself.
 */
export function mountGuideTarget(
  id: GuideTargetId,
  element: HTMLElement,
  options: MountOptions = {},
): () => void {
  const descriptor = declared().get(id);
  if (!descriptor) {
    // Fail closed, not loudly. A guide may never point at a target nobody
    // declared, so nothing is bound and nothing is observed — but throwing
    // here runs inside a React ref and takes the document with it, and the
    // id is not always the author's mistake: a capability declares its
    // targets when its module activates, so a control from one capability
    // can render before the capability that declares its id has landed.
    // Approving `backup.git-remote` did exactly that and white-screened the
    // app, because its settings category names `settings.backup`, which
    // `connectors.external` declares. Development still throws, which is
    // where an id genuinely nobody declares gets caught.
    undeclaredMounts.add(id);
    if (inDevelopment()) {
      throw new Error(`guide_target_undeclared:${id}`);
    }
    return () => {};
  }
  const candidates = mounted.get(id) ?? [];
  if (candidates.some((candidate) => candidate.element === element)) {
    duplicateMounts.add(id);
    if (inDevelopment()) {
      throw new Error(`guide_target_mounted_twice:${id}`);
    }
    return () => {};
  }

  const onActivate = () => fireActivation(id);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") fireActivation(id);
  };
  const observed = options.activation !== "manual";
  if (observed) {
    element.addEventListener("click", onActivate, { capture: true });
    element.addEventListener("keyup", onKey, { capture: true });
  }

  const entry: MountedTarget = {
    descriptor,
    element,
    detach: () => {
      if (!observed) return;
      element.removeEventListener("click", onActivate, { capture: true });
      element.removeEventListener("keyup", onKey, { capture: true });
    },
  };
  mounted.set(id, [...candidates, entry]);
  markBound(element, id);
  announce();

  return () => {
    const live = mounted.get(id);
    if (!live) return;
    const remaining = live.filter((candidate) => candidate !== entry);
    if (remaining.length === live.length) return;
    entry.detach();
    markUnbound(element, id);
    if (remaining.length === 0) mounted.delete(id);
    else mounted.set(id, remaining);
    announce();
  };
}

export function isKnownGuideTarget(id: GuideTargetId): boolean {
  return declared().has(id);
}

export function isMountedGuideTarget(id: GuideTargetId): boolean {
  return resolveGuideTargetElement(id) !== null;
}

export function isVisibleGuideTarget(id: GuideTargetId): boolean {
  return hasVisibleTarget(
    (mounted.get(id) ?? []).map(({ element }) => element),
  );
}

/** Resolve a declared target to its best pointable element. */
export function resolveGuideTargetElement(
  id: GuideTargetId,
): HTMLElement | null {
  return pointableTarget((mounted.get(id) ?? []).map(({ element }) => element));
}

export function guideTargetDescriptor(
  id: GuideTargetId,
): GuideTargetDescriptor | null {
  return declared().get(id) ?? null;
}

export function guideTargetIds(): readonly GuideTargetId[] {
  return [...declared().keys()];
}

export function guideTargetDescriptors(): readonly GuideTargetDescriptor[] {
  return mergedGuideTargets();
}

/** Duplicate mounts seen this session; the registry test asserts it is empty. */
export function duplicateGuideTargetMounts(): readonly string[] {
  return [...duplicateMounts];
}

/** Ids a control claimed that no capability had declared when it mounted. */
export function undeclaredGuideTargetMounts(): readonly string[] {
  return [...undeclaredMounts];
}

export function subscribeToGuideTargets(listener: () => void): () => void {
  mountListeners.add(listener);
  return () => {
    mountListeners.delete(listener);
  };
}

/**
 * Sanitized snapshot for model context. Deliberately returns descriptions and
 * a mounted flag — never an `HTMLElement`, never a `resolveElement` closure,
 * and never anything read out of the live DOM.
 */
export function describeGuideTargets(
  route: GuideRouteId,
): readonly SupportTargetDescription[] {
  const out: SupportTargetDescription[] = [];
  for (const descriptor of mergedGuideTargets()) {
    if (descriptor.authoredOnly) continue;
    if (!scopeApplies(descriptor.routes, route)) continue;
    out.push({
      id: descriptor.id,
      description: descriptor.description,
      role: descriptor.role,
      mounted: isMountedGuideTarget(descriptor.id),
    });
  }
  return out;
}

/**
 * Settles when the target reaches `event`. The runtime owns every deadline, so
 * this never resolves on a timer of its own — only on the observation or on
 * `signal`.
 */
export function observeGuideTarget(
  id: GuideTargetId,
  event: GuideWaitEvent,
  signal: AbortSignal,
  options?: { readonly allowOffscreen?: boolean },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    // A focus step can attempt one reveal per offscreen candidate, but all
    // appearance waits require a visible box and ignore hidden duplicates.
    const attempted = new WeakSet<HTMLElement>();
    const elements = () =>
      (mounted.get(id) ?? []).map(({ element }) => element);
    const satisfied = () =>
      event === "appear"
        ? options?.allowOffscreen
          ? revealVisibleTarget(elements(), attempted)
          : hasVisibleTarget(elements())
        : event === "disappear"
          ? !isMountedGuideTarget(id)
          : false;

    let stop = () => {};
    const finish = () => {
      stop();
      resolve();
    };

    if (satisfied()) {
      queueMicrotask(resolve);
      return;
    }

    const onAbort = () => {
      stop();
      reject(new DOMException("aborted", "AbortError"));
    };

    if (event === "activate") {
      const listeners = activationListeners.get(id) ?? new Set();
      listeners.add(finish);
      activationListeners.set(id, listeners);
      stop = () => {
        listeners.delete(finish);
        if (listeners.size === 0) activationListeners.delete(id);
        signal.removeEventListener("abort", onAbort);
      };
    } else {
      const check = () => {
        if (!signal.aborted && satisfied()) finish();
      };
      mountListeners.add(check);
      // A mounted control can become visible after its ref is bound, for
      // example when a pane finishes its entrance animation. That does not
      // register another ref, so recheck pointability while this wait is live.
      const timer = globalThis.setInterval(check, 100);
      stop = () => {
        globalThis.clearInterval(timer);
        mountListeners.delete(check);
        signal.removeEventListener("abort", onAbort);
      };
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Drops every live binding. Vault lock calls this. */
export function clearMountedGuideTargets(): void {
  for (const candidates of mounted.values()) {
    for (const candidate of candidates) candidate.detach();
  }
  mounted.clear();
  activationListeners.clear();
  undeclaredMounts.clear();
  duplicateMounts.clear();
  announce();
}
