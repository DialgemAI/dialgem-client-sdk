import { CAPTURE_CHUNK_SAMPLES, SAMPLE_RATE } from "./protocol.js"

export const WORKLET_NAME = "dialgem-capture"

/**
 * The microphone capture processor, as source text.
 *
 * It runs in the audio thread at the device's own sample rate (44.1 or 48 kHz, whatever the hardware
 * does) and turns that into the 16 kHz mono 16-bit PCM the call needs, 640 samples at a time. Capturing at
 * the device rate and converting here, rather than asking the browser for a 16 kHz context, is what
 * keeps this working in Firefox, which refuses to connect a microphone to a context at another rate.
 *
 * Above 16 kHz the conversion is a windowed-sinc low-pass (Blackman, cut-off at 90% of the output's Nyquist
 * frequency), evaluated at each output instant. That keeps speech up to about 7 kHz at full level and removes what
 * would otherwise fold back into it as hiss. It replaced a plain average of the input samples in each slot, which
 * dulled the top of speech by about 2 dB at 6 kHz and let a lot through above 8 kHz. A rate that is not a whole
 * multiple of 16 kHz (44.1 kHz) is handled by a fractional position per output, taken from a table of 512 phases.
 * The filter delays the voice by about 0.75 ms, and the first few output samples are the filter filling up.
 * At or below 16 kHz there is nothing to filter and the samples pass through as they are.
 *
 * It is text, not an imported function, because `audioWorklet.addModule` takes a URL; the SDK serves it from a
 * Blob. The tests run this exact text, so what ships is what is tested.
 */
export const WORKLET_SOURCE = `
class DialgemCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = (options && options.processorOptions) || {}
    this.chunk = o.chunkSamples || ${CAPTURE_CHUNK_SAMPLES}
    this.ratio = sampleRate / (o.targetRate || ${SAMPLE_RATE})
    this.filtered = this.ratio > 1
    if (this.filtered) this.design()
    this.pos = 0
    this.boundary = this.ratio
    this.sum = 0
    this.count = 0
    this.last = 0
    this.out = new Int16Array(this.chunk)
    this.n = 0
    this.peak = 0
  }

  design() {
    this.half = Math.ceil(12 * this.ratio)
    this.taps = this.half * 2
    this.phases = 512
    this.size = 4096
    this.ring = new Float32Array(this.size)
    this.written = 0
    this.next = 0
    this.table = new Float32Array(this.phases * this.taps)
    const cutoff = 0.45 / this.ratio
    for (let ph = 0; ph < this.phases; ph++) {
      const frac = ph / this.phases
      let sum = 0
      for (let j = 0; j < this.taps; j++) {
        const d = j - this.half + 1 - frac
        const x = 2 * cutoff * d
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
        const u = d / this.taps + 0.5
        const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u)
        const t = sinc * w
        this.table[ph * this.taps + j] = t
        sum += t
      }
      for (let j = 0; j < this.taps; j++) this.table[ph * this.taps + j] /= sum
    }
  }

  filter(input) {
    for (let i = 0; i < input.length; i++) {
      this.ring[this.written % this.size] = input[i]
      this.written++
    }
    for (;;) {
      let base = Math.floor(this.next)
      let ph = Math.round((this.next - base) * this.phases)
      if (ph === this.phases) {
        ph = 0
        base++
      }
      if (base + this.half >= this.written) break
      let v = 0
      const row = ph * this.taps
      const first = base - this.half + 1
      for (let j = 0; j < this.taps; j++) {
        const n = first + j
        v += this.ring[((n % this.size) + this.size) % this.size] * this.table[row + j]
      }
      this.emit(v)
      this.next += this.ratio
    }
  }

  emit(v) {
    const a = v < 0 ? -v : v
    if (a > this.peak) this.peak = a
    const s = v > 1 ? 1 : v < -1 ? -1 : v
    this.out[this.n++] = s < 0 ? s * 32768 : s * 32767
    if (this.n === this.chunk) {
      const pcm = this.out.buffer
      this.port.postMessage({ pcm: pcm, peak: this.peak }, [pcm])
      this.out = new Int16Array(this.chunk)
      this.n = 0
      this.peak = 0
    }
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    if (this.filtered) {
      this.filter(input)
      return true
    }
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i]
      this.count++
      this.pos++
      while (this.pos >= this.boundary) {
        const v = this.count > 0 ? this.sum / this.count : this.last
        this.last = v
        this.sum = 0
        this.count = 0
        this.boundary += this.ratio
        this.emit(v)
      }
    }
    return true
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, DialgemCapture)
`
