# Changelog

## 1.0.0

The first stable release. The API is the one in `0.1.0-beta.1`, unchanged: nothing was added, removed or renamed. From here on, breaking changes only come in a new major version, and `npm install @dialgem/client` installs this release.

### What it does

- `DialgemCall`: microphone capture (AudioWorklet, converted to 16 kHz mono in the audio thread), streaming playback of the agent's voice, and typed events (`started`, `transcript`, `agent_speaking`, `interrupted`, `level`, `ended`, `error`). `start()`, `stop()` and `setMuted()`.
- `@dialgem/client/react`: `useDialgemCall`, a hook that makes a new call (and fetches a new token) on every `start()` and hangs up on unmount.
- Authenticates with the one-use token from `dialgem.webCalls.create` (in `@dialgem/sdk`); an API key is never needed in the browser.
- Refusals say why: `refused` (with `reason` `token_expired`, `token_already_used`, `token_invalid` or `origin_not_allowed`), `busy`, `call_refused` (with the server's reason).
- Not in this release: reconnecting a dropped call (the token is single-use and the conversation lives on the server for as long as the connection does), WebRTC, a script-tag build.
