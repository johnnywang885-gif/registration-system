// 報名進度自動公告：報名人數異動（debounce 合併）或每月 5/10/15/20/25/30 號，
// 自動把「目前報名人數及繳費情形」推播到 LINE 主群組（設定 settings.stats_announce='off' 可停用）。
// 每次嘗試結果寫入 settings 供後台診斷：成功 → stats_last_ok_at / stats_last_snapshot / stats_announce_date；
// 失敗 → stats_last_error / stats_last_error_at / stats_fail_count；連續失敗達門檻自動開意見回饋單提醒管理員。
// 內容去重：異動觸發時若各項人數與上次成功公告完全相同則不重複推送（節省 LINE 每月推播額度）。
const { getOne, runQuery, insert } = require('./database');
const { getSettings, taipeiToday } = require('./deadlines');
const { pushToGroupDetail } = require('./linebot');

// 異動後合併發送的緩衝時間（多次異動只發一封；延長至 60min 以節省 LINE 每月 push 額度）
const CHANGE_DEBOUNCE_MS = 60 * 60 * 1000;
// 週期檢查頻率（30 分鐘檢查一次當日是否為 5 的倍數日期）
const PERIODIC_INTERVAL_MS = 30 * 60 * 1000;
// 連續推送失敗達此次數時，自動開一張意見回饋單提醒管理員（每天最多一張）
const FAIL_TICKET_THRESHOLD = 3;

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

async function setSetting(key, value) {
  await runQuery(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

// 即時統計各階段人數與繳費社團家數（供公告文字與內容去重快照共用）
async function collectStats() {
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

  return {
    reg: Number(row && row.p1_registered) || 0,
    paid: Number(row && row.p1_paid) || 0,
    standby: Number(row && row.p1_standby) || 0,
    forfeited: Number(row && row.p1_forfeited) || 0,
    p2: Number(row && row.p2_count) || 0,
    occ: Number(row && row.occupancy) || 0,
    paidClubs: Number(paidClubs && paidClubs.cnt) || 0,
    quota
  };
}

// 組公告文字：各階段報名人數＋繳費情形
function formatStatsMessage(s) {
  const today = taipeiToday();
  const md = `${parseInt(today.slice(5, 7), 10)}/${parseInt(today.slice(8, 10), 10)}`;

  return [
    `📢 區會報名進度（${md}）`,
    `第一階段：已報名 ${s.reg} 人（尚待繳費）、已繳費 ${s.paid} 人、候補 ${s.standby} 人、棄權 ${s.forfeited} 人`,
    `繳費情形：已繳費社團 ${s.paidClubs} 家、尚待繳費 ${s.reg} 人`,
    `第二階段：已報名 ${s.p2} 人`,
    `總名額 ${s.quota} 人，目前正取 ${s.occ} 人，尚餘 ${Math.max(0, s.quota - s.occ)} 人`
  ].join('\n');
}

async function buildStatsMessage() {
  return formatStatsMessage(await collectStats());
}

async function bumpFailCount() {
  const row = await getOne("SELECT value FROM settings WHERE key = 'stats_fail_count'");
  return (parseInt(row && row.value, 10) || 0) + 1;
}

async function recordFailure(errorMsg, count) {
  await setSetting('stats_last_error', String(errorMsg || 'unknown').slice(0, 300));
  await setSetting('stats_last_error_at', new Date().toISOString());
  await setSetting('stats_fail_count', String(count));
  if (count >= FAIL_TICKET_THRESHOLD) await openFailTicketIfNeeded();
}

// 連續失敗自動開單（每天最多一張），讓管理員從意見回饋列表注意到推播壞了
async function openFailTicketIfNeeded() {
  const today = taipeiToday();
  const row = await getOne("SELECT value FROM settings WHERE key = 'stats_fail_ticket_date'");
  if (row && row.value === today) return;
  await setSetting('stats_fail_ticket_date', today);
  const errRow = await getOne("SELECT value FROM settings WHERE key = 'stats_last_error'");
  await insert(
    "INSERT INTO feedback (club_id, display_name, category, message, status) VALUES (?, ?, ?, ?, 'open')",
    [null, '系統自動公告', '錯誤回報',
      `【報名公告推播失敗】報名進度自動公告連續推送失敗，請管理員到後台「系統設定」按「測試推播」查看原因。最新錯誤：${errRow ? errRow.value : 'unknown'}`
    ]
  );
}

// 發送公告。periodic 只在「當日為 5 的倍數日期」且「當日尚未公告過」時送出；
// change（異動觸發）不受此限制但受內容去重限制；manual（後台測試推播）強制發送、繞過所有限制。
// 自動統計（change/periodic）達月預算 WARN（預設 180/200）後完全跳過，手動測試不受 WARN 限制。
async function sendStatsAnnounce(reason = 'change') {
  try {
    if (!(await isEnabled())) return false;
    // 自動統計月預算護欄：達 WARN 後完全跳過，不計失敗
    if (reason !== 'manual') {
      try {
        const { getPushUsage } = require('./linebot');
        const { used, warn, max } = await getPushUsage();
        if (used >= warn) {
          console.log(`[stats_announce] skipped by push budget guard (${used}/${max}, warn=${warn}, reason=${reason})`);
          return false;
        }
      } catch (e) {}
    }
    const today = taipeiToday();
    if (reason === 'periodic') {
      if (!dayMultiple5(today)) return false;
      const last = await getOne("SELECT value FROM settings WHERE key = 'stats_announce_date'");
      if (last && last.value === today) return false;
    }
    const stats = await collectStats();
    // 內容去重：異動觸發時人數與上次成功公告完全相同就不重複推送
    if (reason === 'change') {
      const snapRow = await getOne("SELECT value FROM settings WHERE key = 'stats_last_snapshot'");
      if (snapRow && snapRow.value === JSON.stringify(stats)) return false;
    }
    const r = await pushToGroupDetail(formatStatsMessage(stats));
    if (!r.ok) {
      await recordFailure(r.error || 'unknown', await bumpFailCount());
      return false;
    }
    await setSetting('stats_announce_date', today);
    await setSetting('stats_last_ok_at', new Date().toISOString());
    await setSetting('stats_last_snapshot', JSON.stringify(stats));
    await runQuery("DELETE FROM settings WHERE key IN ('stats_fail_count','stats_last_error','stats_last_error_at')", []);
    console.log(`[stats_announce] 已公告報名進度（${reason}）`);
    return true;
  } catch (err) {
    console.error('[stats_announce] error:', err.message);
    try { await recordFailure(err.message, await bumpFailCount()); } catch (e) {}
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
  collectStats,
  sendStatsAnnounce,
  scheduleStatsAnnounce,
  startPeriodicStatsAnnounce
};
