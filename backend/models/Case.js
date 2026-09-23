const mongoose = require('mongoose');

// One requirement raised by a hospital / customer. A case runs through two runner
// trips (sample pickup, then blood delivery) with the crossmatch in between.
const caseSchema = new mongoose.Schema({
  caseNo: { type: String, unique: true, index: true },

  // What the runner is being sent for.
  //
  // BLOOD is the original two-leg flow: fetch the sample, crossmatch at the centre, deliver
  // the units. The other three are single errands the desk sends a runner on. IBS runners
  // are not phlebotomists - the hospital staff draw the sample and hand it over - so a job
  // needs a place and a reason, not always a patient.
  jobType: {
    type: String,
    enum: ['BLOOD', 'COLLECTION_SAMPLE', 'PAYMENT_COLLECT', 'PACKAGE_DELIVER'],
    default: 'BLOOD',
    index: true
  },

  // Patient details are only meaningful on a blood case, and even there the runner does not
  // need the name for a sample pickup. Optional at the schema level; the route insists on it
  // for BLOOD cases only.
  patientName: { type: String, default: '', trim: true },

  // What the desk calls this job when there is no patient - a hospital's own slip number,
  // an invoice number, a parcel reference. This is what the runner sees on his phone.
  reference: { type: String, default: '', trim: true },

  // PAYMENT_COLLECT: how much to collect, and what it is against.
  amount: { type: Number, default: 0 },
  amountAgainst: { type: String, default: '' },
  collectedAmount: { type: Number, default: 0 },
  paymentMode: { type: String, enum: ['', 'CASH', 'CHEQUE', 'UPI', 'OTHER'], default: '' },
  paymentRef: { type: String, default: '' },

  // PACKAGE_DELIVER: what is in the parcel, so the runner can check it before leaving.
  packageDetails: { type: String, default: '' },

  // Generic from/to for the three single-errand job types. A blood case uses hospital and
  // bloodCenter below instead, because which end is pickup depends on which leg is running.
  fromLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
  toLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },

  patientAge: String,
  patientGender: { type: String, enum: ['Male', 'Female', 'Other', ''], default: '' },
  bloodGroup: { type: String, default: '' },
  // PCV (packed cell volume), FFP (fresh frozen plasma) and PC (platelet concentrate) are
  // what this centre issues most; the rest are kept so older cases still read correctly.
  component: { type: String, default: 'PCV' },      // PCV / FFP / PC / WB / SDP / RDP / CRYO / PRBC
  unitsRequested: { type: Number, default: 1 },

  hospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
  wardBed: String,
  attendantName: String,
  attendantPhone: String,
  doctorName: String,

  bloodCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },

  priority: { type: String, enum: ['ROUTINE', 'URGENT', 'EMERGENCY'], default: 'ROUTINE', index: true },
  source: { type: String, default: 'Phone' },        // how the inquiry came in
  remarks: String,

  status: {
    type: String,
    // JOB_TRIP / JOB_DONE are the single-errand equivalents of the blood statuses.
    enum: ['NEW', 'SAMPLE_TRIP', 'SAMPLE_AT_CENTER', 'CROSSMATCH', 'READY', 'DELIVERY_TRIP',
           'DELIVERED', 'JOB_TRIP', 'JOB_DONE', 'CLOSED', 'CANCELLED'],
    default: 'NEW',
    index: true
  },

  crossmatch: {
    startedAt: Date,
    completedAt: Date,
    result: { type: String, enum: ['', 'COMPATIBLE', 'INCOMPATIBLE', 'PARTIAL'], default: '' },
    unitsReady: Number,
    bagNumbers: String,
    remarks: String,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },

  sampleTrip: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
  deliveryTrip: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
  // The single trip that carries a non-blood job.
  jobTrip: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },

  closedAt: Date,
  cancelReason: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('Case', caseSchema);
