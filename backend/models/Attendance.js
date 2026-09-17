const mongoose = require('mongoose');

// One row per runner per day. Multiple punch sessions are supported.
const attendanceSchema = new mongoose.Schema({
  runner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  date: { type: String, required: true, index: true },   // YYYY-MM-DD in IST
  sessions: [{
    inAt: Date,
    inLat: Number,
    inLng: Number,
    inAddress: String,
    outAt: Date,
    outLat: Number,
    outLng: Number,
    outAddress: String,
    minutes: Number
  }],
  totalMinutes: { type: Number, default: 0 },
  tripsDone: { type: Number, default: 0 },
  distanceKm: { type: Number, default: 0 },
  open: { type: Boolean, default: false }
}, { timestamps: true });

attendanceSchema.index({ runner: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
