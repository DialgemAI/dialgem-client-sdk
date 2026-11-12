import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DialgemCall, type CallEvents, type DialgemCallOptions } from "@dialgem/client"
import { fakePlatform } from "./fakes.js"

type Harness = ReturnType<typeof fakePlatform>

function setup(opts: Parameters<typeof fakePlatform>[0] = {}, options: Partial<DialgemCallOptions> = {}) {
  const h: Harness = fakePlatform(opts)
  const call = new DialgemCall({
    accessToken: () => {
      h.markToken()
      return "tok-123"
    },
    platform: h.platform,
    ...options,
  })
  const seen: { [K in keyof CallEvents]?: CallEvents[K][] } = {}
  for (const name of ["state", "started", "transcript", "agent_speaking", "interrupted", "level", "ended", "error"] as const) {
    call.on(name, ((p: never) => ((seen[name] ??= []) as unknown[]).push(p)) as never)
  }
  return { h, call, seen }
}

/** Starts the call and completes the handshake the way the server does. */
async function connected(args: ReturnType<typeof setup>) {
  const started = args.call.start()
  await vi.waitFor(() => expect(args.h.sockets).toHaveLength(1))
  const ws = args.h.sockets[0]!
  ws.open()
  await started
  ws.text({ type: "session_started", session_id: "call-1" })
  return ws
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
})
afterEach(() => vi.useRealTimers())

describe("starting a call", () => {
  it("opens audio in the click, then the microphone, then fetches the token, then connects, in that order", async () => {
    const a = setup()
    await connected(a)
    expect(a.h.log).toEqual(["ctx", "play-ctx", "mic", "token", "ws"])
    expect(a.h.contexts[0]!.resumed).toBe(true)
    expect(a.h.contexts[1]!.resumed).toBe(true)
  })

  it("creates and resumes the audio context synchronously inside start(), before anything is awaited", () => {
    const a = setup()
    void a.call.start().catch(() => undefined)
    // No await has happened yet: this is the moment the browser still counts as the visitor's click.
    expect(a.h.contexts).toHaveLength(2)
    expect(a.h.contexts[0]!.resumed).toBe(true)
    expect(a.h.contexts[1]!.resumed).toBe(true)
    expect(a.h.log.slice(0, 2)).toEqual(["ctx", "play-ctx"])
  })

  it("captures on the default context and plays the agent on a 16 kHz one, so the voice is not resampled per chunk", async () => {
    const a = setup()
    const ws = await connected(a)
    const [capture, playback] = a.h.contexts
    expect(capture!.sampleRate).toBeNull()
    expect(playback!.sampleRate).toBe(16_000)
    expect(capture!.mediaSources).toHaveLength(1)
    ws.audio(32 * 100)
    expect(playback!.sources).toHaveLength(1)
    expect(capture!.sources).toHaveLength(0)
  })

  it("plays on the default context when the browser cannot make a 16 kHz one", async () => {
    const a = setup({ noPlaybackRate: true })
    const ws = await connected(a)
    expect(a.h.contexts).toHaveLength(1)
    ws.audio(32 * 100)
    expect(a.h.contexts[0]!.sources).toHaveLength(1)
  })

  it("closes both audio contexts when the call ends", async () => {
    const a = setup()
    await connected(a)
    a.call.stop()
    expect(a.h.contexts.map((c) => c.closed)).toEqual([true, true])
  })

  it("loads the capture processor from a blob it revokes afterwards", async () => {
    const a = setup()
    await connected(a)
    expect(a.h.contexts[0]!.modules).toEqual(["blob:fake-module"])
    a.call.stop()
    expect(a.h.revoked).toEqual(["blob:fake-module"])
  })

  it("sends the init frame on open, and only the token goes to the server", async () => {
    const a = setup()
    const ws = await connected(a)
    expect(ws.texts[0]).toBe('{"agent_config":{}}')
    const url = new URL(ws.url)
    expect(Object.fromEntries(url.searchParams)).toEqual({ web_token: "tok-123", live_transcript: "1" })
    expect(ws.binaryType).toBe("arraybuffer")
  })

  it("becomes active and reports the call id when the server says the session started", async () => {
    const a = setup()
    await connected(a)
    expect(a.call.state).toBe("active")
    expect(a.call.callId).toBe("call-1")
    expect(a.seen.started).toEqual([{ callId: "call-1" }])
    expect(a.seen.state).toEqual(["connecting", "active"])
  })

  it("accepts a plain string token", async () => {
    const a = setup({}, { accessToken: "plain-token" })
    const ws = await connected(a)
    expect(new URL(ws.url).searchParams.get("web_token")).toBe("plain-token")
  })

  it("awaits an async token function", async () => {
    const a = setup({}, { accessToken: async () => "later" })
    const ws = await connected(a)
    expect(new URL(ws.url).searchParams.get("web_token")).toBe("later")
  })

  it("asks the browser for echo cancellation, noise suppression and gain control by default", async () => {
    const calls: MediaStreamConstraints[] = []
    const h = fakePlatform()
    const gum = h.platform.getUserMedia
    h.platform.getUserMedia = (c) => (calls.push(c ?? {}), gum(c))
    const call = new DialgemCall({ accessToken: "t", platform: h.platform, microphone: { deviceId: "mic-2", noiseSuppression: false } })
    void call.start().catch(() => undefined)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.audio).toEqual({
      channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true, deviceId: { exact: "mic-2" },
    })
  })

  it("a call object can be started only once", async () => {
    const a = setup()
    await connected(a)
    await expect(a.call.start()).rejects.toThrow(/only be started once/)
  })
})

