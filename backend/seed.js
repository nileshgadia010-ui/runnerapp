// Creates the first login plus a few sample locations and runners.
// Run once:  npm run seed
require('dotenv').config();
const connectDB = require('./config/db');
const User = require('./models/User');
const Location = require('./models/Location');

async function run() {
  await connectDB();

  const staff = [
    { name: 'IBS Admin', username: 'admin', password: 'admin123', role: 'admin' },
    { name: 'Priya Mam', username: 'priya', password: 'ibs123', role: 'coordinator' },
    { name: 'Desk 2', username: 'desk2', password: 'ibs123', role: 'coordinator' },
    { name: 'Rakesh Runner', username: 'runner1', password: 'runner123', role: 'runner', empCode: 'R-01', phone: '9000000001', vehicleNo: 'GJ-01-AB-1234' },
    { name: 'Suresh Runner', username: 'runner2', password: 'runner123', role: 'runner', empCode: 'R-02', phone: '9000000002', vehicleNo: 'GJ-01-AB-5678' },
    { name: 'Imran Runner', username: 'runner3', password: 'runner123', role: 'runner', empCode: 'R-03', phone: '9000000003', vehicleNo: 'GJ-01-AB-9012' }
  ];

  for (const s of staff) {
    let u = await User.findOne({ username: s.username });
    if (!u) {
      u = new User(s);
      u.setPassword(s.password);
      await u.save();
      console.log('user created:', s.username, '/', s.password);
    }
  }

  const places = [
    { name: 'IBS Blood Centre - Paldi', type: 'BLOOD_CENTER', area: 'Paldi', city: 'Ahmedabad', lat: 23.0120, lng: 72.5650, phone: '9000011111' },
    { name: 'Civil Hospital Asarwa', type: 'HOSPITAL', area: 'Asarwa', city: 'Ahmedabad', lat: 23.0545, lng: 72.6060, phone: '9000022222' },
    { name: 'Sterling Hospital Memnagar', type: 'HOSPITAL', area: 'Memnagar', city: 'Ahmedabad', lat: 23.0480, lng: 72.5390, phone: '9000033333' },
    { name: 'Apollo Hospital Bhat', type: 'HOSPITAL', area: 'Bhat', city: 'Gandhinagar', lat: 23.1000, lng: 72.6200, phone: '9000044444' },
    { name: 'Zydus Hospital SG Highway', type: 'HOSPITAL', area: 'Thaltej', city: 'Ahmedabad', lat: 23.0450, lng: 72.5150, phone: '9000055555' }
  ];

  for (const p of places) {
    if (!(await Location.findOne({ name: p.name }))) {
      await Location.create(p);
      console.log('location created:', p.name);
    }
  }

  console.log('\nSeed finished. Sign in at /  with  admin / admin123');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
