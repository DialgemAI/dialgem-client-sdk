// @vitest-environment jsdom
import { createElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useDialgemCall, type UseDialgemCall } from "@dialgem/client/react"
import { fakePlatform } from "./fakes.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let latest: UseDialgemCall
let h: ReturnType<typeof fakePlatform>
let tokens: number

function Harness() {
  latest = useDialgemCall({
    getAccessToken: async () => `token-${++tokens}`,
    platform: h.platform,
  } as never)
  return null
}

const flush = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  h = fakePlatform()
  tokens = 0
  root = createRoot(document.createElement("div"))
  act(() => root.render(createElement(Harness)))
})
afterEach(() => act(() => root.unmount()))

async function startCall() {
  const before = h.sockets.length
  let started!: Promise<void>
  act(() => { started = latest.start() })
  await vi.waitFor(() => expect(h.sockets.length).toBe(before + 1))
  const ws = h.sockets.at(-1)!
  await act(async () => { ws.open(); await started })
  act(() => ws.text({ type: "session_started", session_id: "c-" + h.sockets.length }))
  return ws
}

describe("useDialgemCall", () => {
  it("starts idle with nothing in it", () => {
    expect(latest).toMatchObject({ state: "idle", transcript: [], agentSpeaking: false, muted: false, callId: null, error: null, endReason: null })
  })

  it("follows the call: state, id, and the transcript with a caller's line replaced as it settles", async () => {
    const ws = await startCall()
    expect(latest.state).toBe("active")
    expect(latest.callId).toBe("c-1")
    act(() => ws.text({ type: "transcript_partial", role: "user", text: "I want" }))
    act(() => ws.text({ type: "transcript_partial", role: "user", text: "I want a table" }))
    expect(latest.transcript.map((l) => [l.role, l.text, l.final])).toEqual([["user", "I want a table", false]])
    act(() => ws.text({ type: "transcript", role: "user", text: "I want a table for two." }))
    act(() => ws.text({ type: "transcript", role: "agent", text: "Certainly." }))
    expect(latest.transcript.map((l) => [l.role, l.text, l.final])).toEqual([
      ["user", "I want a table for two.", true],
      ["agent", "Certainly.", true],
    ])
    expect(new Set(latest.transcript.map((l) => l.id)).size).toBe(2)
  })

  it("reports the agent speaking and the microphone level", async () => {
    const ws = await startCall()
    act(() => ws.audio(32 * 300))
    expect(latest.agentSpeaking).toBe(true)
    act(() => h.nodes[0]!.capture(640, 0.6))
    expect(latest.level).toBe(0.6)
  })

  it("mute is reflected and reaches the call", async () => {
    await startCall()
    act(() => latest.setMuted(true))
    expect(latest.muted).toBe(true)
  })

  it("stop ends the call and says how", async () => {
    await startCall()
    act(() => latest.stop())
    expect(latest.state).toBe("ended")
    expect(latest.endReason).toBe("hangup")
  })

  it("a failure is state, not an exception the page has to catch", async () => {
    h.platform.getUserMedia = async () => { throw { name: "NotAllowedError" } }
    await act(async () => { await latest.start() })
    expect(latest.state).toBe("error")
    expect(latest.error?.code).toBe("mic_denied")
  })

  it("starting again after a call makes a new call with a new token and a clean slate", async () => {
    const first = await startCall()
    act(() => first.text({ type: "transcript", role: "agent", text: "Hi" }))
    act(() => latest.stop())
    expect(latest.transcript).toHaveLength(1)

    await startCall()
    expect(h.sockets).toHaveLength(2)
    expect(new URL(h.sockets[0]!.url).searchParams.get("web_token")).toBe("token-1")
    expect(new URL(h.sockets[1]!.url).searchParams.get("web_token")).toBe("token-2")
    expect(latest.transcript).toEqual([])
    expect(latest.endReason).toBeNull()
    expect(latest.state).toBe("active")
  })

  it("start while a call is running does nothing", async () => {
    await startCall()
    await act(async () => { await latest.start() })
    expect(h.sockets).toHaveLength(1)
  })

  it("unmounting hangs up", async () => {
    const ws = await startCall()
    act(() => root.unmount())
    expect(ws.texts.at(-1)).toBe("hangup")
    expect(h.tracks[0]!.stopped).toBe(true)
    root = createRoot(document.createElement("div"))   // so afterEach has something to unmount
    await flush()
  })
})