describe("when it cannot start", () => {
  it.each([
    [{ name: "NotAllowedError" }, "mic_denied"],
    [{ name: "SecurityError" }, "mic_denied"],
    [{ name: "NotFoundError" }, "mic_unavailable"],
    [{ name: "NotReadableError" }, "mic_unavailable"],
  ])("microphone error %j is %s, reported once, and no token is fetched", async (micError, code) => {
    const a = setup({ micError })
    await expect(a.call.start()).rejects.toMatchObject({ code })
    expect(a.call.state).toBe("error")
    expect(a.seen.error).toHaveLength(1)
    expect(a.seen.error![0]!.code).toBe(code)
    expect(a.h.log).not.toContain("token")
    expect(a.h.sockets).toHaveLength(0)
    expect(a.h.contexts[0]!.closed).toBe(true)
  })

  it("reports a platform without what it needs as unsupported", async () => {
    const h = fakePlatform()
    const call = new DialgemCall({ accessToken: "t", platform: { ...h.platform, AudioWorkletNode: undefined as never } })
    await expect(call.start()).rejects.toMatchObject({ code: "unsupported" })
  })

  it("explains a blocked audio processor (a Content-Security-Policy without blob:)", async () => {
    const a = setup({ moduleError: true })
    await expect(a.call.start()).rejects.toMatchObject({ code: "unsupported" })
    expect(a.seen.error![0]!.message).toMatch(/blob:/)
    expect(a.h.tracks[0]!.stopped).toBe(true)
  })

  it("reports a token function that throws or returns nothing, and releases the microphone", async () => {
    for (const accessToken of [() => { throw new Error("backend down") }, async () => "", async () => Promise.reject(new Error("x"))]) {
      const a = setup({}, { accessToken })
      await expect(a.call.start()).rejects.toMatchObject({ code: "token_unavailable" })
      expect(a.h.tracks[0]!.stopped).toBe(true)
      expect(a.h.sockets).toHaveLength(0)
    }
  })

  it("refuses a plaintext address for a remote host before connecting", async () => {
    const a = setup({}, { baseURL: "ws://api.example.com" })
    await expect(a.call.start()).rejects.toMatchObject({ code: "connection_failed" })
    expect(a.h.sockets).toHaveLength(0)
  })

  it.each([[1008, "refused"], [1013, "busy"], [1011, "server_error"], [1006, "connection_failed"]])(
    "a socket closed with %i before the call started is %s",
    async (close, code) => {
      const a = setup()
      const started = a.call.start()
      await vi.waitFor(() => expect(a.h.sockets).toHaveLength(1))
      a.h.sockets[0]!.serverClose(close)
      await expect(started).rejects.toMatchObject({ code })
      expect(a.seen.error).toHaveLength(1)
      expect(a.call.state).toBe("error")
      expect(a.h.tracks[0]!.stopped).toBe(true)
      expect(a.h.contexts[0]!.closed).toBe(true)
    },
  )

  it("reports the server's own reason when it declined the call", async () => {
    const a = setup()
    const started = a.call.start()
    await vi.waitFor(() => expect(a.h.sockets).toHaveLength(1))
    const ws = a.h.sockets[0]!
    ws.open()
    await started
    ws.text({ error: "org_suspended", disconnection_reason: "org_suspended", issues: [] })
    ws.serverClose(1008)
    expect(a.seen.error![0]).toMatchObject({ code: "call_refused", reason: "org_suspended" })
    expect(a.call.state).toBe("error")
  })

  it.each([
    ["origin_not_allowed", 1008, "refused"], ["token_expired", 1008, "refused"], ["token_already_used", 1008, "refused"],
    ["token_invalid", 1008, "refused"], ["concurrency_limit_reached", 1013, "busy"],
  ])("a call refused with the reason %s (the server accepts, explains, then closes) is %s", async (reason, close, code) => {
    // The browser never sees the close code of a socket refused before it was accepted, only an abnormal close; the
    // reason frame is what tells these apart.
    const a = setup()
    const started = a.call.start()
    await vi.waitFor(() => expect(a.h.sockets).toHaveLength(1))
    const ws = a.h.sockets[0]!
    ws.open()
    await started
    ws.text({ error: reason, disconnection_reason: reason })
    ws.serverClose(close)
    expect(a.seen.error).toHaveLength(1)
    expect(a.seen.error![0]).toMatchObject({ code, reason })
    expect(a.call.state).toBe("error")
  })

  it("a socket the browser reports as abnormally closed with no reason is a plain connection failure", async () => {
    const a = setup()
    const started = a.call.start()
    await vi.waitFor(() => expect(a.h.sockets).toHaveLength(1))
    a.h.sockets[0]!.serverClose(1006)
    await expect(started).rejects.toMatchObject({ code: "connection_failed" })
  })

  it("stop() while still connecting cancels without an error and releases everything", async () => {
    const a = setup()
    const started = a.call.start()
    await vi.waitFor(() => expect(a.h.sockets).toHaveLength(1))
    a.call.stop()
    a.h.sockets[0]!.serverClose(1000)
    await started.catch(() => undefined)
    expect(a.call.state).toBe("ended")
    expect(a.seen.ended).toEqual([{ reason: "hangup" }])
    expect(a.seen.error).toBeUndefined()
    expect(a.h.tracks[0]!.stopped).toBe(true)
  })

  it("stop() while the microphone prompt is open leaves no microphone running once it is answered", async () => {
    const h = fakePlatform()
    let release!: () => void
    const gum = h.platform.getUserMedia
    h.platform.getUserMedia = (c) => new Promise((res) => (release = () => res(gum(c))))
    const call = new DialgemCall({ accessToken: "t", platform: h.platform })
    const started = call.start().catch(() => undefined)
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    call.stop()
    release()
    await started
    expect(h.tracks[0]!.stopped).toBe(true)
    expect(h.sockets).toHaveLength(0)
  })
})

