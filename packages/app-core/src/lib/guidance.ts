/**
 * Guidance — what this device has already been shown (ADR 0221).
 *
 * A person meeting a screen for the first time is offered its walkthrough,
 * and an act that an integration would make easier is followed by one
 * recommendation. Both need a memory, or they would be made on every visit:
 * this record is that memory, and nothing else.
 *
 * It holds three things: how tours are offered (`mode`), which walkthroughs
 * were answered (started or declined), and which recommendations were
 * already made. Ids only, from the checked-in registries — never a question
 * somebody asked, an item, a route parameter or a transcript. That is the
 * line ADR 0163 drew and this keeps: a support conversation is still memory
 * and only memory; "this device has seen the Settings tour offer" is a
 * preference, like the theme.
 *
 * The record rests in the device KV, sealed like every other file there
 * (ADR 0149). It is per device, not per vault: the gates are met before any
 * vault exists.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvGet, kvSet } from "./kv.js";

export const GUIDANCE_KEY = "guidance.v1";

/**
 * `offer` puts a one-press card on screen the first time a screen is met;
 * `auto` starts the walkthrough itself; `off` does neither. The library in
 * the Support sheet is unaffected by all three.
 */
export type GuidanceMode = "offer" | "auto" | "off";

export const GUIDANCE_MODES: readonly GuidanceMode[] = ["offer", "auto", "off"];

export const DEFAULT_GUIDANCE_MODE: GuidanceMode = "offer";

export type GuidanceRecord = Readonly<{
  mode: GuidanceMode;
  /** Walkthrough goal ids the person started or declined from an offer. */
  tours: readonly string[];
  /** Recommendation ids already made on this device; each is made once. */
  recommendations: readonly string[];
}>;

/** A registry id is short and plain; anything else in the file is dropped. */
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const LIMIT = 400;

const EMPTY: GuidanceRecord = Object.freeze({
  mode: DEFAULT_GUIDANCE_MODE,
  tours: Object.freeze([]),
  recommendations: Object.freeze([]),
});

function readIds(value: BoundaryValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (isString(entry) && ID.test(entry) && !ids.includes(entry)) {
      ids.push(entry);
    }
  }
  return ids.slice(-LIMIT);
}

function readMode(value: BoundaryValue | undefined): GuidanceMode {
  return GUIDANCE_MODES.find((mode) => mode === value) ?? DEFAULT_GUIDANCE_MODE;
}

/** Parse a stored record. A corrupt one is an empty one: guidance starts over. */
export function parseGuidance(raw: string | null): GuidanceRecord {
  if (!raw) return EMPTY;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return EMPTY;
    return {
      mode: readMode(parsed.mode),
      tours: readIds(parsed.tours),
      recommendations: readIds(parsed.recommendations),
    };
  } catch {
    return EMPTY;
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: { raw: string | null; record: GuidanceRecord } | null = null;

export const guidanceSeams = {
  read: (): string | null => kvGet(GUIDANCE_KEY),
  write: (value: string): void => kvSet(GUIDANCE_KEY, value),
};

/** The record as stored now. The same object until something changes it. */
export function loadGuidance(): GuidanceRecord {
  let raw: string | null = null;
  try {
    raw = guidanceSeams.read();
  } catch {
    // Storage that cannot be read is storage with nothing in it.
    raw = null;
  }
  if (cached === null || cached.raw !== raw) {
    cached = { raw, record: parseGuidance(raw) };
  }
  return cached.record;
}

function store(next: GuidanceRecord): void {
  const raw = JSON.stringify(next);
  cached = { raw, record: next };
  try {
    guidanceSeams.write(raw);
  } catch {
    // A browser that cannot keep the record offers again next time, which is
    // the survivable direction: never a tour that cannot be reached.
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeGuidance(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setGuidanceMode(mode: GuidanceMode): void {
  const current = loadGuidance();
  if (current.mode === mode) return;
  store({ ...current, mode });
}

function remember(field: "tours" | "recommendations", id: string): void {
  if (!ID.test(id)) return;
  const current = loadGuidance();
  if (current[field].includes(id)) return;
  store({ ...current, [field]: [...current[field], id].slice(-LIMIT) });
}

/** The person answered this walkthrough's offer: started it, or declined. */
export function rememberTourAnswered(goal: string): void {
  remember("tours", goal);
}

/** This recommendation was made. It is made once; the tray keeps it. */
export function rememberRecommendationMade(id: string): void {
  remember("recommendations", id);
}

/** Offer everything again, as on a new device. The mode is kept. */
export function forgetGuidanceAnswers(): void {
  const current = loadGuidance();
  if (current.tours.length === 0 && current.recommendations.length === 0) {
    return;
  }
  store({ mode: current.mode, tours: [], recommendations: [] });
}
