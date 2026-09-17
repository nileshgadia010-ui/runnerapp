const mongoose = require('mongoose');

/**
 * Uploaded photos, stored in MongoDB rather than on disk.
 *
 * Why not the filesystem: on Render (and most container hosts) the disk is wiped on every
 * deploy. Proof-of-handover photos and odometer shots are the evidence this whole system
 * exists to produce, so losing them on a routine code push is not acceptable. A mounted
 * persistent disk is the other option, but that needs a paid plan; the database is already
 * paid for, already backed up, and already survives deploys.
 *
 * Size is not a problem in practice. The app shrinks every photo to 1280 px at JPEG 72
 * before upload, so a typical file is 150-250 KB - far under MongoDB's 16 MB document
 * limit, and roughly 2,000 photos per free-tier gigabyte. Old photos can be pruned by date
 * when that starts to matter; see the TTL note at the bottom.
 */
const photoSchema = new mongoose.Schema({
  data: { type: Buffer, required: true },
  contentType: { type: String, default: 'image/jpeg' },
  bytes: { type: Number, default: 0 },

  // What this photo is evidence of, so it can be found and pruned sensibly.
  kind: { type: String, enum: ['PROOF', 'ODO_IN', 'ODO_OUT', 'OTHER'], default: 'OTHER', index: true },
  runner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  trip: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null },

  // Where the phone was when the shutter fired. Makes a photo checkable against the trail.
  lat: Number,
  lng: Number,

  at: { type: Date, default: Date.now, index: true }
}, { timestamps: false });

// If storage ever gets tight, uncomment this to drop photos automatically after a year.
// Do it deliberately - these are the records that settle a dispute with a hospital.
// photoSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

module.exports = mongoose.model('Photo', photoSchema);