describe("during the call", () => {
  it("sends the microphone to the server and wires the capture graph through a silent output", async () => {
    const a = setup()
    const ws = await connected(a)
    const node = a.h.nodes[0]!
    expect(node.name).toBe("dialgem-capture")
    expect(node.options).toMatchObject({ processorOptions: { targetRate: 16_000, chunkSamples: 640 } })
    expect(a.h.contexts[0]!.gains[0]!.gain.value).toBe(0)
    node.capture(640, 0.4)
    expect(ws.binaries).toHaveLength(1)
    expect(ws.binaries[0]!.byteLength).toBe(1280)
    expect(new Int16Array(ws.binaries[0]!)[0]).toBe(1)
  })

  it("does not send audio before the session has started", async () => {
    const a = setup()
    const started = a.call.start()
    await vi.waitFor(() => expect(a.h.sockets).toHaveLength(1))
    a.h.sockets[0]!.open()
    await started
    expect(a.h.nodes).toHaveLength(0)
  })

  it("reports the microphone level about ten times a second", async () => {
    const a = setup()
    await connected(a)
    const node = a.h.nodes[0]!
    node.capture(640, 0.4)
    node.capture(640, 0.9)               // too soon after the last report
    vi.advanceTimersByTime(120)
    node.capture(640, 0.7)
    expect(a.seen.level).toEqual([{ level: 0.4 }, { level: 0.7 }])
  })

  it("while muted the agent hears silence of the same length, and no level is reported", async () => {
    const a = setup()
    const ws = await connected(a)
    a.call.setMuted(true)
    expect(a.call.muted).toBe(true)
    a.h.nodes[0]!.capture(640, 0.9, 5)
    const sent = new Int16Array(ws.binaries.at(-1)!)
    expect(sent.length).toBe(640)
    expect(sent.every((s) => s === 0)).toBe(true)
    expect(a.seen.level).toEqual([{ level: 0 }])
    a.call.setMuted(false)
    vi.advanceTimersByTime(200)
    a.h.nodes[0]!.capture(640, 0.5, 5)
    expect(new Int16Array(ws.binaries.at(-1)!)[0]).toBe(5)
  })

  it("surfaces what the caller and the agent say", async () => {
    const a = setup()
    const ws = await connected(a)
    ws.text({ type: "transcript_partial", role: "user", text: "I'd like to" })
    ws.text({ type: "transcript", role: "user", text: "I'd like to book." })
    ws.text({ type: "transcript", role: "agent", text: "Of course." })
    ws.text({ type: "transcript_word", word: "Of" })       // not part of the public events
    expect(a.seen.transcript).toEqual([
      { role: "user", text: "I'd like to", final: false },
      { role: "user", text: "I'd like to book.", final: true },
      { role: "agent", text: "Of course.", final: true },
    ])
  })

  it("plays the agent's audio, says when it is speaking, and says when it has finished", async () => {
    const a = setup()
    const ws = await connected(a)
    const ctx = a.h.contexts[1]!
    ws.audio(32 * 500)                                      // 500 ms of speech
    expect(ctx.sources).toHaveLength(1)
    expect(a.seen.agent_speaking).toEqual([{ speaking: true }])
    vi.advanceTimersByTime(400)
    expect(a.seen.agent_speaking).toEqual([{ speaking: true }])
    vi.advanceTimersByTime(200)
    expect(a.seen.agent_speaking).toEqual([{ speaking: true }, { speaking: false }])
  })

  it("an interruption silences the agent at once", async () => {
    const a = setup()
    const ws = await connected(a)
    ws.audio(32 * 1000)
    ws.text({ type: "agent_interrupted" })
    expect(a.h.contexts[1]!.sources.length).toBeGreaterThan(0)
    expect(a.h.contexts[1]!.sources.every((s) => s.stopped)).toBe(true)
    expect(a.seen.interrupted).toHaveLength(1)
    expect(a.seen.agent_speaking).toEqual([{ speaking: true }, { speaking: false }])
  })

  it("ignores audio that arrives before the call is active or after it ended", async () => {
    const a = setup()
    const started = a.call.start()
    await vi.waitFor(() => expect(a.h.sockets).toHaveLength(1))
    const ws = a.h.sockets[0]!
    ws.open()
    await started
    ws.audio(640)
    expect(a.h.contexts.flatMap((c) => c.sources)).toHaveLength(0)
  })

  it("ignores malformed and unknown frames", async () => {
    const a = setup()
    const ws = await connected(a)
    ws.text("{not json")
    ws.text({ type: "something_new" })
    ws.text({ type: "function_call", name: "x" })
    expect(a.call.state).toBe("active")
  })
})

