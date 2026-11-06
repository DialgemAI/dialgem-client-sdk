/** A minimal typed event emitter. A handler that throws never stops the others or the call. */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>()

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(event)
    if (!set) this.handlers.set(event, (set = new Set()))
    set.add(handler as (payload: never) => void)
    return () => this.off(event, handler)
  }

  off<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): void {
    this.handlers.get(event)?.delete(handler as (payload: never) => void)
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      try {
        ;(handler as (payload: Events[K]) => void)(payload)
      } catch (error) {
        // Report it without breaking the call: a page's rendering bug is not a reason to drop the audio.
        if (typeof reportError === "function") reportError(error)
        else console.error(error)
      }
    }
  }
}
