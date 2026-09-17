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

  // Tamper signals reported by the app. These are hints, not proof - a determined person
  // can defeat any client side check - but they let the desk see who is worth asking about.
  // What this account is allowed to do. Role sets a sensible default; these switches let the
  // office widen or narrow one person without inventing a new role. An admin always has
  // everything, so a locked-out office is impossible.
  //
  // These deliberately have NO default. A default of false would be written onto every
  // existing document by Mongoose, and an explicit false always beats the role default -
  // which would silently strip every coordinator of every right the moment this field was
  // added. Undefined means "not decided for this person, use the role's normal set".
  rights: {
    manageStaff:    { type: Boolean },   // add and edit user accounts
    managePlaces:   { type: Boolean },   // hospitals, centres, geofences
    createCases:    { type: Boolean },
    assignTrips:    { type: Boolean },   // assign, reassign, re-ping, cancel
    overrideStages: { type: Boolean },   // move a stage on the runner's behalf
    editSettings:   { type: Boolean },   // crossmatch, close, cancel a case
    viewReports:    { type: Boolean }
  },

  integrity: {
    vpn: { type: Boolean, default: false },
    mockLocation: { type: Boolean, default: false },
    rooted: { type: Boolean, default: false },
    devMode: { type: Boolean, default: false },
    at: Date,
    lastFlaggedAt: Date,
    flagCount: { type: Number, default: 0 }
  },

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
    lastSeenAt: this.lastSeenAt, active: this.active, integrity: this.integrity,
    rights: this.effectiveRights()
  };
};

// Defaults per role, applied whenever a right has not been set explicitly.
const ROLE_RIGHTS = {
  admin: {
    manageStaff: true, managePlaces: true, createCases: true,
    assignTrips: true, overrideStages: true, editSettings: true, viewReports: true
  },
  coordinator: {
    manageStaff: false, managePlaces: true, createCases: true,
    assignTrips: true, overrideStages: true, editSettings: true, viewReports: true
  },
  runner: {
    manageStaff: false, managePlaces: false, createCases: false,
    assignTrips: false, overrideStages: false, editSettings: false, viewReports: false
  }
};

userSchema.statics.defaultRights = function (role) {
  return Object.assign({}, ROLE_RIGHTS[role] || ROLE_RIGHTS.runner);
};

// An admin is never limited by a stored switch - that is the safety net against somebody
// accidentally saving themselves out of the system.
userSchema.methods.effectiveRights = function () {
  if (this.role === 'admin') return Object.assign({}, ROLE_RIGHTS.admin);

  const out = Object.assign({}, ROLE_RIGHTS[this.role] || ROLE_RIGHTS.runner);
  const stored = this.rights ? (this.rights.toObject ? this.rights.toObject() : this.rights) : {};

  // Only a real true/false counts as a decision. Anything undefined or null leaves the
  // role default in place - copying it blindly is what wiped everyone's access before.
  Object.keys(out).forEach(k => {
    if (typeof stored[k] === 'boolean') out[k] = stored[k];
  });
  return out;
};

userSchema.methods.can = function (right) {
  return !!this.effectiveRights()[right];
};

module.exports = mongoose.model('User', userSchema);
