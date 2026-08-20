// 報名進度自動公告：報名人數異動（debounce 合併）或每月 5/10/15/20/25/30 號，
// 自動把「目前報名人數及繳費情形」推播到 LINE 主群組（設定 settings.stats_announce='off' 可停用）。
const { getOne, runQuery } = require('./database');
const { getSettings, taipeiToday } = require('./deadlines');
const { pushToGroup } = require('./linebot');

// 異動後合併發送的緩衝時間（多次異動只發一封）
const CHANGE_DEBOUNCE_MS = 15000;
// 週期檢查頻率（30 分鐘檢查一次當日是否為 5 的倍數日期）
const PERIODIC_INTERVAL_MS = 30 * 60 * 1000;

let changeTimer = null;

// 是否啟用自動公告（預設啟用；管理後台可設 off 關閉）
async function isEnabled() {
  const row = await getOne("SELECT value FROM settings WHERE key = 'stats_announce'");
  return !row || row.value !== 'off';
}

// 每月隔 5 日：5、10、15、20、25、30 號（日期字串 YYYY-MM-DD，驗證格式避免幻數）
function dayMultiple5(dateStr) {
  const m = parseInt(String(dateStr).slice(5, 7), 10);
  const d = parseInt(String(dateStr).slice(8, 10), 10);
  return Number.isFinite(m) && Number.isFinite(d) && m >= 1 && m <= 12 && d >= 5 && d % 5 === 0;
}

// 組公告文字：各階段報名人數＋繳費情形
async function buildStatsMessage() {
  const settings = await getSettings();
  const quota = parseInt(settings.phase1_total_quota || '160', 10) || 160;

  const row = await getOne(`
    SELECT
      COUNT(CASE WHEN phase = 1 AND status = 'registered' THEN 1 END) AS p1_registered,
      COUNT(CASE WHEN phase = 1 AND status = 'paid' THEN 1 END) AS p1_paid,
      COUNT(CASE WHEN phase = 1 AND status = 'standby' THEN 1 END) AS p1_standby,
      COUNT(CASE WHEN phase = 1 AND status = 'forfeited' THEN 1 END) AS p1_forfeited,
      COUNT(CASE WHEN phase = 2 AND status != 'forfeited' THEN 1 END) AS p2_count,
      COUNT(CASE WHEN status IN ('registered','paid') THEN 1 END) AS occupancy
    FROM registrations
  `);
  const paidClubs = await getOne("SELECT COUNT(DISTINCT club_id) AS cnt FROM payment_proofs WHERE status = 'approved'");

  const reg = Number(row && row.p1_registered) || 0;
  const paid = Number(row && row.p1_paid) || 0;
  const standby = Number(row && row.p1_standby) || 0;
  const forfeited = Number(row && row.p1_forfeited) || 0;
  const p2 = Number(row && row.p2_count) || 0;
  const occ = Number(row && row.occupancy) || 0;
  const paidClubsN = Number(paidClubs && paidClubs.cnt) || 0;

  const today = taipeiToday();
  const md = `${parseInt(today.slice(5, 7), 10)}/${parseInt(today.slice(8, 10), 10)}`;

  return [
    `📢 區會報名進度（${md}）`,
    `第一階段：已報名 ${reg} 人（尚待繳費）、已繳費 ${paid} 人、候補 ${standby} 人、棄權 ${forfeited} 人`,
    `繳費情形：已繳費社團 ${paidClubsN} 家、尚待繳費 ${reg} 人`,
    `第二階段：已報名 ${p2} 人`,
    `總名額 ${quota} 人，目前正取 ${occ} 人，尚餘 ${Math.max(0, quota - occ)} 人`
  ].join('\n');
}

// 發送公告。periodic 只在「當日為 5 的倍數日期」且「當日尚未公告過」時送出；
// change（異動觸發）不受此限制，符合「有異動或隔 5 日」雙觸發需求。
async function sendStatsAnnounce(reason = 'change') {
  try {
    if (!(await isEnabled())) return false;
    const today = taipeiToday();
    if (reason === 'periodic') {
      if (!dayMultiple5(today)) return false;
      const last = await getOne("SELECT value FROM settings WHERE key = 'stats_announce_date'");
      if (last && last.value === today) return false;
    }
    const message = await buildStatsMessage();
    const ok = await pushToGroup(message);
    if (ok) {
      await runQuery(
        "INSERT INTO settings (key, value) VALUES ('stats_announce_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [today]
      );
      console.log(`[stats_announce] 已公告報名進度（${reason}）`);
    }
    return ok;
  } catch (err) {
    console.error('[stats_announce] error:', err.message);
    return false;
  }
}

// 異動觸發（debounce 合併：短時間內多筆異動只發一封）
function scheduleStatsAnnounce() {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    sendStatsAnnounce('change');
  }, CHANGE_DEBOUNCE_MS);
}

// 週期排程：每 30 分鐘檢查一次「隔 5 日」規則（即使當日完全沒有 API 流量也會觸發）
function startPeriodicStatsAnnounce() {
  setInterval(() => { sendStatsAnnounce('periodic'); }, PERIODIC_INTERVAL_MS).unref();
}

module.exports = {
  dayMultiple5,
  buildStatsMessage,
  sendStatsAnnounce,
  scheduleStatsAnnounce,
  startPeriodicStatsAnnounce
};