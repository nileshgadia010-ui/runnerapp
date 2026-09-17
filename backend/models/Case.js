const mongoose = require('mongoose');

// One requirement raised by a hospital / customer. A case runs through two runner
// trips (sample pickup, then blood delivery) with the crossmatch in between.
const caseSchema = new mongoose.Schema({
  caseNo: { type: String, unique: true, index: true },

  patientName: { type: String, required: true, trim: true },
  patientAge: String,
  patientGender: { type: String, enum: ['Male', 'Female', 'Other', ''], default: '' },
  bloodGroup: { type: String, default: '' },
  component: { type: String, default: 'PRBC' },     // WB / PRBC / FFP / SDP / RDP / CRYO
  unitsRequested: { type: Number, default: 1 },

  hospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  wardBed: String,
  attendantName: String,
  attendantPhone: String,
  doctorName: String,

  bloodCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },

  priority: { type: String, enum: ['ROUTINE', 'URGENT', 'EMERGENCY'], default: 'ROUTINE', index: true },
  source: { type: String, default: 'Phone' },        // how the inquiry came in
  remarks: String,

  status: {
    type: String,
    enum: ['NEW', 'SAMPLE_TRIP', 'SAMPLE_AT_CENTER', 'CROSSMATCH', 'READY', 'DELIVERY_TRIP', 'DELIVERED', 'CLOSED', 'CANCELLED'],
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

  closedAt: Date,
  cancelReason: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('Case', caseSchema);
