/**
 * Buffered replay of a raw request (the `/token` exact-origin CORS gate must
 * read the form body before oidc-provider does). The replayed request keeps
 * the original socket AND the evidence recorded for the original request —
 * copied by object, never re-derived from the bytes being replayed — so the
 * `/token` replay cannot lose or change its peer (AT-IDENTITY-SPLIT).
 */
import { IncomingMessage } from "node:http";
import { adoptRequestEvidence } from "./request-evidence.js";

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("HTTP request body yielded a non-byte chunk");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * The CORS gate must read the form body to learn the client_id, so the
 * request stream handed to oidc-provider is replayed from the buffer.
 */
export function replayRequest(
  req: IncomingMessage,
  body: Buffer,
): IncomingMessage {
  // A real IncomingMessage, not a cast Readable: evidence lookup reads the
  // map only after `instanceof IncomingMessage`. The body is already buffered,
  // so `_read` must not resume the live socket (that pulls the next bytes off
  // the connection). `complete` tells a later destroy this message finished.
  const forwarded = new IncomingMessage(req.socket);
  forwarded._read = () => {};
  forwarded.headers = req.headers;
  forwarded.rawHeaders = req.rawHeaders;
  forwarded.method = req.method;
  forwarded.url = req.url;
  forwarded.httpVersion = req.httpVersion;
  forwarded.httpVersionMajor = req.httpVersionMajor;
  forwarded.httpVersionMinor = req.httpVersionMinor;
  forwarded.complete = true;
  forwarded.push(body);
  forwarded.push(null);
  adoptRequestEvidence(forwarded, req);
  return forwarded;
}
