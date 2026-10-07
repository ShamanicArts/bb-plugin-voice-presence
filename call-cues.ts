export type CallCue = "connected" | "disconnected";

/** The same WebAudio score is used in calls and in offline review renders. */
export function scheduleCallCue(context: BaseAudioContext, cue: CallCue) {
  const notes = cue === "connected" ? [523.25, 783.99] : [783.99, 523.25];
  const nodes: Array<{ oscillator: OscillatorNode; gain: GainNode }> = [];
  let resolve!: () => void;
  const done = new Promise<void>((finish) => { resolve = finish; });
  let remaining = notes.length;
  const cancel = () => {
    for (const { oscillator, gain } of nodes) {
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* Already stopped or not started. */ }
      oscillator.disconnect();
      gain.disconnect();
    }
    resolve();
  };
  try {
    const start = context.currentTime + 0.005;
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      nodes.push({ oscillator, gain });
      const at = start + index * 0.105;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.045, at + 0.009);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      gain.gain.linearRampToValueAtTime(0, at + 0.15);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => {
        oscillator.onended = null;
        oscillator.disconnect();
        gain.disconnect();
        if (--remaining === 0) resolve();
      };
      oscillator.start(at);
      oscillator.stop(at + 0.15);
    });
  } catch {
    // Optional sounds must never interrupt the media lifecycle.
    cancel();
  }
  return { done, cancel };
}

/** Owned by the media transport, never by a caption/composer render. */
export class CallAudioCues {
  private established = false;
  private ended = false;
  private disposed = false;
  private playing: ReturnType<typeof scheduleCallCue> | null = null;

  constructor(private readonly context: AudioContext) {}

  connected(): void {
    if (this.established || this.ended || this.disposed) return;
    this.established = true;
    this.play("connected");
  }

  end(): void {
    if (!this.established || this.ended || this.disposed) return;
    this.ended = true;
    this.play("disconnected");
  }

  private play(cue: CallCue): void {
    this.playing?.cancel();
    // Don't queue a stale tone to play on a later permission/gesture resume.
    // The media path already owns its nonblocking gesture/resume handlers.
    this.playing = this.context.state === "running" ? scheduleCallCue(this.context, cue) : null;
    const playing = this.playing;
    if (playing !== null) void playing.done.then(() => {
      if (!this.disposed && this.playing === playing) this.playing = null;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.end();
    this.disposed = true;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.playing?.cancel();
      this.playing = null;
      void this.context.close().catch(() => undefined);
    };
    if (this.playing === null) {
      close();
      return;
    }
    // Tracks, peers and listeners are released immediately by the caller.
    // Only the output context survives for the short end cue. Bound cleanup
    // if the browser suspends it and never delivers oscillator.onended.
    const timer = setTimeout(close, 600);
    void this.playing.done.then(() => {
      clearTimeout(timer);
      close();
    });
  }
}
