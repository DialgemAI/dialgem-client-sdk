#!/usr/bin/env node
/**
 * Runtime smoke test of the BUILT package (dist/), with no test framework: it loads both entry points
 * (ESM and CJS), checks the public surface, and runs a whole call through fake browser parts, so a
 * broken build (a missing export, a bundling mistake) fails here and not in a customer's bundler.
 *
 * The React entry is checked for its exports only: it needs React, which this script does not install.
 *
 * Usage:  pnpm build && pnpm smoke
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const esm = await import("../dist/index.js")
const cjs = require("../dist/index.cjs")

for (const [label, sdk] of [["esm", esm], ["cjs", cjs]]) {
  assert.equal(typeof sdk.DialgemCall, "function", `${label}: DialgemCall`)
  assert.equal(sdk.VERSION, pkg.version, `${label}: version`)
  assert.equal(sdk.DEFAULT_BASE_URL, "wss://api.dialgem.com", `${label}: fixed address`)
  assert.equal(sdk.SAMPLE_RATE, 16000, `${label}: sample rate`)

  const sockets = []
  class Socket {
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; sockets.push(this) }
    send(d) { this.sent.push(d) }
    close() { this.readyState = 3 }
  }
  class Context {
    constructor() { this.currentTime = 0; this.destination = {}; this.audioWorklet = { addModule: async () => {} } }
    resume() { return Promise.resolve() }
    close() { return Promise.resolve() }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
  }
  class Node {
    constructor() { this.port = { onmessage: null } }
    connect() {}
    disconnect() {}
  }
  const call = new sdk.DialgemCall({
    accessToken: "smoke-token",
    platform: {
      WebSocket: Socket, AudioContext: Context, AudioWorkletNode: Node, Blob: class {},
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      createObjectURL: () => "blob:x", revokeObjectURL() {},
    },
  })
  const events = []
  call.on("state", (s) => events.push(s))
  const started = call.start()
  await new Promise((r) => setTimeout(r, 10))
  const ws = sockets[0]
  assert.match(ws.url, /^wss:\/\/api\.dialgem\.com\/v1\/agent\/call\?/, `${label}: address`)
  assert.equal(new URL(ws.url).searchParams.get("web_token"), "smoke-token", `${label}: token`)
  ws.readyState = 1
  ws.onopen()
  await started
  ws.onmessage({ data: JSON.stringify({ type: "session_started", session_id: "c1" }) })
  assert.equal(call.state, "active", `${label}: active`)
  call.stop()
  assert.deepEqual(events, ["connecting", "active", "ended"], `${label}: states`)
  assert.equal(ws.sent.at(-1), "hangup", `${label}: hangup`)
}

const react = await import("../dist/react.js")
assert.equal(typeof react.useDialgemCall, "function", "react entry exports the hook")
assert.equal(typeof require("../dist/react.cjs").useDialgemCall, "function", "react entry (cjs)")
console.log(`ok: @dialgem/client ${pkg.version} (esm + cjs)`)
