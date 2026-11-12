import { Emitter } from "./emitter.js"
import { PcmPlayer } from "./player.js"
import {
  CAPTURE_CHUNK_SAMPLES,
  DEFAULT_BASE_URL,
  INIT_FRAME,
  SAMPLE_RATE,
  UrlError,
  buildCallUrl,
  describeClose,
  describeRefusal,
  parseServerFrame,
} from "./protocol.js"
import { WORKLET_NAME, WORKLET_SOURCE } from "./worklet.js"

export type CallState = "idle" | "connecting" | "active" | "ended" | "error"

/** How a call that started came to an end. */
export type EndReason =
  /** `stop()` was called. */
  | "hangup"
  /** The agent ended the call, or a call limit (maximum length, silence) did. */
  | "agent_ended"
  /** The connection dropped. The call cannot be resumed: start a new one. */
  | "connection_lost"

export type ErrorCode =
  /** The browser lacks something the call needs (WebSocket, Web Audio, AudioWorklet, a microphone API). */
  | "unsupported"
  /** The visitor refused microphone access, or it is blocked for this page. */
  | "mic_denied"
  /** No microphone, or it could not be opened. */
  | "mic_unavailable"
  /** `accessToken` was a function and it threw or returned nothing. */
  | "token_unavailable"
  /** The token was invalid, expired or already used, or this page's origin is not allowed. */
  | "refused"
  /** The organization has too many calls running. */
  | "busy"
  /** The server declined the call; `reason` says why (for example `insufficient_credit`). */
  | "call_refused"
  | "server_error"
  | "connection_failed"

export interface CallError {
  code: ErrorCode
  message: string
  /** For `call_refused`: the server's reason. */
  reason?: string | undefined
}

export interface TranscriptEvent {
  role: "user" | "agent"
  text: string
  /** False while the caller is still speaking (the words so far); true once the line is settled. */
  final: boolean
}

export interface CallEvents extends Record<string, unknown> {
  state: CallState
  started: { callId: string }
  transcript: TranscriptEvent
  agent_speaking: { speaking: boolean }
  /** The caller talked over the agent and its speech was cut off. */
  interrupted: Record<string, never>
  /** Microphone level, 0 to 1, about ten times a second. Not emitted while muted. */
  level: { level: number }
  ended: { reason: EndReason }
  error: CallError
}

export interface MicrophoneOptions {
  deviceId?: string | undefined
  /** Default true: without it the agent's own voice comes back through the microphone and it answers itself. */
  echoCancellation?: boolean | undefined
  noiseSuppression?: boolean | undefined
  autoGainControl?: boolean | undefined
}

export interface DialgemCallOptions {
  /**
   * The access token from your backend's `POST /v1/calls/web`, or a function that returns it. A function
   * is called **after** the visitor has allowed the microphone, because the token only lives 60 seconds and
   * the permission prompt can take longer than that.
   */
  accessToken: string | (() => string | Promise<string>)
  /** Only for a self-hosted deployment. Default `wss://api.dialgem.com`. */
  baseURL?: string | undefined
  microphone?: MicrophoneOptions | undefined
  /** @internal Stand-ins for the browser, for tests. */
  platform?: Partial<Platform> | undefined
}

/** What the call needs from the browser. */
export interface Platform {
  WebSocket: typeof WebSocket
  AudioContext: typeof AudioContext
  AudioWorkletNode: typeof AudioWorkletNode
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
  Blob: typeof Blob
}

const LEVEL_INTERVAL_MS = 100
/** A closing line is let finish playing, but never for longer than this. */
const MAX_DRAIN_MS = 10_000

