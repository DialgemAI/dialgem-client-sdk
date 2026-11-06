/**
 * What the call WebSocket speaks. Everything here is pure, so it is tested without a browser.
 *
 * Client to server: one JSON text frame to open the call, then binary frames of 16 kHz mono signed
 * 16-bit little-endian PCM, and the text frame `hangup` to end it.
 * Server to client: JSON text frames (events) and binary frames of 16 kHz mono signed 16-bit PCM
 * (the agent's voice), each sentence beginning with a 44-byte RIFF header.
 */

/** The only address the SDK talks to unless a self-hosted deployment says otherwise. */
export const DEFAULT_BASE_URL = "wss://api.dialgem.com"

/** Both directions of the call's audio. */
export const SAMPLE_RATE = 16_000

/** Microphone audio is sent in chunks of this many samples: 40 ms, small enough not to delay speech detection. */
export const CAPTURE_CHUNK_SAMPLES = 640

export class UrlError extends Error {}

/**
 * The WebSocket address for a call. The token rides in the query string because browsers cannot set
 * headers on a WebSocket; it is single-use and lives 60 seconds, which is what makes that acceptable.
 *
 * Plain `ws:` is refused except for a local address: a token sent in the clear can be replayed by
 * whoever reads it before the real page connects.
 */
export function buildCallUrl(baseURL: string, accessToken: string): string {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new UrlError(`baseURL is not a URL: ${baseURL}`)
  }
  if (url.protocol === "https:") url.protocol = "wss:"
  if (url.protocol === "http:") url.protocol = "ws:"
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new UrlError("baseURL must be a wss:// or ws:// address")
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol === "ws:" && !local) throw new UrlError("baseURL must use wss:// except for localhost")
  if (!accessToken) throw new UrlError("accessToken is empty")
  // An organization API key (`zk_...`) grants full access to the account. A page that is handed one has
  // already leaked it to every visitor, so refuse before it is put in a URL that gets logged.
  if (/^zk_/i.test(accessToken.trim())) {
    throw new UrlError(
      "That is an organization API key, not a call token. Never put an API key in a web page: create the call on your server with webCalls.create() and give the page its access_token.",
    )
  }
  const base = url.toString().replace(/\/+$/, "")
  const query = new URLSearchParams({ web_token: accessToken, live_transcript: "1" })
  return `${base}/v1/agent/call?${query.toString()}`
}

/** The first frame. The server decides the agent and its configuration from the token and ignores this body. */
export const INIT_FRAME = JSON.stringify({ agent_config: {} })

export type ServerFrame =
  | { type: "session_started"; sessionId: string }
  | { type: "transcript"; role: "user" | "agent"; text: string }
  | { type: "transcript_partial"; text: string }
  | { type: "agent_interrupted" }
  | { type: "call_ended" }
  | { type: "error"; reason: string }
  | { type: "ignored" }

/** One text frame from the server. Anything unrecognized (including malformed JSON) is `ignored`, never an exception. */
export function parseServerFrame(text: string): ServerFrame {
  let msg: unknown
  try {
    msg = JSON.parse(text)
  } catch {
    return { type: "ignored" }
  }
  if (typeof msg !== "object" || msg === null) return { type: "ignored" }
  const m = msg as Record<string, unknown>
  if (typeof m["error"] === "string") {
    return { type: "error", reason: typeof m["disconnection_reason"] === "string" ? m["disconnection_reason"] : m["error"] }
  }
  switch (m["type"]) {
    case "session_started":
      return { type: "session_started", sessionId: typeof m["session_id"] === "string" ? m["session_id"] : "" }
    case "transcript":
      if ((m["role"] === "user" || m["role"] === "agent") && typeof m["text"] === "string") {
        return { type: "transcript", role: m["role"], text: m["text"] }
      }
      return { type: "ignored" }
    case "transcript_partial":
      return m["role"] === "user" && typeof m["text"] === "string" ? { type: "transcript_partial", text: m["text"] } : { type: "ignored" }
    case "agent_interrupted":
      return { type: "agent_interrupted" }
    case "call_ended":
      return { type: "call_ended" }
    default:
      return { type: "ignored" }
  }
}

/**
 * Strips the 44-byte RIFF header the server puts at the start of each sentence. A header-only frame
 * yields nothing. Audio that does not start with one is returned as is.
 */
export function stripRiffHeader(chunk: ArrayBuffer): ArrayBuffer | null {
  if (chunk.byteLength >= 4) {
    const magic = new Uint8Array(chunk, 0, 4)
    if (magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46) {
      return chunk.byteLength <= 44 ? null : chunk.slice(44)
    }
  }
  return chunk
}

/**
 * What the server said when it turned the call away. Browsers cannot see the close code of a socket refused before
 * it is accepted, so the server accepts a refused call, sends this reason in one frame and then closes it.
 */
export function describeRefusal(reason: string): {
  code: "refused" | "busy" | "server_error" | "call_refused"
  message: string
} {
  switch (reason) {
    case "origin_not_allowed":
      return { code: "refused", message: "This page's origin is not allowed to start calls. Add it under Web calls in your Dialgem settings." }
    case "token_expired":
      return { code: "refused", message: "The access token expired before the call connected. Request a new one and start again." }
    case "token_already_used":
      return { code: "refused", message: "The access token was already used. Each call needs its own token from your backend." }
    case "token_invalid":
    case "bad_request":
      return { code: "refused", message: "The access token is not valid for a call." }
    case "concurrency_limit_reached":
      return { code: "busy", message: "Too many calls are running right now. Try again in a moment." }
    case "web_calls_unavailable":
      return { code: "server_error", message: "Browser calls are not available right now." }
    default:
      return { code: "call_refused", message: `The call was declined: ${reason}.` }
  }
}

/** What a closed socket means, from its close code. */
export function describeClose(code: number): { code: "refused" | "busy" | "server_error" | "connection_failed"; message: string } {
  switch (code) {
    case 1008:
      return {
        code: "refused",
        message:
          "The call was refused. The access token was invalid, expired or already used, or this page's origin is not allowed to start calls.",
      }
    case 1013:
      return { code: "busy", message: "Too many calls are running right now. Try again in a moment." }
    case 1011:
    case 1002:
      return { code: "server_error", message: "The call could not start because of a problem on Dialgem's side." }
    default:
      return { code: "connection_failed", message: "Could not connect to the call." }
  }
}

/** Float samples in [-1, 1] as little-endian 16-bit PCM. */
export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = s < 0 ? s * 32768 : s * 32767
  }
  return out.buffer
}
