const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getOne } = require('./database');

function getSecret() {
  return process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
}
if (!process.env.JWT_SECRET) {
  console.log('JWT_SECRET 未設定，啟動時將自動生成並持久化到資料庫。');
}

// 管理後台功能權限（對應 admin.html 各頁籤）
const ADMIN_PERMS = ['registrations', 'payments', 'clubs', 'settings', 'standby', 'feedback', 'linedigest', 'announce'];

// 取得使用者的後台權限清單：系統管理員（is_admin=1）＝全部；
// 次管理者＝ clubs.admin_perms 欄位（JSON 陣列，僅保留合法權限）
function getAdminPerms(club) {
  if (!club) return [];
  if (club.is_admin === 1) return [...ADMIN_PERMS];
  if (!club.admin_perms) return [];
  try {
    const arr = JSON.parse(club.admin_perms);
    if (!Array.isArray(arr)) return [];
    return arr.filter(p => ADMIN_PERMS.includes(p));
  } catch (err) {
    return [];
  }
}

function generateToken(club) {
  const perms = getAdminPerms(club);
  const payload = {
    clubId: club.club_id,
    clubName: club.club_name,
    isAdmin: perms.length > 0
  };
  if (club.is_admin === 1) payload.superAdmin = true;
  if (perms.length > 0) payload.perms = perms;
  return jwt.sign(payload, getSecret(), { expiresIn: '24h' });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
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

// 任何管理者（系統管理員或次管理者）皆可通過
function anyAdminMiddleware(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: '無管理者權限' });
  }
  next();
}

// 僅系統管理員可通過（次管理者 token 帶 perms 陣列但無 superAdmin；舊 token 無 perms 欄位視為系統管理員）
function adminMiddleware(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '未登入' });
  }
  const isSuper = req.user.superAdmin === true || (req.user.isAdmin === true && !Array.isArray(req.user.perms));
  if (!isSuper) {
    return res.status(403).json({ error: '無管理者權限' });
  }
  next();
}

// 依功能權限檢查：系統管理員（含舊版 token）全部通行，次管理者僅限被勾選的功能
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: '未登入' });
    }
    if (req.user.isAdmin && (!Array.isArray(req.user.perms) || req.user.perms.includes(perm))) {
      return next();
    }
    return res.status(403).json({ error: '無此功能權限' });
  };
}

module.exports = { generateToken, verifyToken, authMiddleware, anyAdminMiddleware, adminMiddleware, requirePerm, getAdminPerms, ADMIN_PERMS };
