// call-store.mjs — the conference-call speak-queue (CONFERENCE_CALL.md §4).
// Pure data structure: one speaker at a time, FIFO behind the current turn.
// The daemon owns broadcast, speechify, and the watchdog; this owns only the
// ordering invariant so it can be reasoned about and tested in isolation.

export class CallQueue {
  constructor() {
    this.queue = [];
    this.current = null;
  }

  enqueue(item) {
    this.queue.push(item);
    return item;
  }

  // Promote the next item to the floor if nobody holds it. Returns the new
  // current item, or null when the floor is busy or the queue is empty.
  advance() {
    if (this.current) return null;
    this.current = this.queue.shift() || null;
    return this.current;
  }

  // Release the floor for `id` (the speaker that just finished). Returns the
  // finished item, or null if `id` wasn't the one speaking.
  ack(id) {
    if (this.current && this.current.id === id) {
      const done = this.current;
      this.current = null;
      return done;
    }
    return null;
  }

  state() {
    return {
      speaking: !!this.current,
      current: this.current,
      queue: this.queue.slice(),
      queued: this.queue.length,
    };
  }
}
