const mongoose = require('mongoose');

// One row per runner per day. Multiple punch sessions are supported.
// Odometer readings are captured with a photo of the bike meter at the first punch in
// and the last punch out, so the office can cross-check GPS kilometres against the meter.
const attendanceSchema = new mongoose.Schema({
  runner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  date: { type: String, required: true, index: true },   // YYYY-MM-DD in IST
  sessions: [{
    inAt: Date,
    inLat: Number,
    inLng: Number,
    inAddress: String,
    inOdo: Number,
    inOdoPhoto: String,
    outAt: Date,
    outLat: Number,
    outLng: Number,
    outAddress: String,
    outOdo: Number,
    outOdoPhoto: String,
    minutes: Number
  }],
  totalMinutes: { type: Number, default: 0 },
  tripsDone: { type: Number, default: 0 },
  distanceKm: { type: Number, default: 0 },      // from GPS pings

  // Odometer figures for the whole day (first punch in, last punch out)
  startOdo: { type: Number, default: 0 },
  endOdo: { type: Number, default: 0 },
  odoKm: { type: Number, default: 0 },
  startOdoPhoto: { type: String },
  endOdoPhoto: { type: String },

  open: { type: Boolean, default: false }
}, { timestamps: true });

attendanceSchema.index({ runner: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
