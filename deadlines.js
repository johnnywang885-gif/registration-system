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

  const result = await db.execute({
    sql: `SELECT r.id FROM registrations r WHERE r.phase = 1 AND r.status = 'standby'${clubFilter} ORDER BY r.created_at ASC, r.id ASC`
  });
  const standbyList = result.rows || [];
  const toPromote = standbyList.slice(0, available);

  if (toPromote.length === 0) return { promoted: 0 };

  const stmts = toPromote.map(r => ({
    sql: "UPDATE registrations SET status = 'registered' WHERE id = ? AND status = 'standby'",
    args: [Number(r.id)]
  }));
  await db.batch(stmts, 'write');
  return { promoted: toPromote.length };
}

async function forfeitUnpaidByPhase(db, phase) {
  await db.execute({
    sql: `UPDATE registrations
          SET status = 'forfeited'
          WHERE phase = ? AND status = 'registered'
            AND club_id != 0
            AND club_id NOT IN (
              SELECT club_id FROM payment_proofs WHERE status = 'approved'
            )`,
    args: [phase]
  });
}

async function runEnforcement() {
  const db = getDb();
  if (!db) return;

  const settings = await getSettings();
  const today = taipeiToday();
  const quota = parseInt(settings.phase1_total_quota || '160');
  const p1d = settings.phase1_deadline;
  const payd = settings.payment_deadline;
  const p2d = settings.phase2_deadline;

  if (payd && today > payd) {
    await forfeitUnpaidByPhase(db, 1);
  }
  if (p1d && payd && today > p1d && today <= payd) {
    await promoteStandby(db, quota);
  } else if (payd && p2d && today > payd && today <= p2d) {
    await promoteStandby(db, quota, { requirePaidClub: true });
  }
  if (p2d && today > p2d) {
    await forfeitUnpaidByPhase(db, 2);
  }
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
