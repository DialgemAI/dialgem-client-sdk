import type { Platform } from "../src/call.js"

/** A WebSocket the test drives by hand. */
export class FakeSocket {
  readyState = 0
  binaryType = ""
  sent: (string | ArrayBuffer)[] = []
  closedByClient = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {}

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }
  close(): void {
    this.closedByClient = true
    this.readyState = 3
  }

  // test controls
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  text(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) })
  }
  audio(bytes: number, riff = false): void {
    const buf = new ArrayBuffer(bytes)
    if (riff) new Uint8Array(buf).set([0x52, 0x49, 0x46, 0x46])
    this.onmessage?.({ data: buf })
  }
  serverClose(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
  get texts(): string[] {
    return this.sent.filter((s): s is string => typeof s === "string")
  }
  get binaries(): ArrayBuffer[] {
    return this.sent.filter((s): s is ArrayBuffer => typeof s !== "string")
  }
}

class FakeSource {
  buffer: { duration: number } | null = null
  started: number | null = null
  stopped = false
  onended: (() => void) | null = null
  connect(): void {}
  start(when: number): void {
    this.started = when
  }
  stop(): void {
    this.stopped = true
  }
}

export class FakeContext {
  currentTime = 0
  destination = {}
  resumed = false
  closed = false
  modules: string[] = []
  sources: FakeSource[] = []
  gains: { gain: { value: number }; connect(): void; disconnect(): void }[] = []
  mediaSources: { stream: unknown; connected: unknown[]; disconnected: boolean }[] = []
  audioWorklet = { addModule: async (url: string) => void this.modules.push(url) }

  resume(): Promise<void> {
    this.resumed = true
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, length, rate, copyToChannel: () => {} }
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource()
    this.sources.push(s)
    return s
  }
  createGain() {
    const g = { gain: { value: 1 }, connect() {}, disconnect() {} }
    this.gains.push(g)
    return g
  }
  createMediaStreamSource(stream: unknown) {
    const s = { stream, connected: [] as unknown[], disconnected: false, connect(n: unknown) { this.connected.push(n) }, disconnect() { this.disconnected = true } }
    this.mediaSources.push(s)
    return s
  }
}

export class FakeNode {
  port: { onmessage: ((e: { data: { pcm: ArrayBuffer; peak: number } }) => void) | null } = { onmessage: null }
  disconnected = false
  connectedTo: unknown[] = []
  constructor(readonly ctx: unknown, readonly name: string, readonly options: Record<string, unknown>) {}
  connect(n: unknown): void {
    this.connectedTo.push(n)
  }
  disconnect(): void {
    this.disconnected = true
  }
  capture(samples = 640, peak = 0.5, fill = 1): void {
    const pcm = new Int16Array(samples).fill(fill).buffer
    this.port.onmessage?.({ data: { pcm, peak } })
  }
}

export class FakeTrack {
  stopped = false
  stop(): void {
    this.stopped = true
  }
}

/** Everything the call created, and the order it did things in. */
export function fakePlatform(opts: { micError?: { name: string } | null; token?: () => Promise<string> | string; moduleError?: boolean } = {}) {
  const log: string[] = []
  const sockets: FakeSocket[] = []
  const contexts: FakeContext[] = []
  const nodes: FakeNode[] = []
  const tracks: FakeTrack[] = []
  const revoked: string[] = []
  let gesture = true

  const platform = {
    WebSocket: class extends FakeSocket {
      constructor(url: string) {
        super(url)
        log.push("ws")
        sockets.push(this)
      }
    } as unknown as Platform["WebSocket"],
    AudioContext: class extends FakeContext {
      constructor() {
        super()
        log.push(gesture ? "ctx" : "ctx-late")
        contexts.push(this)
        if (opts.moduleError) this.audioWorklet.addModule = () => Promise.reject(new Error("csp"))
      }
    } as unknown as Platform["AudioContext"],
    AudioWorkletNode: class extends FakeNode {
      constructor(ctx: unknown, name: string, options: Record<string, unknown>) {
        super(ctx, name, options)
        nodes.push(this)
      }
    } as unknown as Platform["AudioWorkletNode"],
    Blob: class {
      constructor(readonly parts: unknown[], readonly options: unknown) {}
    } as unknown as Platform["Blob"],
    getUserMedia: async (_constraints?: MediaStreamConstraints): Promise<MediaStream> => {
      log.push("mic")
      gesture = false
      if (opts.micError) throw opts.micError
      const t = new FakeTrack()
      tracks.push(t)
      return { getTracks: () => [t] } as unknown as MediaStream
    },
    createObjectURL: () => "blob:fake-module",
    revokeObjectURL: (u: string) => void revoked.push(u),
  } satisfies Platform

  return { platform, log, sockets, contexts, nodes, tracks, revoked, markToken: () => log.push("token") }
}
