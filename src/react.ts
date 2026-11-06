import { useCallback, useEffect, useRef, useState } from "react"

import { DialgemCall, type CallError, type CallState, type DialgemCallOptions, type EndReason } from "./call.js"

export interface TranscriptLine {
  id: number
  role: "user" | "agent"
  text: string
  /** False while the caller is mid-sentence. */
  final: boolean
}

export interface UseDialgemCallOptions extends Omit<DialgemCallOptions, "accessToken"> {
  /** Returns the access token from your backend's `POST /v1/calls/web`. Called when the call starts, after the microphone is allowed. */
  getAccessToken: () => string | Promise<string>
}

export interface UseDialgemCall {
  state: CallState
  /** The conversation so far. A caller's line is replaced as they speak and settles when it is final. */
  transcript: TranscriptLine[]
  agentSpeaking: boolean
  muted: boolean
  /** Microphone level, 0 to 1. */
  level: number
  callId: string | null
  endReason: EndReason | null
  error: CallError | null
  /** Call from a click handler. Starting while a call is running does nothing. */
  start: () => Promise<void>
  stop: () => void
  setMuted: (muted: boolean) => void
}

/**
 * A call as React state.
 *
 *   const call = useDialgemCall({ getAccessToken: () => fetch("/api/start-call").then((r) => r.text()) })
 *   <button onClick={call.start}>Talk to us</button>
 *
 * Each `start()` makes a new call, since a token is single-use. Leaving the page, or unmounting the component
 * that owns the hook, hangs up.
 */
export function useDialgemCall(options: UseDialgemCallOptions): UseDialgemCall {
  const [state, setState] = useState<CallState>("idle")
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [agentSpeaking, setAgentSpeaking] = useState(false)
  const [muted, setMutedState] = useState(false)
  const [level, setLevel] = useState(0)
  const [callId, setCallId] = useState<string | null>(null)
  const [endReason, setEndReason] = useState<EndReason | null>(null)
  const [error, setError] = useState<CallError | null>(null)

  const callRef = useRef<DialgemCall | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const nextId = useRef(0)

  useEffect(() => () => callRef.current?.stop(), [])

  const start = useCallback(async () => {
    const running = callRef.current
    if (running && (running.state === "connecting" || running.state === "active")) return

    setTranscript([])
    setAgentSpeaking(false)
    setMutedState(false)
    setLevel(0)
    setCallId(null)
    setEndReason(null)
    setError(null)

    const rest: Partial<UseDialgemCallOptions> = { ...optionsRef.current }
    delete rest.getAccessToken
    const call = new DialgemCall({ ...rest, accessToken: () => optionsRef.current.getAccessToken() })
    callRef.current = call

    call.on("state", setState)
    call.on("started", (e) => setCallId(e.callId))
    call.on("agent_speaking", (e) => setAgentSpeaking(e.speaking))
    call.on("level", (e) => setLevel(e.level))
    call.on("ended", (e) => setEndReason(e.reason))
    call.on("error", setError)
    call.on("transcript", (t) =>
      setTranscript((lines) => {
        const last = lines[lines.length - 1]
        // A caller's partial line is replaced by the next one and by the final one.
        if (last && last.role === t.role && !last.final && t.role === "user") {
          return [...lines.slice(0, -1), { ...last, text: t.text, final: t.final }]
        }
        return [...lines, { id: nextId.current++, role: t.role, text: t.text, final: t.final }]
      }),
    )

    try {
      await call.start()
    } catch {
      // Already reported through `error` and `state`.
    }
  }, [])

  const stop = useCallback(() => callRef.current?.stop(), [])
  const setMuted = useCallback((m: boolean) => {
    callRef.current?.setMuted(m)
    setMutedState(m)
  }, [])

  return { state, transcript, agentSpeaking, muted, level, callId, endReason, error, start, stop, setMuted }
}
