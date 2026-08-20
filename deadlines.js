const { getDb } = require('./database');

function taipeiToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

function phaseState(settings, today) {
  const phase1Deadline = settings.phase1_deadline;
  const paymentDeadline = settings.payment_deadline;
  const phase2Deadline = settings.phase2_deadline;

  if (phase2Deadline && today > phase2Deadline) return 'closed';
  if (phase1Deadline && today > phase1Deadline) {
    if (paymentDeadline && today <= paymentDeadline) return 'phase1_closed';
    return 'phase2';
  }
  return 'phase1';
}

async function getSettings() {
  const { getAll } = require('./database');
  const rows = await getAll("SELECT key, value FROM settings");
  const settings = {};
  rows.forEach(s => { settings[s.key] = s.value; });
  return settings;
}

async function occupancy(db) {
  const result = await db.execute({
    sql: "SELECT COUNT(*) as cnt FROM registrations WHERE status IN ('registered', 'paid')"
  });
  return Number(result.rows[0]?.cnt) || 0;
}

async function promoteStandby(db, quota, options = {}) {
  const { requirePaidClub = false } = options;
  const current = await occupancy(db);
  const available = quota - current;
  if (available <= 0) return { promoted: 0 };

  const clubFilter = requirePaidClub
    ? " AND r.club_id IN (SELECT club_id FROM payment_proofs WHERE status = 'approved')"
    : "";

  // 單一語句原子完成「讀取候補清單＋更新」（讀取與寫入之間無空隙，
  // 併發執行也不會超過 quota：條件式子查詢只會撈到當下仍是 standby 的列）
  const result = await db.execute({
    sql: `UPDATE registrations SET status = 'registered'
          WHERE id IN (
            SELECT r.id FROM registrations r
            WHERE r.phase = 1 AND r.status = 'standby'${clubFilter}
            ORDER BY r.created_at ASC, r.id ASC
            LIMIT ?
          ) AND status = 'standby'`,
    args: [available]
  });
  return { promoted: Number(result.rowsAffected) || 0 };
}

async function forfeitUnpaidByPhase(db, phase) {
  const result = await db.execute({
    sql: `UPDATE registrations
          SET status = 'forfeited'
          WHERE phase = ? AND status = 'registered'
            AND club_id != 0
            AND club_id NOT IN (
              SELECT club_id FROM payment_proofs WHERE status = 'approved'
            )`,
    args: [phase]
  });
  return Number(result.rowsAffected) || 0;
}

async function runEnforcement() {
  const db = getDb();
  if (!db) return { changed: false };

  const settings = await getSettings();
  const today = taipeiToday();
  const quota = parseInt(settings.phase1_total_quota || '160');
  const p1d = settings.phase1_deadline;
  const payd = settings.payment_deadline;
  const p2d = settings.phase2_deadline;

  let changed = false;
  if (payd && today > payd) {
    const n = await forfeitUnpaidByPhase(db, 1);
    if (n > 0) changed = true;
  }
  if (p1d && payd && today > p1d && today <= payd) {
    const r = await promoteStandby(db, quota);
    if (r.promoted > 0) changed = true;
  } else if (payd && p2d && today > payd && today <= p2d) {
    const r = await promoteStandby(db, quota, { requirePaidClub: true });
    if (r.promoted > 0) changed = true;
  }
  if (p2d && today > p2d) {
    const n = await forfeitUnpaidByPhase(db, 2);
    if (n > 0) changed = true;
  }

  // 自動轉換（遞補/棄權）改變了人數 → 觸發報名進度自動公告（lazy require 避免循環依賴）
  if (changed) {
    try {
      require('./stats_announce').scheduleStatsAnnounce();
    } catch (err) {
      console.error('stats_announce trigger error:', err.message);
    }
  }
  return { changed };
}

let lastEnforceTime = 0;
const ENFORCE_INTERVAL = 5000;

async function enforceDeadlines(req, res, next) {
  const now = Date.now();
  if (now - lastEnforceTime > ENFORCE_INTERVAL) {
    lastEnforceTime = now;
    runEnforcement().catch(err => {
      console.error('enforceDeadlines error:', err.message);
    });
  }
  next();
}

module.exports = {
  taipeiToday,
  phaseState,
  getSettings,
  occupancy,
  promoteStandby,
  forfeitUnpaidByPhase,
  runEnforcement,
  enforceDeadlines
};
