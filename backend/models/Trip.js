const mongoose = require('mongoose');

// A trip is one runner journey: go to a pickup point, collect, go to a drop point, hand over.
//  SAMPLE_PICKUP     -> pickup = hospital,     drop = blood center
//  BLOOD_DELIVERY    -> pickup = blood center, drop = hospital
//  COLLECTION_SAMPLE -> a plain sample run with no crossmatch behind it
//  PAYMENT_COLLECT   -> go, collect money, bring it back
//  PACKAGE_DELIVER   -> carry a parcel from one place to another
//
// The last three are single errands. They run through the identical stage machine, which is
// the point: one set of buttons on the phone, one TAT report, whatever the runner was sent for.
const STAGES = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED', 'EN_ROUTE_DROP', 'AT_DROP', 'COMPLETED', 'REJECTED', 'CANCELLED'];

const tripSchema = new mongoose.Schema({
  tripNo: { type: String, unique: true, index: true },
  case: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true, index: true },
  type: {
    type: String,
    enum: ['SAMPLE_PICKUP', 'BLOOD_DELIVERY', 'COLLECTION_SAMPLE', 'PAYMENT_COLLECT', 'PACKAGE_DELIVER'],
    required: true
  },

  // Where this trip sits in the runner's queue. 0 is the one he is working on now; anything
  // higher is waiting behind it. The desk can hand a runner his next job before he has
  // finished the current one, which is how a busy afternoon actually works.
  queueOrder: { type: Number, default: 0, index: true },

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

  // What the runner brought back from a payment job.
  amountCollected: Number,
  paymentMode: String,
  paymentRef: String,
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
