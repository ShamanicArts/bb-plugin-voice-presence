/** Local handoff ordering only. This never commits audio or controls provider VAD. */
export class CallHandoffQueue {
  private draftId: string | null = null;
  private finalized: { itemId: string; text: string } | null = null;
  private readonly pending = new Map<string, { itemId: string | null; text: string | null }>();

  draft(itemId: string): void {
    this.draftId = itemId;
    this.finalized = null;
  }

  request(id: string, text: string, inputActive = false): { id: string; utteranceId: string | null; text: string } | null {
    if (this.pending.has(id)) return null;
    if (this.draftId === null) {
      const request = { id, utteranceId: this.finalized?.itemId ?? null, text: this.finalized?.text ?? text };
      if (!inputActive) return request;
      this.defer(request);
      return null;
    }
    // A delegation racing a turn-final must never submit the partial caption.
    this.pending.set(id, { itemId: this.draftId, text: this.draftId === null ? text : null });
    return null;
  }

  finalize(itemId: string, text: string): void {
    if (this.draftId === itemId || this.draftId === null) {
      this.draftId = null;
      this.finalized = { itemId, text };
    }
    for (const request of this.pending.values()) {
      if (request.itemId === itemId) request.text = text;
    }
  }

  defer(request: { id: string; utteranceId: string | null; text: string }): void {
    this.pending.set(request.id, { itemId: request.utteranceId, text: request.text });
  }

  ready(inputActive: boolean): Array<{ id: string; utteranceId: string | null; text: string }> {
    if (inputActive) return [];
    const ready = [];
    for (const [id, request] of this.pending) {
      if (request.text === null) continue;
      ready.push({ id, utteranceId: request.itemId, text: request.text });
      this.pending.delete(id);
    }
    return ready;
  }
}
