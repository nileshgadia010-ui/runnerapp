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
  // Android reports when a fix came from a fake-GPS app. Stored so the desk can see it.
  mock: { type: Boolean, default: false },
  at: { type: Date, required: true }
}, { timestamps: false });

// Breadcrumbs older than 45 days delete themselves so the DB stays small.
// Note: `at` is indexed only here - declaring `index: true` on the field as well would
// create a second index on the same key and make Mongoose log a duplicate index warning.
pingSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 45 });
pingSchema.index({ runner: 1, at: 1 });

module.exports = mongoose.model('LocationPing', pingSchema);
