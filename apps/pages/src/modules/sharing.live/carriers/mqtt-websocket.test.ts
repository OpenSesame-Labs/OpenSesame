/** @vitest-environment node */
import mqttPacket from "mqtt-packet";
import { describe, expect, it } from "vitest";
import { connectPacket, publishPacket, subscribePacket } from "./mqtt-codec.js";

function official(
  packet: Parameters<typeof mqttPacket.generate>[0],
): Uint8Array {
  return new Uint8Array(mqttPacket.generate(packet));
}

describe("the bounded MQTT 3.1.1 codec", () => {
  it("matches the official CONNECT bytes with and without credentials", () => {
    for (const options of [
      { clean: true },
      { clean: true, username: "owner", password: "sealed-route" },
    ]) {
      const { password, ...officialOptions } = options;
      const officialPassword =
        password === undefined ? undefined : Buffer.from(password);
      expect(connectPacket("opensesame_fixture", options)).toEqual(
        official({
          cmd: "connect",
          protocolId: "MQTT",
          protocolVersion: 4,
          clientId: "opensesame_fixture",
          keepalive: 60,
          ...officialOptions,
          password: officialPassword,
        }),
      );
    }
  });

  it("matches the official QoS 1 SUBSCRIBE and PUBLISH bytes", () => {
    expect(subscribePacket(0x1234, "opensesame/live/topic")).toEqual(
      official({
        cmd: "subscribe",
        messageId: 0x1234,
        subscriptions: [{ topic: "opensesame/live/topic", qos: 1 }],
      }),
    );
    expect(
      publishPacket(0x4321, "opensesame/live/topic", "sealed frame"),
    ).toEqual(
      official({
        cmd: "publish",
        messageId: 0x4321,
        topic: "opensesame/live/topic",
        payload: "sealed frame",
        qos: 1,
        retain: false,
        dup: false,
      }),
    );
  });
});
