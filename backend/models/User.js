const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// One collection for everyone who logs in: admin, coordinator (the 2 IBS desk people)
// and runner (the field staff who carry samples and blood units).
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'coordinator', 'runner'], default: 'runner', index: true },

  empCode: { type: String, trim: true },
  phone: { type: String, trim: true },
  vehicleNo: { type: String, trim: true },
  branch: { type: String, trim: true, default: 'Main' },
  photo: { type: String },

  // Live state of a runner
  dutyState: { type: String, enum: ['OFF_DUTY', 'AVAILABLE', 'ON_TRIP', 'BREAK'], default: 'OFF_DUTY', index: true },
  activeTrip: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null },
  lastLocation: {
    lat: Number,
    lng: Number,
    accuracy: Number,
    speed: Number,
    battery: Number,
    at: Date
  },
  lastSeenAt: Date,
  appVersion: String,

  active: { type: Boolean, default: true }
}, { timestamps: true });

userSchema.methods.setPassword = function (plain) {
  this.passwordHash = bcrypt.hashSync(plain, 10);
};
userSchema.methods.checkPassword = function (plain) {
  return bcrypt.compareSync(plain, this.passwordHash || '');
};
userSchema.methods.publicJSON = function () {
  return {
    id: this._id, name: this.name, username: this.username, role: this.role,
    empCode: this.empCode, phone: this.phone, vehicleNo: this.vehicleNo, branch: this.branch,
    dutyState: this.dutyState, activeTrip: this.activeTrip, lastLocation: this.lastLocation,
    lastSeenAt: this.lastSeenAt, active: this.active
  };
};

module.exports = mongoose.model('User', userSchema);
