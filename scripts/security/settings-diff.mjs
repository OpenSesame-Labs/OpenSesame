// Comparing two records of settings and reporting what differs. No I/O.
import { isJsonObject, isString } from "../lib/json-boundary.mjs";

/** Same value with every object's keys in a fixed order. */
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

/**
 * A list of typed entries (ruleset rules, environment protection rules) as a
 * map by type, so a change names the rule and the parameter that changed.
 */
function byType(list) {
  if (!list.every((item) => isJsonObject(item) && isString(item.type)))
    return undefined;
  const keyed = {};
  for (const [index, item] of list.entries())
    keyed[item.type in keyed ? `${item.type} #${index}` : item.type] = item;
  return keyed;
}

function typedLists(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current)) return undefined;
  if (previous.length + current.length === 0) return undefined;
  const [before, now] = [byType(previous), byType(current)];
  return before && now ? [before, now] : undefined;
}

/** Every path whose value differs, with both values. */
export function changes(previous, current, path = []) {
  const [before, now] = typedLists(previous, current) ?? [previous, current];
  if (isJsonObject(before) && isJsonObject(now)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(now)]);
    return [...keys]
      .sort()
      .flatMap((key) => changes(before[key], now[key], [...path, key]));
  }
  if (JSON.stringify(stable(previous)) === JSON.stringify(stable(current)))
    return [];
  return [{ setting: path.join(" › "), previous, current }];
}

/** Text that cannot break out of a table cell, a code span or its line. */
function plain(text) {
  return text.replace(/[\p{Cc}`|]/gu, " ");
}

function show(value) {
  if (value === undefined) return "absent";
  const text = plain(JSON.stringify(value));
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export function renderChanges(found, heading, columns = ["Before", "Now"]) {
  if (found.length === 0) return `${heading}: none.\n`;
  const rows = found.map(
    (entry) =>
      `| ${plain(entry.setting)} | \`${show(entry.previous)}\` | \`${show(entry.current)}\` |`,
  );
  return [
    `${heading}: ${found.length}.`,
    "",
    `| Setting | ${columns[0]} | ${columns[1]} |`,
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
