const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MAX_REMAINING_LENGTH = 268_435_455;
export const KEEPALIVE_SECONDS = 60;
/** Product frames top out near 3 KiB; leave room for a full coalesced exchange. */
export const MAX_PACKET_BYTES = 128 * 1024;

export function concatenate(
  parts: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function twoByte(value: number): Uint8Array {
  return Uint8Array.of(value >> 8, value & 0xff);
}

function mqttString(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  if (bytes.length > 0xffff) throw new Error("MQTT string is too long");
  return concatenate([twoByte(bytes.length), bytes]);
}

function remainingLength(value: number): Uint8Array {
  if (value < 0 || value > MAX_REMAINING_LENGTH)
    throw new Error("MQTT packet is too large");
  const bytes: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Uint8Array.from(bytes);
}

export function mqttPacket(header: number, body: Uint8Array): Uint8Array {
  return concatenate([
    Uint8Array.of(header),
    remainingLength(body.length),
    body,
  ]);
}

export function connectPacket(
  clientId: string,
  options: { username?: string; password?: string; clean?: boolean },
): Uint8Array {
  let flags = options.clean === false ? 0 : 0x02;
  const payload = [mqttString(clientId)];
  if (options.username !== undefined) {
    flags |= 0x80;
    payload.push(mqttString(options.username));
  }
  if (options.password !== undefined) {
    flags |= 0x40;
    payload.push(mqttString(options.password));
  }
  const variable = concatenate([
    mqttString("MQTT"),
    Uint8Array.of(4, flags),
    twoByte(KEEPALIVE_SECONDS),
  ]);
  return mqttPacket(0x10, concatenate([variable, ...payload]));
}

export function subscribePacket(id: number, topic: string): Uint8Array {
  return mqttPacket(
    0x82,
    concatenate([twoByte(id), mqttString(topic), Uint8Array.of(1)]),
  );
}

export function publishPacket(
  id: number,
  topic: string,
  text: string,
  duplicate = false,
): Uint8Array {
  return mqttPacket(
    duplicate ? 0x3a : 0x32,
    concatenate([mqttString(topic), twoByte(id), encoder.encode(text)]),
  );
}

export function decodeText(value: Uint8Array): string {
  return decoder.decode(value);
}