function browser(): Partial<Platform> {
  const g = globalThis as unknown as Record<string, unknown>
  const nav = g["navigator"] as Navigator | undefined
  const url = g["URL"] as typeof URL | undefined
  const out: Partial<Platform> = {}
  if (g["WebSocket"]) out.WebSocket = g["WebSocket"] as Platform["WebSocket"]
  const audio = g["AudioContext"] ?? g["webkitAudioContext"]
  if (audio) out.AudioContext = audio as Platform["AudioContext"]
  if (g["AudioWorkletNode"]) out.AudioWorkletNode = g["AudioWorkletNode"] as Platform["AudioWorkletNode"]
  if (g["Blob"]) out.Blob = g["Blob"] as Platform["Blob"]
  if (nav?.mediaDevices?.getUserMedia) out.getUserMedia = (c) => nav.mediaDevices.getUserMedia(c)
  if (url?.createObjectURL) out.createObjectURL = (b) => url.createObjectURL(b)
  if (url?.revokeObjectURL) out.revokeObjectURL = (u) => url.revokeObjectURL(u)
  return out
}

/**
 * One conversation with one agent.
 *
 *   const call = new DialgemCall({ accessToken: () => fetch("/api/start-call").then((r) => r.text()) })
 *   call.on("transcript", (t) => ...)
 *   await call.start()      // from a click: browsers only let a page open the microphone and play sound after one
 *   ...
 *   call.stop()
 *
 * A call object is used once. Its token is single-use, so a second call needs a new object (and a new token).
 * There is no reconnecting: the conversation lives on the server for as long as the socket does, and a call
 * that drops has ended.
 */
export class DialgemCall extends Emitter<CallEvents> {
  private _state: CallState = "idle"
  private _muted = false
  private _callId: string | null = null
  private readonly platform: Platform

  private ctx: AudioContext | null = null
  /** Plays the agent. A 16 kHz context of its own, so the voice is not resampled chunk by chunk; see `start()`. */
  private playCtx: AudioContext | null = null
  private stream: MediaStream | null = null
  private ws: WebSocket | null = null
  private player: PcmPlayer | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private moduleUrl: string | null = null
  private speakingTimer: ReturnType<typeof setTimeout> | null = null
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private ending = false
  private pendingRefusal: string | null = null
  private failure: CallError | null = null
  private lastLevelAt = 0
  private speaking = false

  constructor(private readonly options: DialgemCallOptions) {
    super()
    this.platform = { ...browser(), ...(options.platform ?? {}) } as Platform
  }

  get state(): CallState {
    return this._state
  }

  /** Set once the call has started. */
  get callId(): string | null {
    return this._callId
  }

  get muted(): boolean {
    return this._muted
  }

