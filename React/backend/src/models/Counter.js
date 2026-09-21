const mongoose = require("mongoose");

/**
 * Named sequences, incremented atomically ($inc with upsert): invoice numbers
 * per station and financial year, "invoice:<stationId>:2026-27".
 */
const CounterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
});

/** The next number in a sequence, starting at 1. Safe under concurrency. */
CounterSchema.statics.next = async function next(key) {
  const doc = await this.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" }).lean();
  return doc.seq;
};

module.exports = mongoose.model("Counter", CounterSchema);