describe("ending", () => {
  it("stop() says goodbye to the server, releases everything, and ends once", async () => {
    const a = setup()
    const ws = await connected(a)
    a.call.stop()
    a.call.stop()
    expect(ws.texts.at(-1)).toBe("hangup")
    expect(ws.closedByClient).toBe(true)
    expect(a.h.tracks[0]!.stopped).toBe(true)
    expect(a.h.contexts[0]!.closed).toBe(true)
    expect(a.h.nodes[0]!.disconnected).toBe(true)
    expect(a.h.nodes[0]!.port.onmessage).toBeNull()
    expect(a.seen.ended).toEqual([{ reason: "hangup" }])
    expect(a.call.state).toBe("ended")
  })

  it("stops sending microphone audio the moment the call ends", async () => {
    const a = setup()
    const ws = await connected(a)
    const node = a.h.nodes[0]!
    a.call.stop()
    const before = ws.binaries.length
    node.capture()
    expect(ws.binaries.length).toBe(before)
  })

  it("when the agent ends the call a goodbye still playing is allowed to finish", async () => {
    const a = setup()
    const ws = await connected(a)
    ws.audio(32 * 2000)                                      // 2 s of goodbye
    ws.text({ type: "call_ended" })
    ws.serverClose(1000)                                     // the server drops the socket right after
    vi.advanceTimersByTime(1500)
    expect(a.call.state).toBe("active")
    vi.advanceTimersByTime(700)
    expect(a.call.state).toBe("ended")
    expect(a.seen.ended).toEqual([{ reason: "agent_ended" }])
  })

  it("never waits more than ten seconds for playback", async () => {
    const a = setup()
    const ws = await connected(a)
    ws.audio(32 * 60_000)
    ws.text({ type: "call_ended" })
    vi.advanceTimersByTime(10_100)
    expect(a.seen.ended).toEqual([{ reason: "agent_ended" }])
  })

  it("a call that ends with nothing playing ends straight away", async () => {
    const a = setup()
    const ws = await connected(a)
    ws.text({ type: "call_ended" })
    vi.advanceTimersByTime(60)
    expect(a.seen.ended).toEqual([{ reason: "agent_ended" }])
  })

  it("a dropped connection ends the call as lost, not as an error, and releases the microphone", async () => {
    const a = setup()
    const ws = await connected(a)
    ws.serverClose(1006)
    expect(a.seen.ended).toEqual([{ reason: "connection_lost" }])
    expect(a.seen.error).toBeUndefined()
    expect(a.h.tracks[0]!.stopped).toBe(true)
  })

  it("hanging up during the goodbye ends it immediately", async () => {
    const a = setup()
    const ws = await connected(a)
    ws.audio(32 * 5000)
    ws.text({ type: "call_ended" })
    a.call.stop()
    expect(a.seen.ended).toEqual([{ reason: "hangup" }])
    vi.advanceTimersByTime(20_000)
    expect(a.seen.ended).toHaveLength(1)
  })

  it("stop() on a call that never started just ends it", () => {
    const a = setup()
    a.call.stop()
    expect(a.call.state).toBe("ended")
    expect(a.seen.ended).toEqual([{ reason: "hangup" }])
  })

  it("a handler that throws does not stop the call or the other handlers", async () => {
    const a = setup()
    const reported: unknown[] = []
    const original = (globalThis as { reportError?: unknown }).reportError
    ;(globalThis as { reportError?: (e: unknown) => void }).reportError = (e) => void reported.push(e)
    try {
      a.call.on("transcript", () => {
        throw new Error("bug in the page")
      })
      const later = vi.fn()
      a.call.on("transcript", later)
      const ws = await connected(a)
      ws.text({ type: "transcript", role: "agent", text: "hi" })
      expect(later).toHaveBeenCalledOnce()
      expect(reported).toHaveLength(1)
      expect(a.call.state).toBe("active")
    } finally {
      ;(globalThis as { reportError?: unknown }).reportError = original
    }
  })

  it("an unsubscribed handler is not called again", async () => {
    const a = setup()
    const h = vi.fn()
    const off = a.call.on("transcript", h)
    off()
    const ws = await connected(a)
    ws.text({ type: "transcript", role: "agent", text: "hi" })
    expect(h).not.toHaveBeenCalled()
  })
})