  /**
   * Opens the microphone and the call. Call it directly from a click or tap: the browser decides whether the page
   * may play sound at the moment this runs, and a call started from a timer or after other awaits can be silent.
   * Resolves when the connection is open; the call has started when `started` fires. A failure is reported as an
   * `error` event and also rejects.
   */
  async start(): Promise<void> {
    if (this._state !== "idle") throw new Error("A call object can only be started once. Create a new DialgemCall for each call.")
    this.setState("connecting")
    const p = this.platform
    if (!p.WebSocket || !p.AudioContext || !p.AudioWorkletNode || !p.getUserMedia || !p.createObjectURL || !p.Blob) {
      throw this.fail({ code: "unsupported", message: "This browser cannot run voice calls (it needs WebSocket, Web Audio with AudioWorklet, and a microphone API)." })
    }

    // Synchronously, before any await: this is what a browser counts as "started by the visitor".
    try {
      this.ctx = new p.AudioContext()
      void this.ctx.resume()
    } catch {
      throw this.fail({ code: "unsupported", message: "This browser could not start audio." })
    }
    // The agent's voice arrives as many small 16 kHz buffers. On a 48 kHz context the browser resamples each
    // one on its own, and the joins between them can click. A context at the voice's own rate plays them as
    // they are and leaves one resample, of the whole stream, to the audio device. Capture stays on the default
    // context: Firefox refuses to connect a microphone to a context at another rate.
    try {
      this.playCtx = new p.AudioContext({ sampleRate: SAMPLE_RATE })
      void this.playCtx.resume()
    } catch {
      this.playCtx = this.ctx
    }
    this.player = new PcmPlayer(this.playCtx)

    const mic = this.options.microphone ?? {}
    try {
      this.stream = await p.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: mic.echoCancellation ?? true,
          noiseSuppression: mic.noiseSuppression ?? true,
          autoGainControl: mic.autoGainControl ?? true,
          ...(mic.deviceId ? { deviceId: { exact: mic.deviceId } } : {}),
        },
      })
    } catch (error) {
      const name = (error as { name?: string } | null)?.name ?? ""
      throw this.fail(
        name === "NotAllowedError" || name === "SecurityError"
          ? { code: "mic_denied", message: "Microphone access was denied. Allow the microphone for this page and try again." }
          : { code: "mic_unavailable", message: "The microphone could not be opened. Check that one is connected and not in use by another app." },
      )
    }
    if (this.dead()) return this.cleanup()

    try {
      this.moduleUrl = p.createObjectURL(new p.Blob([WORKLET_SOURCE], { type: "application/javascript" }))
      await this.ctx.audioWorklet.addModule(this.moduleUrl)
    } catch {
      throw this.fail({
        code: "unsupported",
        message: "The audio processor could not be loaded. If this page sets a Content-Security-Policy, allow blob: in script-src.",
      })
    }
    if (this.dead()) return this.cleanup()

    // The token is fetched last: it has 60 seconds, and everything above can take a visitor longer than that.
    let token: string
    try {
      const t = this.options.accessToken
      token = typeof t === "function" ? await t() : t
      if (!token) throw new Error("empty token")
    } catch {
      throw this.fail({ code: "token_unavailable", message: "Could not get an access token for the call." })
    }
    if (this.dead()) return this.cleanup()

    let url: string
    try {
      url = buildCallUrl(this.options.baseURL ?? DEFAULT_BASE_URL, token)
    } catch (error) {
      throw this.fail({ code: "connection_failed", message: error instanceof UrlError ? error.message : "Invalid call address." })
    }

    await new Promise<void>((resolve) => {
      const ws = new p.WebSocket(url)
      ws.binaryType = "arraybuffer"
      this.ws = ws
      ws.onopen = () => {
        ws.send(INIT_FRAME)
        resolve()
      }
      ws.onmessage = (event) => this.onMessage(event.data)
      ws.onerror = () => resolve()
      ws.onclose = (event) => {
        resolve()
        this.onClose(event.code)
      }
    })
    if (this.failure) throw this.fail(this.failure)
  }

  /** Ends the call. Safe to call at any time, any number of times. */
  stop(): void {
    if (this._state === "idle") {
      this.setState("ended")
      this.emit("ended", { reason: "hangup" })
      return
    }
    if (this._state !== "active" && this._state !== "connecting") return
    try {
      if (this.ws?.readyState === 1) this.ws.send("hangup")
    } catch {
      // closing anyway
    }
    this.finish("hangup")
  }

  /** While muted the agent hears silence. The call stays open. */
  setMuted(muted: boolean): void {
    this._muted = muted
    if (muted) this.emit("level", { level: 0 })
  }

  // ── server to client ──────────────────────────────────────────────────────────

  private onMessage(data: unknown): void {
    if (typeof data !== "string") {
      if (data instanceof ArrayBuffer) this.onAudio(data)
      return
    }
    const frame = parseServerFrame(data)
    switch (frame.type) {
      case "session_started":
        this.onStarted(frame.sessionId)
        break
      case "transcript":
        this.emit("transcript", { role: frame.role, text: frame.text, final: true })
        break
      case "transcript_partial":
        this.emit("transcript", { role: "user", text: frame.text, final: false })
        break
      case "agent_interrupted":
        this.player?.interrupt()
        this.setSpeaking(false)
        this.emit("interrupted", {})
        break
      case "call_ended":
        this.onCallEnded()
        break
      case "error":
        // The close that follows carries the code; this carries the reason.
        this.pendingRefusal = frame.reason
        break
      case "ignored":
        break
    }
  }

  private onStarted(sessionId: string): void {
    if (this._state !== "connecting" || !this.ctx || !this.stream) return
    this._callId = sessionId || null
    this.setState("active")

    const ctx = this.ctx
    this.source = ctx.createMediaStreamSource(this.stream)
    this.node = new this.platform.AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: SAMPLE_RATE, chunkSamples: CAPTURE_CHUNK_SAMPLES },
    })
    // Muted to the speakers: the node only needs to be pulled by the graph.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node)
    this.node.connect(this.sink)
    this.sink.connect(ctx.destination)
    this.node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => this.onCaptured(event.data)

    this.emit("started", { callId: this._callId ?? "" })
  }

  private onCaptured(frame: { pcm: ArrayBuffer; peak: number }): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1 || this.ending) return
    // Muted: silence of the same length, so the server's speech detection keeps its rhythm instead of seeing a gap.
    ws.send(this._muted ? new ArrayBuffer(frame.pcm.byteLength) : frame.pcm)
    const now = Date.now()
    if (!this._muted && now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      this.lastLevelAt = now
      this.emit("level", { level: Math.min(1, frame.peak) })
    }
  }

  private onAudio(data: ArrayBuffer): void {
    if (this._state !== "active" || !this.player) return
    this.player.feed(data)
    this.setSpeaking(true)
    // Speaking until the queued audio has played out, not for a fixed time after the last frame.
    if (this.speakingTimer) clearTimeout(this.speakingTimer)
    this.speakingTimer = setTimeout(() => this.setSpeaking(false), this.player.remainingMs() + 50)
  }

  private setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return
    this.speaking = speaking
    if (!speaking && this.speakingTimer) {
      clearTimeout(this.speakingTimer)
      this.speakingTimer = null
    }
    this.emit("agent_speaking", { speaking })
  }

  private onCallEnded(): void {
    if (this.ending || this.dead()) return
    // Everything has been sent, but a goodbye can still be mid-sentence in the speaker: let it finish.
    this.ending = true
    const wait = Math.min(MAX_DRAIN_MS, (this.player?.remainingMs() ?? 0) + 50)
    this.drainTimer = setTimeout(() => this.finish("agent_ended"), wait)
  }

  private onClose(code: number): void {
    if (this.dead()) return
    if (this._state === "active") {
      // A graceful end already has its own timer; a close during it must not cut the goodbye short.
      if (!this.ending) this.finish("connection_lost")
      return
    }
    if (this.pendingRefusal) {
      this.fail({ ...describeRefusal(this.pendingRefusal), reason: this.pendingRefusal })
      return
    }
    this.fail(describeClose(code))
  }

  // ── ending ────────────────────────────────────────────────────────────────────

  private dead(): boolean {
    return this._state === "ended" || this._state === "error"
  }

  /** Ends the call as failed and reports it once. Returns the error, for `start()` to throw. */
  private fail(error: CallError): Error {
    if (!this.dead()) {
      this.failure = error
      this.cleanup()
      this.setState("error")
      this.emit("error", error)
    }
    const shown = this.failure ?? error
    return Object.assign(new Error(shown.message), { code: shown.code, reason: shown.reason })
  }

  private finish(reason: EndReason): void {
    if (this.dead()) return
    this.cleanup()
    this.setState("ended")
    this.emit("ended", { reason })
  }

  private setState(state: CallState): void {
    this._state = state
    this.emit("state", state)
  }

  private cleanup(): void {
    this.ending = true
    for (const t of [this.speakingTimer, this.drainTimer]) if (t) clearTimeout(t)
    this.speakingTimer = this.drainTimer = null
    if (this.speaking) {
      this.speaking = false
      this.emit("agent_speaking", { speaking: false })
    }
    this.player?.interrupt()
    if (this.node) {
      this.node.port.onmessage = null
      try {
        this.node.disconnect()
      } catch {
        // already disconnected
      }
    }
    try {
      this.source?.disconnect()
      this.sink?.disconnect()
    } catch {
      // already disconnected
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    if (this.ws) {
      this.ws.onmessage = this.ws.onerror = this.ws.onopen = null
      try {
        this.ws.close()
      } catch {
        // already closed
      }
    }
    if (this.moduleUrl) this.platform.revokeObjectURL?.(this.moduleUrl)
    void this.ctx?.close().catch(() => undefined)
    if (this.playCtx && this.playCtx !== this.ctx) void this.playCtx.close().catch(() => undefined)
    this.playCtx = null
    this.node = this.source = this.sink = this.stream = this.ctx = this.player = null
    this.moduleUrl = null
  }
}
