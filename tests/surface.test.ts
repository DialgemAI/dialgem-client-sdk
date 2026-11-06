import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

/**
 * The client SDK's whole job is one call's WebSocket. These pin that: it may never call a REST route,
 * hold an API key, or reach for storage, so a future change cannot quietly widen what a web page can do.
 * See docs/api-surface.md in the server SDK repos for the policy this enforces.
 */
const srcDir = fileURLToPath(new URL("../src/", import.meta.url))
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: readFileSync(srcDir + f, "utf8") }))

// Comments may mention these words ("never calls fetch"); only code counts.
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

describe("the client SDK's reach", () => {
  it.each(sources)("$file makes no HTTP request", ({ text }) => {
    const body = code(text)
    expect(body).not.toMatch(/\bfetch\s*\(/)
    expect(body).not.toMatch(/XMLHttpRequest/)
    expect(body).not.toMatch(/navigator\.sendBeacon/)
    expect(body).not.toMatch(/EventSource/)
  })

  it.each(sources)("$file does not touch an API key, cookies or storage", ({ text }) => {
    const body = code(text)
    expect(body).not.toMatch(/X-API-Key/i)
    expect(body).not.toMatch(/Authorization/)
    expect(body).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/)
  })

  it("opens exactly one kind of connection: the call WebSocket", () => {
    const sockets = sources.flatMap(({ file, text }) => (code(text).match(/new (?:\w+\.)?WebSocket\(/g) ?? []).map(() => file))
    expect(sockets).toEqual(["call.ts"])
  })

  it("has no runtime dependencies to inherit a wider reach from", async () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"))
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([])
  })
})
