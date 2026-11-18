import { SCIM_PAGE_MAX } from "@opensesame/database";
import type { Context } from "hono";
import type { Variables } from "../middleware/context.js";

/** SCIM pages are 1-based; count=0 requests just the matching total. */
export function scimPage(c: Context<{ Variables: Variables }>) {
  const start = c.req.query("startIndex");
  const count = c.req.query("count");
  if (
    (start !== undefined && !/^-?\d+$/.test(start)) ||
    (count !== undefined && !/^-?\d+$/.test(count)) ||
    (c.req.queries("startIndex")?.length ?? 0) > 1 ||
    (c.req.queries("count")?.length ?? 0) > 1
  )
    return undefined;
  const startValue = start === undefined ? 1 : Number(start);
  const countValue = count === undefined ? SCIM_PAGE_MAX : Number(count);
  return {
    startIndex: Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, startValue)),
    count: Math.min(SCIM_PAGE_MAX, Math.max(0, countValue)),
  };
}
