const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 }
});

const Counter = mongoose.model('Counter', counterSchema);

// Gives readable running numbers like IBS-20260916-0007
async function nextNumber(prefix) {
  const d = new Date();
  const key = prefix + '-' + d.toISOString().slice(0, 10).replace(/-/g, '');
  const row = await Counter.findByIdAndUpdate(key, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return key + '-' + String(row.seq).padStart(4, '0');
}

module.exports = { Counter, nextNumber };
