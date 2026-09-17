const mongoose = require('mongoose');

// A trip is one runner journey: go to a pickup point, collect, go to a drop point, hand over.
//  SAMPLE_PICKUP  -> pickup = hospital,     drop = blood center
//  BLOOD_DELIVERY -> pickup = blood center, drop = hospital
const STAGES = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED', 'EN_ROUTE_DROP', 'AT_DROP', 'COMPLETED', 'REJECTED', 'CANCELLED'];

const tripSchema = new mongoose.Schema({
  tripNo: { type: String, unique: true, index: true },
  case: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true, index: true },
  type: { type: String, enum: ['SAMPLE_PICKUP', 'BLOOD_DELIVERY'], required: true },

  runner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  pickupLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  dropLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },

  status: { type: String, enum: STAGES, default: 'ASSIGNED', index: true },

  // Stage clocks - everything the TAT engine reads
  assignedAt: Date,
  acceptedAt: Date,
  startedAt: Date,
  atPickupAt: Date,
  pickedAt: Date,
  dropStartedAt: Date,
  atDropAt: Date,
  completedAt: Date,
  rejectedAt: Date,
  cancelledAt: Date,

  events: [{
    status: String,
    at: Date,
    lat: Number,
    lng: Number,
    distanceToTargetM: Number,
    note: String,
    by: String
  }],

  sampleBarcode: String,
  unitsCarried: Number,
  proofPhoto: String,
  rejectReason: String,
  runnerNote: String,
  distanceKm: { type: Number, default: 0 },

  // Ring control: the app clears this once the alarm has been shown
  alertPending: { type: Boolean, default: true },
  alertShownAt: Date,

  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

tripSchema.statics.STAGES = STAGES;

module.exports = mongoose.model('Trip', tripSchema);
