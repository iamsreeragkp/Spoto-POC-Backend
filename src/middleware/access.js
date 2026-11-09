// Optional shared access key for public demos. Off unless ACCESS_KEY is set.
// Clients send it as the `x-access-key` header, or `access_key` query parameter (EventSource cannot set headers).
const crypto = require('crypto');

const same = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const required = () => Boolean(process.env.ACCESS_KEY);

function accessKey(req, res, next) {
  if (!required() || req.method === 'OPTIONS') return next();
  const given = req.get('x-access-key') || req.query.access_key || '';
  if (given && same(given, process.env.ACCESS_KEY)) return next();
  res.status(401).json({ error: 'Access key required or invalid', details: null });
}

module.exports = { accessKey, required };
