import { describe, expect, it } from "vitest"

import { VERSION } from "@dialgem/client"
import { UrlError, buildCallUrl, describeClose, describeRefusal, floatToPcm16, parseServerFrame, stripRiffHeader } from "../src/protocol.js"
import pkg from "../package.json" with { type: "json" }

describe("buildCallUrl", () => {
  it("goes to the production address by default and carries only the token and the live-transcript switch", () => {
    const url = new URL(buildCallUrl("wss://api.dialgem.com", "tok.en"))
    expect(url.origin).toBe("wss://api.dialgem.com")
    expect(url.pathname).toBe("/v1/agent/call")
    expect(Object.fromEntries(url.searchParams)).toEqual({ web_token: "tok.en", live_transcript: "1" })
  })

  it("refuses an organization API key, which must never reach a browser", () => {
    for (const key of ["zk_live_abc123", "ZK_live_abc123", "  zk_x "]) {
      expect(() => buildCallUrl("wss://api.dialgem.com", key)).toThrow(/organization API key/)
    }
  })

  it("encodes the token and never puts it in the path", () => {
    const url = buildCallUrl("wss://api.dialgem.com/", "a b&c=d")
    expect(url).toContain("web_token=a+b%26c%3Dd")
    expect(new URL(url).pathname).toBe("/v1/agent/call")
  })

  it("turns an https address into wss", () => {
    expect(buildCallUrl("https://api.example.com", "t")).toMatch(/^wss:\/\/api\.example\.com\/v1\/agent\/call\?/)
  })

  it("refuses to send a token in the clear, except to this machine", () => {
    expect(() => buildCallUrl("ws://api.example.com", "t")).toThrow(UrlError)
    expect(() => buildCallUrl("http://api.example.com", "t")).toThrow(UrlError)
    expect(buildCallUrl("ws://localhost:8002", "t")).toMatch(/^ws:\/\/localhost:8002\/v1\/agent\/call/)
    expect(buildCallUrl("http://127.0.0.1:8002", "t")).toMatch(/^ws:\/\/127\.0\.0\.1:8002\//)
  })

  it("refuses other schemes, garbage and an empty token", () => {
    expect(() => buildCallUrl("ftp://x.io", "t")).toThrow(UrlError)
    expect(() => buildCallUrl("not a url", "t")).toThrow(UrlError)
    expect(() => buildCallUrl("wss://api.dialgem.com", "")).toThrow(UrlError)
  })
})

describe("parseServerFrame", () => {
  it.each([
    [{ type: "session_started", session_id: "c1", opt_out_call_recording: false }, { type: "session_started", sessionId: "c1" }],
    [{ type: "transcript", role: "agent", text: "Hello" }, { type: "transcript", role: "agent", text: "Hello" }],
    [{ type: "transcript", role: "user", text: "Hi" }, { type: "transcript", role: "user", text: "Hi" }],
    [{ type: "transcript_partial", role: "user", text: "Hi th" }, { type: "transcript_partial", text: "Hi th" }],
    [{ type: "agent_interrupted" }, { type: "agent_interrupted" }],
    [{ type: "call_ended" }, { type: "call_ended" }],
    [{ error: "stt_unavailable" }, { type: "error", reason: "stt_unavailable" }],
    [{ error: "org_suspended", disconnection_reason: "org_suspended", issues: [] }, { type: "error", reason: "org_suspended" }],
  ])("reads %j", (frame, want) => {
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(want)
  })

  it.each([
    "not json", "null", "42", "[]", '"x"', "{}", '{"type":"function_call","name":"x"}', '{"type":"transcript_word","word":"hi"}',
    '{"type":"transcript","role":"system","text":"x"}', '{"type":"transcript","role":"user"}', '{"type":"transcript_partial","role":"agent","text":"x"}',
  ])("ignores %s without throwing", (text) => {
    expect(parseServerFrame(text)).toEqual({ type: "ignored" })
  })
})

describe("stripRiffHeader", () => {
  const riff = (n: number) => {
    const b = new Uint8Array(n)
    b.set([0x52, 0x49, 0x46, 0x46])
    return b.buffer
  }
  it("removes the 44-byte header from the start of a sentence", () => {
    expect(stripRiffHeader(riff(44 + 320))!.byteLength).toBe(320)
  })
  it("yields nothing for a frame that is only the header", () => {
    expect(stripRiffHeader(riff(44))).toBeNull()
    expect(stripRiffHeader(riff(10))).toBeNull()
  })
  it("leaves ordinary audio alone, however short", () => {
    expect(stripRiffHeader(new ArrayBuffer(640))!.byteLength).toBe(640)
    expect(stripRiffHeader(new ArrayBuffer(2))!.byteLength).toBe(2)
    expect(stripRiffHeader(new ArrayBuffer(0))!.byteLength).toBe(0)
  })
})

describe("describeClose", () => {
  it.each([
    [1008, "refused"], [1013, "busy"], [1011, "server_error"], [1002, "server_error"], [1006, "connection_failed"], [1000, "connection_failed"],
  ])("close %i is %s", (code, want) => {
    expect(describeClose(code).code).toBe(want)
    expect(describeClose(code).message.length).toBeGreaterThan(10)
  })
})

describe("describeRefusal", () => {
  it.each([
    ["origin_not_allowed", "refused", /origin/], ["token_expired", "refused", /expired/], ["token_already_used", "refused", /already used/],
    ["token_invalid", "refused", /not valid/], ["bad_request", "refused", /not valid/], ["concurrency_limit_reached", "busy", /Too many/],
    ["web_calls_unavailable", "server_error", /not available/], ["org_suspended", "call_refused", /org_suspended/], ["something_new", "call_refused", /something_new/],
  ])("%s -> %s", (reason, code, message) => {
    const got = describeRefusal(reason)
    expect(got.code).toBe(code)
    expect(got.message).toMatch(message)
  })
})

describe("floatToPcm16", () => {
  it("scales, clamps and keeps the sign", () => {
    const pcm = new Int16Array(floatToPcm16(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2])))
    expect([...pcm]).toEqual([0, 32767, -32768, 16383, -16384, 32767, -32768])
  })
})

describe("the package", () => {
  it("reports the version it ships as", () => {
    expect(VERSION).toBe(pkg.version)
  })
})
