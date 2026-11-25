import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { showKeyboardPeers } from "./live-keyboard-entry.mjs";
import { WATCH_RTC, peerStates } from "./live-rtc.mjs";

afterEach(() => vi.unstubAllGlobals());

test("candidate diagnostics retain only routing metadata after a browser closes its peer", () => {
  class Peer extends EventTarget {
    signalingState = "have-remote-offer";
    remoteDescription = null;
  }
  class Channel extends EventTarget {
    send() {}
  }
  vi.stubGlobal("window", { RTCPeerConnection: Peer });
  vi.stubGlobal("RTCDataChannel", Channel);
  WATCH_RTC();
  const peer = new window.RTCPeerConnection({ iceServers: [] });
  const line =
    "candidate:fixture 1 udp 123 192.0.2.20 43210 typ host generation 0 ufrag omitted";
  const event = new Event("icecandidate");
  Object.defineProperty(event, "candidate", { value: { candidate: line } });
  peer.dispatchEvent(event);
  peer.remoteDescription = {
    sdp: `v=0\r\na=ice-pwd:never-log-this\r\na=${line}\r\n`,
  };
  peer.dispatchEvent(new Event("signalingstatechange"));
  peer.signalingState = "closed";
  Object.defineProperty(peer, "remoteDescription", {
    get() {
      throw new Error("Firefox does not expose closed descriptions");
    },
  });
  peer.dispatchEvent(new Event("signalingstatechange"));
  const fields = {
    protocol: "udp",
    address: "192.0.2.20",
    port: "43210",
    type: "host",
  };
  assert.deepEqual(window.__rtcCandidates, [
    { gathered: [fields], retained: [fields] },
  ]);
  assert.doesNotMatch(
    JSON.stringify(window.__rtcCandidates),
    /never-log-this|omitted|ufrag|ice-pwd/,
  );
});

test("peer-state diagnostics omit SDP credentials from remote candidates", async () => {
  const candidate =
    "a=candidate:fixture 1 udp 123 192.0.2.20 43210 typ host generation 0 ufrag never-log-this";
  vi.stubGlobal("window", {
    __rtcPeers: [
      {
        connectionState: "checking",
        iceConnectionState: "checking",
        iceGatheringState: "complete",
        signalingState: "stable",
        remoteDescription: {
          sdp: `v=0\r\na=ice-pwd:also-never-log-this\r\n${candidate}\r\n`,
        },
      },
    ],
  });
  vi.stubGlobal("document", { querySelectorAll: () => [] });
  const states = await peerStates({ evaluate: async (read) => read() });
  assert.deepEqual(states.peers[0].remote, [
    "a=candidate:fixture 1 udp 123 192.0.2.20 43210 typ host",
  ]);
  assert.doesNotMatch(JSON.stringify(states), /never-log-this|ufrag|ice-pwd/);
});

test("keyboard failure diagnostics never inspect or print live panel text", async () => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  const page = {
    locator: () => {
      throw new Error("live panel text must not be inspected");
    },
    evaluate: async () => ({ peers: [], states: [] }),
  };
  try {
    await showKeyboardPeers(page, page);
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.includes("peer states")));
});
