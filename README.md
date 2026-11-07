<div align="center">

# Dialgem Client

**Talk to a [Dialgem](https://dialgem.com) voice agent from any web page.**

Microphone capture, streaming playback and live call events in the browser, with a small React hook. Your API key never reaches the page.

[![npm](https://img.shields.io/npm/v/@dialgem/client?color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@dialgem/client)
[![CI](https://img.shields.io/github/actions/workflow/status/DialgemAI/dialgem-client-sdk/ci.yml?branch=main&label=CI&logo=github)](https://github.com/DialgemAI/dialgem-client-sdk/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-typed-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-hook%20included-61DAFB?logo=react&logoColor=black)](#react)
[![Stars](https://img.shields.io/github/stars/DialgemAI/dialgem-client-sdk?style=flat&logo=github)](https://github.com/DialgemAI/dialgem-client-sdk/stargazers)

[Website](https://dialgem.com) · [Issues](https://github.com/DialgemAI/dialgem-client-sdk/issues) · [Changelog](CHANGELOG.md) · [Server SDK](https://github.com/DialgemAI/dialgem-sdk-typescript)

</div>

---

```ts
import { DialgemCall } from "@dialgem/client"

const call = new DialgemCall({ accessToken: () => fetch("/api/start-call").then((r) => r.text()) })
call.on("transcript", (t) => console.log(t.role, t.text))
button.onclick = () => call.start()
```

## Why this SDK

- **Your API key stays on your server.** Your backend mints a one-use token that lives 60 seconds; the page connects with that alone.
- **Voice in the browser, handled.** It opens the microphone, converts to 16 kHz in an audio worklet, streams the voice to the agent and plays the agent's voice as it arrives, with echo cancellation on by default.
- **Events for your UI.** Transcript (live as the caller speaks), who is speaking, interruptions, microphone level, and how the call ended.
- **React hook included.** `useDialgemCall` from `@dialgem/client/react`; React is an optional peer dependency (18+).
- **No runtime dependencies**, and typed.
- **Wide support.** Chrome 66+, Edge 79+, Firefox 76+, Safari 14.1+ (anything with `AudioWorklet`), over HTTPS or `localhost`.

## Contents

[Install](#install) · [How a call starts](#how-a-call-starts) · [React](#react) · [DialgemCall](#dialgemcall) · [Events](#events) · [Things worth knowing](#things-worth-knowing) · [License](#license)

## Install

```sh
npm install @dialgem/client
```

## How a call starts

Your **server** asks Dialgem for a call with your API key and gives the page a one-use token. The page connects with that token alone, so **your API key never reaches the browser**.

```ts
// On your server, with @dialgem/sdk. Called by your page when a visitor clicks.
import { Dialgem } from "@dialgem/sdk"
const dialgem = new Dialgem({ apiKey: process.env.DIALGEM_API_KEY })

export async function startCall() {
  const { access_token } = await dialgem.webCalls.create({ agent_id: "AGENT_ID" })
  return access_token                 // 60 seconds, one use
}
```

```ts
// On your page.
import { DialgemCall } from "@dialgem/client"

const call = new DialgemCall({
  accessToken: () => fetch("/api/start-call").then((r) => r.text()),
})

call.on("transcript", (t) => console.log(t.role, t.text, t.final ? "" : "…"))
call.on("agent_speaking", ({ speaking }) => orb.classList.toggle("talking", speaking))
call.on("ended", ({ reason }) => console.log("call ended:", reason))
call.on("error", (e) => alert(e.message))

button.onclick = () => call.start()   // from a click: browsers only allow sound after one
hangUp.onclick = () => call.stop()
```

Before the first call, allow your page's origin (for example `https://app.example.com`) in the Dialgem dashboard under **Settings, Web calls**, or with `dialgem.webCalls.updateSettings({ allowed_origins: [...] })`.

### React

```tsx
import { useDialgemCall } from "@dialgem/client/react"

function Talk() {
  const call = useDialgemCall({ getAccessToken: () => fetch("/api/start-call").then((r) => r.text()) })
  return (
    <>
      <button onClick={call.start} disabled={call.state === "connecting" || call.state === "active"}>Talk to us</button>
      {call.state === "active" && <button onClick={call.stop}>Hang up</button>}
      {call.transcript.map((l) => <p key={l.id}>{l.role}: {l.text}</p>)}
      {call.error && <p role="alert">{call.error.message}</p>}
    </>
  )
}
```

## `DialgemCall`

`new DialgemCall({ accessToken, microphone?, baseURL? })`

- `accessToken`: the token, or a function returning it (sync or async). A function is called **after** the visitor has allowed the microphone, because the token lives 60 seconds and a permission prompt can take longer.
- `microphone`: `{ deviceId, echoCancellation, noiseSuppression, autoGainControl }`. The last three default to `true`: without echo cancellation the agent's own voice comes back through the microphone and it answers itself. Turn them off only for a headset in a quiet room.
- `baseURL`: only for a self-hosted deployment. Plain `ws://` is refused for anything but `localhost`, because the token would cross the network in the clear.

Methods: `start()` (returns when connected; rejects with the same error the `error` event carries), `stop()`, `setMuted(boolean)` (the agent hears silence; the call stays open). Properties: `state`, `callId`, `muted`.

A `DialgemCall` is used once. A token is single-use, so a second call needs a new object (the React hook does this for you on every `start()`).

### Events

| Event | Payload |
| --- | --- |
| `state` | `"idle" \| "connecting" \| "active" \| "ended" \| "error"` |
| `started` | `{ callId }`. The agent is live. |
| `transcript` | `{ role: "user" \| "agent", text, final }`. A caller's line arrives as `final: false` while they speak, then settles. |
| `agent_speaking` | `{ speaking }`. True from the first audio until it has played out. |
| `interrupted` | The caller talked over the agent and its speech was cut off. |
| `level` | `{ level }`, microphone level 0 to 1, about ten times a second. |
| `ended` | `{ reason: "hangup" \| "agent_ended" \| "connection_lost" }` |
| `error` | `{ code, message, reason? }` |

Error codes: `unsupported`, `mic_denied`, `mic_unavailable`, `token_unavailable`, `refused` (token invalid, expired or used, or this page's origin not allowed; `reason` says which), `busy` (too many calls running), `call_refused` (declined by the server, `reason` says why, for example `insufficient_credit`), `server_error`, `connection_failed`.

### There is no reconnecting

The conversation lives on the server for as long as the connection does, and the token is single-use. A call that drops has ended (`reason: "connection_lost"`); start a new one. A page that wants to carry on should tell the visitor and start again.

## Things worth knowing

- **Content-Security-Policy.** The audio processor is loaded from a `blob:` URL. If your page sets a CSP, `script-src` needs `blob:`, or `start()` fails with `unsupported`.
- **Sample rate.** The microphone is captured at the device's own rate and converted to 16 kHz in the audio thread; the agent's voice is 16 kHz and the browser resamples it for the speakers. Nothing to configure.
- **Autoplay.** Call `start()` straight from a click or tap handler. The audio output is created synchronously inside it, before any `await`, which is what browsers count as the visitor starting it.
- **Billing.** Browser calls are billed like any other call. `webCalls.create` fails with 402 if the organization cannot pay for one.

## License

Apache-2.0

---

<div align="center">

If this SDK saves you time, a ⭐ on [GitHub](https://github.com/DialgemAI/dialgem-client-sdk) helps other developers find it.

</div>
