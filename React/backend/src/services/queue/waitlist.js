/**
 * Waitlist for a station whose slots are full.
 *
 * Ordering is first-booked-first-served, so priority is the request timestamp.
 * A plain array with .sort() on every insert is O(n log n) per booking; a
 * binary heap is O(log n), which matters when a popular station accumulates
 * hundreds of waiting customers and every "served" event triggers a promotion.
 *
 * `priority` is a number where LOWER wins (min-heap). Callers pass the
 * enqueue timestamp for FIFO. A lower number can also encode genuine
 * precedence -- emergency vehicles, prepaid customers -- without changing
 * any of the heap logic.
 *
 * Ties break on insertion sequence so the heap is a stable FIFO, which a raw
 * binary heap is not.
 */

class PriorityQueue {
  constructor(compare) {
    this.heap = [];
    this.seq = 0;
    // default: lower priority first, then earlier insertion
    this.compare =
      compare ||
      ((a, b) => a.priority - b.priority || a.seq - b.seq);
  }

  get size() {
    return this.heap.length;
  }

  isEmpty() {
    return this.heap.length === 0;
  }

  push(value, priority) {
    const node = { value, priority, seq: this.seq++ };
    this.heap.push(node);
    this.#siftUp(this.heap.length - 1);
    return node;
  }

  peek() {
    return this.heap.length ? this.heap[0].value : undefined;
  }

  pop() {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.#siftDown(0);
    }
    return top.value;
  }

  /**
   * Remove the first entry whose value satisfies `predicate` -- a customer
   * cancelling while on the waitlist. O(n) to find, O(log n) to repair.
   */
  remove(predicate) {
    const i = this.heap.findIndex((n) => predicate(n.value));
    if (i === -1) return undefined;

    const [node] = this.heap.splice(i, 1);
    if (i < this.heap.length) {
      // The element that slid into position i may violate the heap in
      // either direction, so try both.
      this.#siftUp(i);
      this.#siftDown(i);
    }
    return node.value;
  }

  /** Ordered snapshot. Sorts a copy -- the heap array itself is not ordered. */
  toArray() {
    return [...this.heap].sort(this.compare).map((n) => n.value);
  }

  #siftUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[parent]) >= 0) break;
      this.#swap(i, parent);
      i = parent;
    }
  }

  #siftDown(i) {
    const n = this.heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let best = i;

      if (l < n && this.compare(this.heap[l], this.heap[best]) < 0) best = l;
      if (r < n && this.compare(this.heap[r], this.heap[best]) < 0) best = r;
      if (best === i) break;

      this.#swap(i, best);
      i = best;
    }
  }

  #swap(a, b) {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
  }
}

/**
 * Per-station waitlists, held in memory.
 *
 * Deliberately not the source of truth: every entry also exists as a Booking
 * row with status 'waitlisted'. This is a fast index over that data, and
 * rebuildFrom() repopulates it after a restart.
 */
class WaitlistRegistry {
  constructor() {
    this.queues = new Map(); // stationId -> PriorityQueue
  }

  #queueFor(stationId) {
    const key = String(stationId);
    if (!this.queues.has(key)) this.queues.set(key, new PriorityQueue());
    return this.queues.get(key);
  }

  /**
   * Join the waitlist. `requestedAt` defaults to now, giving FIFO ordering.
   * Returns the 1-based position the customer can be shown.
   */
  enqueue(stationId, entry, requestedAt = Date.now()) {
    const q = this.#queueFor(stationId);
    q.push({ ...entry, requestedAt }, entry.priority ?? requestedAt);
    return this.positionOf(stationId, (e) => e.bookingId === entry.bookingId);
  }

  /** Promote the next customer when a slot frees up. */
  promoteNext(stationId) {
    const q = this.queues.get(String(stationId));
    return q ? q.pop() : undefined;
  }

  cancel(stationId, bookingId) {
    const q = this.queues.get(String(stationId));
    return q ? q.remove((e) => e.bookingId === bookingId) : undefined;
  }

  /** 1-based position, or -1 if not waiting. */
  positionOf(stationId, predicate) {
    const q = this.queues.get(String(stationId));
    if (!q) return -1;
    const i = q.toArray().findIndex(predicate);
    return i === -1 ? -1 : i + 1;
  }

  list(stationId) {
    const q = this.queues.get(String(stationId));
    return q ? q.toArray() : [];
  }

  size(stationId) {
    const q = this.queues.get(String(stationId));
    return q ? q.size : 0;
  }

  clear(stationId) {
    if (stationId === undefined) this.queues.clear();
    else this.queues.delete(String(stationId));
  }

  /** Rebuild from persisted waitlisted bookings after a restart. */
  rebuildFrom(bookings = []) {
    this.clear();
    for (const b of bookings) {
      const at = new Date(b.createdAt || Date.now()).getTime();
      this.enqueue(
        b.station,
        { bookingId: String(b._id), user: b.user, slot: b.slot, date: b.date },
        at,
      );
    }
    return this;
  }
}

module.exports = {
  PriorityQueue,
  WaitlistRegistry,
  waitlist: new WaitlistRegistry(),
};
