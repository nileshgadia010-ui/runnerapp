const mongoose = require('mongoose');

// Master list of every place a runner can be sent to.
// BLOOD_CENTER rows are the bases the runners start from and return to.
const locationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['HOSPITAL', 'BLOOD_CENTER', 'LAB', 'CLINIC', 'OTHER'], default: 'HOSPITAL', index: true },
  code: { type: String, trim: true },
  contactPerson: { type: String, trim: true },
  phone: { type: String, trim: true },
  address: { type: String, trim: true },
  area: { type: String, trim: true },
  city: { type: String, trim: true, default: 'Ahmedabad' },
  pincode: { type: String, trim: true },

  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  // How close the runner must be for the app to treat him as "reached" (metres)
  geofence: { type: Number, default: 200 },

  notes: String,
  active: { type: Boolean, default: true }
}, { timestamps: true });

locationSchema.index({ name: 'text', area: 'text', city: 'text' });

module.exports = mongoose.model('Location', locationSchema);
