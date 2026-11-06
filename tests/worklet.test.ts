import vm from "node:vm"

import { describe, expect, it } from "vitest"

import { CAPTURE_CHUNK_SAMPLES } from "../src/protocol.js"
import { WORKLET_NAME, WORKLET_SOURCE } from "../src/worklet.js"

/** Runs the real worklet text the way the audio thread would, at a chosen device rate. */
function processor(sampleRate: number, options: Record<string, unknown> = {}) {
  const posted: { pcm: ArrayBuffer; peak: number }[] = []
  let registered: { name: string; ctor: new (o?: unknown) => { process(i: Float32Array[][]): boolean; port: unknown } } | null = null
  class AudioWorkletProcessor {
    port = { postMessage: (m: { pcm: ArrayBuffer; peak: number }) => void posted.push(m) }
  }
  vm.runInNewContext(WORKLET_SOURCE, {
    AudioWorkletProcessor,
    sampleRate,
    Int16Array,
    registerProcessor: (name: string, ctor: never) => (registered = { name, ctor }),
  })
  const node = new registered!.ctor({ processorOptions: options })
  const feed = (samples: Float32Array, block = 128) => {
    for (let i = 0; i < samples.length; i += block) node.process([[samples.subarray(i, i + block)]])
  }
  return { posted, registered: registered!, node, feed }
}

const pcm = (m: { pcm: ArrayBuffer }) => new Int16Array(m.pcm)
const all = (posted: { pcm: ArrayBuffer }[]) => posted.flatMap((m) => [...pcm(m)])

describe("the capture worklet", () => {
  it("registers itself under the name the SDK loads it by", () => {
    expect(processor(48_000).registered.name).toBe(WORKLET_NAME)
  })

  it.each([48_000, 44_100, 32_000, 16_000])("turns %i Hz into 16 kHz: one second in is 16000 samples out", (rate) => {
    const { posted, feed } = processor(rate)
    feed(new Float32Array(rate).fill(0.25))
    const samples = all(posted).length + 0
    // Whole chunks only: the remainder waits for the next block.
    expect(samples).toBe(Math.floor(16_000 / CAPTURE_CHUNK_SAMPLES) * CAPTURE_CHUNK_SAMPLES)
    expect(posted.every((m) => pcm(m).length === CAPTURE_CHUNK_SAMPLES)).toBe(true)
  })

  it("keeps the level: a steady signal stays steady through the averaging", () => {
    const { posted, feed } = processor(44_100)
    feed(new Float32Array(44_100).fill(0.5))
    for (const s of all(posted)) expect(Math.abs(s - 16383)).toBeLessThanOrEqual(1)
  })

  it("keeps the sign and clamps what is out of range", () => {
    const { posted, feed } = processor(16_000, { chunkSamples: 4 })
    feed(Float32Array.from([1.5, -1.5, 1, -1]), 4)
    expect(all(posted)).toEqual([32767, -32768, 32767, -32768])
  })

  it("reports the loudest input in the chunk and starts over for the next one", () => {
    const { posted, feed } = processor(16_000, { chunkSamples: 4 })
    feed(Float32Array.from([0.1, -0.8, 0.2, 0.3, 0.05, 0.05, 0.05, 0.05]), 8)
    expect(posted.map((m) => Number(m.peak.toFixed(2)))).toEqual([0.8, 0.05])
  })

  it("a tone survives: the 440 Hz energy is still there after converting from 48 kHz", () => {
    const { posted, feed } = processor(48_000)
    feed(Float32Array.from({ length: 48_000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5))
    const out = all(posted)
    const rms = Math.sqrt(out.reduce((a, b) => a + (b / 32768) ** 2, 0) / out.length)
    expect(rms).toBeGreaterThan(0.3) // 0.5 / sqrt(2) = 0.354, less a little for the filter
    expect(rms).toBeLessThan(0.4)
  })

  it("does not lose or repeat samples across block boundaries of any size", () => {
    const ramp = Float32Array.from({ length: 48_000 }, (_, i) => (i % 1000) / 2000)
    const a = processor(48_000)
    a.feed(ramp, 128)
    const b = processor(48_000)
    b.feed(ramp, 441)
    expect(all(b.posted)).toEqual(all(a.posted))
  })

  it("hands each chunk's buffer over rather than copying it, and a new one is used for the next", () => {
    const { posted, feed } = processor(16_000, { chunkSamples: 4 })
    feed(new Float32Array(8).fill(0.1), 8)
    expect(posted[0]!.pcm).not.toBe(posted[1]!.pcm)
  })

  it("tolerates a block with no input connected", () => {
    const { node } = processor(48_000)
    expect(node.process([[]])).toBe(true)
    expect(node.process([])).toBe(true)
  })

  it("a device running below 16 kHz repeats samples rather than shrinking time", () => {
    const { posted, feed } = processor(8_000, { chunkSamples: 16 })
    feed(new Float32Array(8_000).fill(0.5), 128)
    expect(all(posted).length).toBe(16_000 - (16_000 % 16))
  })
})
