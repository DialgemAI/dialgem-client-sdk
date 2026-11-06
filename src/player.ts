import { SAMPLE_RATE, stripRiffHeader } from "./protocol.js"

/** The part of `AudioContext` the player uses, so a test can stand in for it. */
export interface PlaybackContext {
  readonly currentTime: number
  readonly destination: AudioNode
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer
  createBufferSource(): AudioBufferSourceNode
}

/**
 * Plays the agent's voice as it arrives.
 *
 * Each binary frame is scheduled onto the audio clock right after the previous one, so speech starts within
 * a few milliseconds of the first frame instead of after a whole sentence has been buffered, and consecutive
 * frames join without a gap. The buffers are 16 kHz; the browser resamples them to whatever the output device
 * runs at.
 *
 * Network delivery is faster than playback, so the last byte of a sentence arrives while the speaker still has
 * a second of it to say. `remainingMs` is how much is still queued, which is what lets a call that ends
 * with a goodbye let the goodbye finish.
 */
export class PcmPlayer {
  private nextTime = 0
  private sources: AudioBufferSourceNode[] = []
  /** A trailing odd byte: frames are not guaranteed to end on a sample boundary. */
  private carry: Uint8Array | null = null

  constructor(private readonly ctx: PlaybackContext) {}

  feed(chunk: ArrayBuffer): void {
    let data = stripRiffHeader(chunk)
    if (data === null) return
    if (this.carry) {
      const joined = new Uint8Array(this.carry.length + data.byteLength)
      joined.set(this.carry, 0)
      joined.set(new Uint8Array(data), this.carry.length)
      data = joined.buffer
      this.carry = null
    }
    const usable = data.byteLength - (data.byteLength % 2)
    if (usable !== data.byteLength) this.carry = new Uint8Array(data.slice(usable))
    const samples = usable / 2
    if (samples < 1) return

    const pcm = new Int16Array(data.slice(0, usable))
    const floats = new Float32Array(samples)
    for (let i = 0; i < samples; i++) floats[i] = (pcm[i] ?? 0) / 32768

    const buffer = this.ctx.createBuffer(1, samples, SAMPLE_RATE)
    buffer.copyToChannel(floats, 0)
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    source.onended = () => {
      const i = this.sources.indexOf(source)
      if (i !== -1) this.sources.splice(i, 1)
    }

    const now = this.ctx.currentTime
    // Behind (the first frame, or after an interruption): start a hair ahead of now so the first sample is not clipped.
    if (this.nextTime < now) this.nextTime = now + 0.02
    source.start(this.nextTime)
    this.sources.push(source)
    this.nextTime += buffer.duration
  }

  /** Stop everything queued, immediately: the caller started talking over the agent. */
  interrupt(): void {
    for (const s of this.sources) {
      try {
        s.stop(0)
      } catch {
        // already finished
      }
    }
    this.sources = []
    this.nextTime = 0
    this.carry = null
  }

  /** Whether anything is queued or playing. */
  active(): boolean {
    return this.sources.length > 0
  }

  /** Milliseconds of audio still queued ahead of the audio clock. */
  remainingMs(): number {
    return Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000)
  }
}
