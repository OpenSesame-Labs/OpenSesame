/** Mirrors apps/pages/src/styles.css and DESIGN.md (greyscale, radius 0). */

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, 'Noto Sans', sans-serif";
const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

const GROUP_NAMES = ["blue", "orange", "purple", "yellow", "teal", "tan", "pink"];

export const PELE_THEME_TOKENS = {
  light: {
    canvas: "#fafafa",
    ink: "#171717",
    muted: "#666666",
    line: "#4d4d4d",
    surface: "#ffffff",
    surfaceAlt: "#f0f0f0",
    border: "#bdbdbd",
    errWash: "#d9d9d9",
    warnWash: "#e6e6e6",
    warn: "#5c5c5c",
    markSlit: "#8f8f8f",
    groups: {
      blue: "#f0f0f0",
      orange: "#e6e6e6",
      purple: "#e2e2e2",
      yellow: "#efefef",
      teal: "#efefef",
      tan: "#e2e2e2",
      pink: "#d9d9d9",
    },
  },
  dark: {
    canvas: "#0f0f0f",
    ink: "#f5f5f5",
    muted: "#8f8f8f",
    line: "#b3b3b3",
    surface: "#171717",
    surfaceAlt: "#1d1d1d",
    border: "#4a4a4a",
    errWash: "#3a3a3a",
    warnWash: "#2b2b2b",
    warn: "#a0a0a0",
    markSlit: "#666666",
    groups: {
      blue: "#1d1d1d",
      orange: "#2b2b2b",
      purple: "#2a2a2a",
      yellow: "#222222",
      teal: "#242424",
      tan: "#1d1d1d",
      pink: "#3a3a3a",
    },
  },
};

function resolvedVars(t) {
  return {
    "--_bg": t.canvas,
    "--_fg": t.ink,
    "--_m": t.muted,
    "--_l": t.line,
    "--_s": t.surface,
    "--_a": t.surfaceAlt,
    "--_b": t.border,
    "--_c": t.ink,
    "--_tw": "600",
    "--_fm": MONO,
    "--pele-bg": t.canvas,
    "--pele-fg": t.ink,
    "--pele-muted": t.muted,
    "--pele-line": t.line,
    "--pele-surface": t.surface,
    "--pele-surface-alt": t.surfaceAlt,
    "--pele-border": t.border,
    "--pele-accent": t.ink,
    "--pele-font": FONT,
    "--pele-font-mono": MONO,
    "--pele-title-weight": "600",
    "--pele-radius": "0",
  };
}

/** Replace every Pele var() so resvg paints hex, not a stylesheet. */
function replaceCssVars(svg, t) {
  const resolved = resolvedVars(t);
  return svg.replace(
    /var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,[^)]*)?\)/g,
    (full, name) => resolved[name] ?? full,
  );
}

function paintStateNode(cls, tail, rectBody, textBlock, t) {
  const geom = rectBody
    .replace(/\sstyle="[^"]*"/g, "")
    .replace(/\sfill="[^"]*"/g, "")
    .replace(/\sstroke="[^"]*"/g, "")
    .replace(/\sstroke-width="[^"]*"/g, "")
    .replace(/\sstroke-dasharray="[^"]*"/g, "");
  const tokens = cls.split(/\s+/);
  let fill = t.surface;
  let stroke = t.border;
  let strokeWidth = "1";
  let dash = "";
  for (const name of GROUP_NAMES) {
    if (tokens.includes(name)) fill = t.groups[name];
  }
  if (tokens.includes("breaks")) {
    fill = t.errWash;
    stroke = t.ink;
    strokeWidth = "2.5";
  }
  if (tokens.includes("mayBreak")) {
    fill = t.warnWash;
    stroke = t.warn;
    strokeWidth = "2.5";
  }
  if (tokens.includes("bugPath")) {
    stroke = t.ink;
    strokeWidth = "2.5";
  }
  if (tokens.includes("repeats")) {
    stroke = t.markSlit;
    strokeWidth = "2.5";
    dash = ' stroke-dasharray="6 3"';
  }
  let text = textBlock.replace(/\sstyle="[^"]*"/g, "");
  if (tokens.includes("mayBreak")) {
    text = text.replace(
      /<text class="pele-label" fill="[^"]*"/,
      `<text class="pele-label" fill="${t.line}"`,
    );
  }
  return `<g class="${cls}"${tail}><rect${geom} fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${dash} />${text}</g>`;
}

/** Bake literals into SVG so resvg/PNG rasterizers do not need CSS variables. */
export function bakeOpenSesameTheme(svg, mode) {
  const theme = mode === "dark" ? "dark" : "light";
  const t = PELE_THEME_TOKENS[theme];
  let out = replaceCssVars(svg, t);
  out = out.replace(/rx="(?:10|3)"/g, 'rx="0"');
  out = out.replace(/ry="(?:10|3)"/g, 'ry="0"');
  out = out.replace(
    /\sstyle="fill:#[0-9a-fA-F]+(?:;stroke:#[0-9a-fA-F]+;stroke-width:[^"]*)?"/g,
    "",
  );
  out = out.replace(
    /<text class="pele-label"([^>]*)>/g,
    `<text class="pele-label" fill="${t.ink}"$1>`,
  );
  out = out.replace(
    /<g class="(pele-node pele-state[^"]*)"([^>]*)>\s*<rect([\s\S]*?)\/>\s*(<text[\s\S]*?<\/text>)\s*<\/g>/g,
    (_full, cls, tail, rectBody, textBlock) =>
      paintStateNode(cls, tail, rectBody, textBlock, t),
  );

  const vb = out.match(/viewBox="([^"]+)"/);
  if (vb) {
    const [, , w, h] = vb[1].split(/\s+/).map(Number);
    const backdrop = `<rect class="os-canvas" x="0" y="0" width="${w}" height="${h}" fill="${t.canvas}"/>`;
    out = out.replace(/^(<svg[^>]*>)/, `$1${backdrop}`);
  }

  out = out.replace(/class="pele /, `class="pele os-theme-${theme} `);
  return out;
}

/** Drop statechart classDef lines. A line-anchored match strips every line, not every other one. */
export function stripMermaidMarks(mmd) {
  return mmd.replace(/^[ \t]*classDef\b[^\n]*\n?/gm, "");
}
