const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getOne } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('警告: JWT_SECRET 未設定，使用隨機密鑰。伺服器重啟後所有登入將失效。建議在 Railway 設定 JWT_SECRET。');
}

function generateToken(club) {
  return jwt.sign(
    { clubId: club.club_id, clubName: club.club_name, isAdmin: club.is_admin },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登入' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: '登入已過期，請重新登入' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: '無管理者權限' });
  }
  next();
}

module.exports = { generateToken, verifyToken, authMiddleware, adminMiddleware };
