const jwt = require('jsonwebtoken');
const User = require('../models/User');

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
    if (!token) return res.status(401).json({ error: 'Sign in to continue' });

    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    const user = await User.findById(payload.id);
    if (!user || !user.active) return res.status(401).json({ error: 'This account is no longer active' });

    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired, sign in again' });
  }
}

// Usage: router.post('/', auth, allow('admin','coordinator'), handler)
function allow(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have access to this action' });
    }
    next();
  };
}

module.exports = { auth, allow };
