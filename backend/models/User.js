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
  // Rights are stored as a list of what is GRANTED, plus a flag saying an admin has actually
  // decided for this person.
  //
  // The obvious shape - an object of booleans - does not survive contact with Mongoose. It
  // materialises its own defaults onto every existing document, and there is then no way to
  // tell "the admin switched this off" apart from "this field never existed". That is
  // exactly how every coordinator lost every right when this feature was added. A list has
  // no such ambiguity: absent means nothing was decided, present means it was.
  // Shift the runner is expected on. Stored as plain HH:mm strings because that is what the
  // office writes on the board; a night shift simply has an end earlier than its start.
  shiftStart: { type: String, default: '' },   // '09:00'
  shiftEnd:   { type: String, default: '' },   // '18:00'
  weekOff:    { type: String, default: '' },   // 'Sunday', 'Rotational', etc.

  rightsSet: { type: Boolean, default: false },
  rightsGranted: { type: [String], default: undefined },

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
    shiftStart: this.shiftStart, shiftEnd: this.shiftEnd, weekOff: this.weekOff,
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
  // A coordinator runs the desk day to day, and that includes adding a new runner and
  // writing his shift - waiting for an admin to do it would stall the shift board. An admin
  // can still take this away from one person through the rights checklist.
  coordinator: {
    manageStaff: true, managePlaces: true, createCases: true,
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

userSchema.statics.RIGHT_KEYS = Object.keys(ROLE_RIGHTS.admin);

// An admin is never limited by stored rights - that is the safety net against somebody
// accidentally saving the office out of its own system.
userSchema.methods.effectiveRights = function () {
  if (this.role === 'admin') return Object.assign({}, ROLE_RIGHTS.admin);

  // No explicit decision on record: this person gets exactly what their role normally gets.
  if (!this.rightsSet || !Array.isArray(this.rightsGranted)) {
    return Object.assign({}, ROLE_RIGHTS[this.role] || ROLE_RIGHTS.runner);
  }

  const granted = this.rightsGranted;
  const out = {};
  Object.keys(ROLE_RIGHTS.admin).forEach(k => { out[k] = granted.indexOf(k) >= 0; });
  return out;
};

// Records an admin's decision. Pass the rights that should be ON; everything else goes off.
userSchema.methods.setRights = function (list) {
  const valid = Object.keys(ROLE_RIGHTS.admin);
  this.rightsGranted = (list || []).filter(r => valid.indexOf(r) >= 0);
  this.rightsSet = true;
};

// Puts this person back on their role's normal set, as if nobody had ever customised them.
userSchema.methods.resetRights = function () {
  this.rightsGranted = undefined;
  this.rightsSet = false;
};

userSchema.methods.can = function (right) {
  return !!this.effectiveRights()[right];
};

module.exports = mongoose.model('User', userSchema);
