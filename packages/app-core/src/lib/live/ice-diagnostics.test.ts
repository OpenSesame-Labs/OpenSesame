import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  candidateKindsFromSdp,
  explainIceFailure,
  iceViewFromPeer,
  mergeCandidateKinds,
  watchRtcIce,
} from "./ice-diagnostics.js";
import { DIRECT_ROUTING } from "./p2p.js";

const SAMPLE = [
  "v=0",
  "a=candidate:1 1 UDP 2130706431 192.168.1.2 54321 typ host",
  "a=candidate:2 1 UDP 1694498815 abc.local 54322 typ host",
  "a=candidate:3 1 UDP 1677729535 1.2.3.4 54323 typ srflx raddr 0.0.0.0 rport 0",
].join("\n");

class IcePeer extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  #localDescription: { sdp: string } | null = null;
  #remoteDescription: { sdp: string } | null = null;

  get localDescription(): { sdp: string } | null {
    return this.#localDescription;
  }

  set localDescription(description: { sdp: string } | null) {
    this.#localDescription = description;
  }

  get remoteDescription(): { sdp: string } | null {
    return this.#remoteDescription;
  }

  set remoteDescription(description: { sdp: string } | null) {
    this.#remoteDescription = description;
  }
}

class ClosedFirefoxPeer extends IcePeer {
  #closed = false;

  override get localDescription(): { sdp: string } | null {
    if (this.#closed)
      throw new Error("Firefox does not expose closed descriptions");
    return { sdp: SAMPLE };
  }

  override set localDescription(_description: { sdp: string } | null) {}

  override get remoteDescription(): { sdp: string } | null {
    if (this.#closed)
      throw new Error("Firefox does not expose closed descriptions");
    return null;
  }

  override set remoteDescription(_description: { sdp: string } | null) {}

  closeDescriptions(): void {
    this.#closed = true;
  }
}

describe("ice diagnostics", () => {
  it("counts host, srflx, relay, and mDNS-looking lines without addresses", () => {
    const kinds = candidateKindsFromSdp(SAMPLE);
    expect(kinds).toEqual({ host: 2, srflx: 1, relay: 0, mdns: 1 });
  });

  it("merges candidate kind totals", () => {
    const left = { host: 1, srflx: 0, relay: 0, mdns: 0 };
    const right = { host: 0, srflx: 2, relay: 1, mdns: 0 };
    expect(mergeCandidateKinds(left, right)).toEqual({
      host: 1,
      srflx: 2,
      relay: 1,
      mdns: 0,
    });
  });

  it("explains mDNS-only direct routing failures in plain language", () => {
    const reason = explainIceFailure(DIRECT_ROUTING, {
      host: 2,
      srflx: 0,
      relay: 0,
      mdns: 2,
    });
    expect(reason.code).toBe("mdns_only");
    expect(reason.message).toMatch(/mDNS|private/i);
  });

  it("explains relay-only without relay candidates", () => {
    const reason = explainIceFailure(
      {
        servers: [{ urls: ["turn:turn.example.com"] }],
        relay: true,
        addresses: [],
      },
      { host: 0, srflx: 0, relay: 0, mdns: 0 },
    );
    expect(reason.code).toBe("relay_missing");
  });

  it("reports an actionable message when local gathering finishes without candidates", () => {
    const peer = new IcePeer();
    const rtc: RTCPeerConnection = overlapCast(peer);
    peer.iceGatheringState = "complete";
    expect(iceViewFromPeer(rtc, []).detail).toBe(
      "Waiting for the browsers to meet",
    );
    peer.localDescription = { sdp: "v=0\r\n" };
    peer.remoteDescription = { sdp: SAMPLE };
    const view = iceViewFromPeer(rtc, [peer.remoteDescription.sdp]);
    expect(view.detail).toBe(
      "No network path found. Check browser settings or configure a TURN relay.",
    );
    expect(view.detail).not.toContain("192.168.1.2");
    peer.localDescription = {
      sdp: "v=0\r\na=candidate:1 1 UDP 1 192.0.2.1 50000 typ prflx\r\n",
    };
    expect(iceViewFromPeer(rtc, []).detail).toBe(
      "Waiting for the browsers to meet",
    );
    peer.localDescription = { sdp: "v=0\r\n" };
    peer.connectionState = "connected";
    expect(iceViewFromPeer(rtc, []).detail).toBe("Connected");
    peer.localDescription = {
      sdp: "v=0\r\na=candidate:1 1 UDP 1 192.0.2.1 50000 typ relay\r\n",
    };
    expect(iceViewFromPeer(rtc, [peer.localDescription.sdp])).toMatchObject({
      detail: "Connected",
      candidates: { relay: 1 },
    });
  });

  it("reads the current descriptions when gathering changes without counting old copies", () => {
    const peer = new IcePeer();
    const rtc: RTCPeerConnection = overlapCast(peer);
    peer.iceGatheringState = "gathering";
    peer.localDescription = { sdp: "v=0\r\n" };
    const views: ReturnType<typeof iceViewFromPeer>[] = [];
    const stop = watchRtcIce(rtc, (view) => views.push(view));
    expect(views.at(-1)?.detail).toBe("Gathering network paths");
    peer.localDescription = { sdp: SAMPLE };
    peer.iceGatheringState = "complete";
    peer.dispatchEvent(new Event("icegatheringstatechange"));
    peer.dispatchEvent(new Event("signalingstatechange"));
    expect(views.at(-1)?.candidates).toEqual({
      host: 2,
      srflx: 1,
      relay: 0,
      mdns: 1,
    });
    expect(views.at(-1)?.detail).toBe("Waiting for the browsers to meet");
    const count = views.length;
    stop();
    peer.dispatchEvent(new Event("icegatheringstatechange"));
    expect(views).toHaveLength(count);
  });

  it("keeps value-blind candidate counts when Firefox hides closed descriptions", () => {
    const peer = new ClosedFirefoxPeer();
    const rtc: RTCPeerConnection = overlapCast(peer);
    peer.iceGatheringState = "complete";
    const views: ReturnType<typeof iceViewFromPeer>[] = [];
    const stop = watchRtcIce(rtc, (view) => views.push(view));
    expect(views.at(-1)?.candidates).toEqual({
      host: 2,
      srflx: 1,
      relay: 0,
      mdns: 1,
    });
    peer.closeDescriptions();
    peer.connectionState = "closed";
    expect(() =>
      peer.dispatchEvent(new Event("connectionstatechange")),
    ).not.toThrow();
    expect(views.at(-1)).toMatchObject({
      phase: "closed",
      candidates: { host: 2, srflx: 1, relay: 0, mdns: 1 },
      detail: "Connection closed",
    });
    expect(() => iceViewFromPeer(rtc, [])).not.toThrow();
    expect(iceViewFromPeer(rtc, []).detail).not.toMatch(/No network path/i);
    stop();
  });
});
