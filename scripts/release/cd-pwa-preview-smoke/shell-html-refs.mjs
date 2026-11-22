/** Parse script/link tags and attributes without `data-src`/`data-href` false positives. */

export function htmlAttribute(tag, name) {
  const pattern = new RegExp(
    `(?:^|[\\s/>])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    "iu",
  );
  const match = tag.match(pattern);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

export function* scriptAndLinkOpenTags(html) {
  const re = /<(script|link)\b/giu;
  for (const match of html.matchAll(re)) {
    const start = match.index ?? 0;
    let i = start + match[0].length;
    let quote = null;
    while (i < html.length) {
      const ch = html[i];
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        yield { tag: html.slice(start, i + 1), kind: match[1].toLowerCase() };
        break;
      }
      i += 1;
    }
  }
}

export function shellAssetRefs(html) {
  const refs = [];
  for (const { tag, kind } of scriptAndLinkOpenTags(html)) {
    if (kind === "script") {
      const src = htmlAttribute(tag, "src");
      if (src !== undefined && src.length > 0) refs.push(src);
      continue;
    }
    const rel = htmlAttribute(tag, "rel");
    if (rel === undefined) continue;
    const relTokens = rel.toLowerCase().split(/\s+/u);
    const isModulePreload = relTokens.includes("modulepreload");
    const isStylesheet = relTokens.includes("stylesheet");
    if (!isModulePreload && !isStylesheet) continue;
    const href = htmlAttribute(tag, "href");
    if (href !== undefined && href.length > 0) refs.push(href);
  }
  return refs;
}
