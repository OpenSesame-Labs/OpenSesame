import { createHash } from "node:crypto";
import type { AppContext } from "../context.js";

// The email proof stays in the fragment until this page removes it from the
// address bar. Scanners that only open the link cannot consume the proof.
const script = `(() => {
  const values = new URLSearchParams(location.hash.slice(1));
  try { history.replaceState(null, '', location.pathname); }
  catch { document.getElementById('status').textContent = 'This browser could not open the link safely. Request a new link.'; return; }
  const tokens = values.getAll('token');
  const returns = values.getAll('return');
  if (tokens.length !== 1 || returns.length !== 1 || !tokens[0] || tokens[0].length > 512 || !returns[0] || returns[0].length > 4096) {
    document.getElementById('status').textContent = 'This link is invalid. Request a new sign-in link.';
    return;
  }
  document.getElementById('token').value = tokens[0];
  document.getElementById('return').value = returns[0];
  document.getElementById('submit').disabled = false;
})();`;

const style = `:root{color-scheme:light dark;--canvas:#fafafa;--ink:#171717;--muted:#4d4d4d}
@media(prefers-color-scheme:dark){:root{--canvas:#111;--ink:#f2f2f2;--muted:#bdbdbd}}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:0.9375rem/1.5 system-ui,sans-serif}
main{width:min(100%,29.5rem);margin:0 auto;padding:clamp(3rem,14vh,8rem) 1.25rem}
.brand,h1,button{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.brand{font-size:0.8125rem;font-weight:600;letter-spacing:0.04em}h1{margin:2rem 0 0;font-size:1.4rem;line-height:1.2}
p{max-width:36ch;color:var(--muted)}button{min-height:2.75rem;padding:0 1rem;border:1px solid var(--ink);border-radius:0;background:var(--ink);color:var(--canvas);font-size:0.875rem;cursor:pointer}
button:disabled{opacity:0.5;cursor:not-allowed}button:focus-visible{outline:2px solid var(--ink);outline-offset:3px}`;

export function magicLinkConfirmationCsp(ctx: AppContext): string {
  const appOrigin = ctx.config.clientAppUrl
    ? new URL(ctx.config.clientAppUrl).origin
    : undefined;
  const allowed = ctx.config.corsOrigins.filter((candidate) => {
    try {
      const url = new URL(candidate);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
        url.hostname,
      );
      return (
        candidate === url.origin &&
        (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
        (!appOrigin || appOrigin === candidate)
      );
    } catch {
      return false;
    }
  });
  return [
    "default-src 'none'",
    `script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'`,
    `style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'`,
    `form-action 'self' ${[...new Set(allowed)].join(" ")}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const magicLinkConfirmationHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Continue sign-in</title><style>${style}</style></head>
<body><main><div class="brand">OPEN SESAME</div><h1>Continue sign-in</h1><p id="status">Confirm that you want to sign in to OpenSesame.</p><noscript><p>Enable JavaScript to continue.</p></noscript>
<form method="post"><input id="token" name="token" type="hidden"><input id="return" name="return" type="hidden"><button id="submit" type="submit" disabled>Continue</button></form></main>
<script>${script}</script></body></html>`;

/** Hosted interactions keep the token in the form action until confirmation. */
export const hostedMagicLinkConfirmationHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Continue sign-in</title><style>${style}</style></head>
<body><main><div class="brand">OPEN SESAME</div><h1>Continue sign-in</h1><p>Confirm that you want to sign in to OpenSesame.</p>
<form method="post"><button type="submit">Continue</button></form></main></body></html>`;
