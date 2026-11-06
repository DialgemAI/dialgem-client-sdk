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
 * Each output sample is the mean of the input samples that fall in its slot. That is a box filter: crude, but
 * it removes most of what would otherwise fold into the speech band, and speech recognition does not need more.
 * A rate that is not a whole multiple of 16 kHz (44.1 kHz) is handled by a fractional boundary, not by rounding.
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
    this.pos = 0
    this.boundary = this.ratio
    this.sum = 0
    this.count = 0
    this.last = 0
    this.out = new Int16Array(this.chunk)
    this.n = 0
    this.peak = 0
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
