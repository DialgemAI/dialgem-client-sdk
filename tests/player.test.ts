import { describe, expect, it } from "vitest"

import { PcmPlayer, type PlaybackContext } from "../src/player.js"
import { FakeContext } from "./fakes.js"

const make = () => {
  const ctx = new FakeContext()
  return { ctx, player: new PcmPlayer(ctx as unknown as PlaybackContext) }
}
// 16 kHz mono 16-bit: 32 bytes per millisecond.
const ms = (n: number) => new ArrayBuffer(n * 32)
const riff = (bytes: number) => {
  const b = new Uint8Array(bytes)
  b.set([0x52, 0x49, 0x46, 0x46])
  return b.buffer
}

describe("PcmPlayer", () => {
  it("starts the first frame a hair after now, and the next one exactly where the last ended", () => {
    const { ctx, player } = make()
    ctx.currentTime = 1
    player.feed(ms(100))
    player.feed(ms(50))
    const [a, b] = ctx.sources
    expect(a!.started).toBeCloseTo(1.02, 5)
    expect(b!.started).toBeCloseTo(1.12, 5)       // joined with no gap
    expect(player.remainingMs()).toBeCloseTo(170, 3)
    expect(player.active()).toBe(true)
  })

  it("catches up after falling behind instead of scheduling in the past", () => {
    const { ctx, player } = make()
    player.feed(ms(10))
    ctx.currentTime = 5                              // playback ran dry long ago
    player.feed(ms(10))
    expect(ctx.sources[1]!.started).toBeCloseTo(5.02, 5)
  })

  it("strips the RIFF header of each sentence and drops a header-only frame", () => {
    const { ctx, player } = make()
    player.feed(riff(44))
    expect(ctx.sources).toHaveLength(0)
    player.feed(riff(44 + 3200))
    expect(ctx.sources).toHaveLength(1)
    expect(player.remainingMs()).toBeCloseTo(100 + 20 - 0 - 20, 0)   // 3200 bytes = 100 ms
  })

  it("keeps the odd byte of a frame that did not end on a sample boundary and joins it to the next", () => {
    const { ctx, player } = make()
    player.feed(new ArrayBuffer(641))                 // 320 samples and one byte over
    player.feed(new ArrayBuffer(639))                 // the byte completes a sample; 319 more whole ones
    const lengths = ctx.sources.map((s) => (s.buffer as unknown as { length: number }).length)
    expect(lengths).toEqual([320, 320])
  })

  it("interrupt stops everything queued, and the next sentence starts fresh", () => {
    const { ctx, player } = make()
    ctx.currentTime = 2
    player.feed(ms(500))
    player.feed(ms(500))
    player.interrupt()
    expect(ctx.sources.every((s) => s.stopped)).toBe(true)
    expect(player.active()).toBe(false)
    expect(player.remainingMs()).toBe(0)
    player.feed(ms(10))
    expect(ctx.sources[2]!.started).toBeCloseTo(2.02, 5)
  })

  it("forgets a half sample when interrupted, so it cannot be glued onto the next sentence", () => {
    const { ctx, player } = make()
    player.feed(new ArrayBuffer(3))
    player.interrupt()
    player.feed(new ArrayBuffer(4))
    expect((ctx.sources.at(-1)!.buffer as unknown as { length: number }).length).toBe(2)
  })

  it("forgets a source when it finishes", () => {
    const { ctx, player } = make()
    player.feed(ms(10))
    ctx.sources[0]!.onended?.()
    expect(player.active()).toBe(false)
  })

  it("ignores empty and one-byte frames", () => {
    const { ctx, player } = make()
    player.feed(new ArrayBuffer(0))
    player.feed(new ArrayBuffer(1))
    expect(ctx.sources).toHaveLength(0)
  })

  it("buffers are 16 kHz whatever the device rate, so the browser does the resampling", () => {
    const { ctx, player } = make()
    player.feed(ms(20))
    expect((ctx.sources[0]!.buffer as unknown as { rate: number }).rate).toBe(16_000)
  })
})
