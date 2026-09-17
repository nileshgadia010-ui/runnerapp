const mongoose = require('mongoose');

// Raw breadcrumb trail. Used for the live map and for route replay on a finished trip.
const pingSchema = new mongoose.Schema({
  runner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  trip: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null, index: true },
  lat: Number,
  lng: Number,
  accuracy: Number,
  speed: Number,
  battery: Number,
  at: { type: Date, required: true, index: true }
}, { timestamps: false });

// Breadcrumbs older than 45 days delete themselves so the DB stays small.
pingSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 45 });

module.exports = mongoose.model('LocationPing', pingSchema);
