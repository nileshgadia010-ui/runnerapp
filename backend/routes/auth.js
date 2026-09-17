const router = require('express').Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const SLA = require('../config/sla');
const { auth } = require('../middleware/auth');

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Enter your user ID and password' });

  const user = await User.findOne({ username: String(username).toLowerCase().trim() });
  if (!user || !user.checkPassword(password)) {
    return res.status(401).json({ error: 'User ID or password is not correct' });
  }
  if (!user.active) return res.status(403).json({ error: 'This account is switched off. Contact the IBS desk.' });

  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'dev-secret', {
    expiresIn: process.env.JWT_EXPIRES || '30d'
  });

  user.lastSeenAt = new Date();
  await user.save();

  res.json({ token, user: user.publicJSON(), config: { pingInterval: SLA.pingInterval, pollInterval: SLA.pollInterval } });
});

router.get('/me', auth, async (req, res) => {
  res.json({ user: req.user.publicJSON(), config: { pingInterval: SLA.pingInterval, pollInterval: SLA.pollInterval } });
});

router.post('/change-password', auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!req.user.checkPassword(oldPassword)) return res.status(400).json({ error: 'Current password is not correct' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  req.user.setPassword(newPassword);
  await req.user.save();
  res.json({ ok: true });
});

module.exports = router;
