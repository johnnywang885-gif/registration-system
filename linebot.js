const crypto = require('crypto');
const { getOne, runQuery, insert, getAll } = require('./database');
const { getSettings, taipeiToday } = require('./deadlines');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_GROUNDING = ['on', '1', 'true'].includes(String(process.env.GEMINI_GROUNDING || '').toLowerCase());
const GROUNDING_MAX_MONTH = parseInt(process.env.GEMINI_GROUNDING_MAX_MONTH || '4800', 10);
const LINE_API = 'https://api.line.me/v2/bot';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const SYSTEM_URL = process.env.SYSTEM_URL || 'https://registration-system-production-4e05.up.railway.app';

const FEEDBACK_KEYWORDS = ['意見', '建議', '回報', '改進', '壞掉', '希望', 'bug', '臭蟲'];

function verifySignature(rawBody, signature) {
  if (!CHANNEL_SECRET || !signature || !rawBody) return false;
  const digest = crypto.createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function replyMessage(replyToken, text) {
  if (!CHANNEL_ACCESS_TOKEN || !replyToken) return false;
  const res = await fetch(`${LINE_API}/message/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  if (!res.ok) console.error('LINE reply error:', res.status, await res.text().catch(() => ''));
  return res.ok;
}

async function pushToGroup(text) {
  if (!CHANNEL_ACCESS_TOKEN) return false;
  const row = await getOne("SELECT value FROM settings WHERE key = 'line_group_id'");
  const groupId = row && row.value;
  if (!groupId) return false;
  return pushToLineUser(groupId, text);
}

async function pushToUser(userId, text) {
  if (!CHANNEL_ACCESS_TOKEN || !userId) return false;
  return pushToLineUser(userId, text);
}

async function pushToLineUser(to, text) {
  if (!CHANNEL_ACCESS_TOKEN || !to) return false;
  const res = await fetch(`${LINE_API}/message/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] })
  });
  if (!res.ok) console.error('LINE push error:', res.status, await res.text().catch(() => ''));
  return res.ok;
}

// ===== 對話紀錄收集 =====
async function recordLineSource(event) {
  if (!event.source) return;
  const sourceType = event.source.type === 'group' ? 'group' : 'user';
  const sourceId = sourceType === 'group' ? event.source.groupId : event.source.userId;
  if (!sourceId) return;
  await runQuery(
    `INSERT INTO line_sources (source_type, source_id, last_message_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(source_type, source_id) DO UPDATE SET last_message_at = datetime('now')`,
    [sourceType, sourceId]
  ).catch(err => console.error('recordLineSource error:', err.message));
}

async function recordLineMessage(event) {
  if (!event.source) return;
  const sourceType = event.source.type === 'group' ? 'group' : 'user';
  const sourceId = sourceType === 'group' ? event.source.groupId : event.source.userId;
  if (!sourceId || !event.message || event.message.type !== 'text' || !event.message.text) return;
  await insert(
    "INSERT INTO line_messages (source_type, source_id, sender_id, message) VALUES (?, ?, ?, ?)",
    [sourceType, sourceId, event.source.userId || null, event.message.text]
  ).catch(err => console.error('recordLineMessage error:', err.message));
}

// ===== Gemini =====
async function buildKnowledgeBase() {
  const s = await getSettings();
  return [
    '你是「CULROC 區會報名系統」的 AI 助理，請用繁體中文簡潔回答使用者問題。',
    '報名系統相關問題請優先依下列系統規則與操作說明精準回答；系統外的問題（一般知識、時事、生活等）也可以正常回答。',
    '絕對不要提供任何個人報名資料（姓名、身分證、手機、生日等）。',
    `目前設定：第一階段截止 ${s.phase1_deadline || '未設定'}、繳費截止 ${s.payment_deadline || '未設定'}、第二階段截止 ${s.phase2_deadline || '未設定'}、每社保障 ${s.guaranteed_quota || 10} 名、總名額 ${s.phase1_total_quota || 160} 人。`,
    '規則摘要：第一階段超過保障名額或滿 160 人列為候補；繳費截止前未上傳並獲核准之繳費證明者，已報名自動棄權（未繳費視同未報名）；未繳費社團的候補不會自動遞補；第二階段滿 160 人時自動轉候補，需管理員手動遞補。',
    `系統網址：${SYSTEM_URL}/ ；報名系統簡介：${SYSTEM_URL}/intro.html`,
    '若使用者表達的是對系統的意見、建議或錯誤回報（而非操作疑問），開頭回覆「已收到您的意見」並簡短確認即可。'
  ].join('\n');
}

// ===== Gemini 網路搜尋用量上限（每月計數，防觸動付費） =====
function groundingMonthKey() {
  return 'grounding_' + taipeiToday().slice(0, 7);
}

async function getGroundingUsage() {
  const key = groundingMonthKey();
  const row = await getOne("SELECT value FROM settings WHERE key = ?", [key]);
  const used = parseInt((row && row.value) || '0', 10) || 0;
  return { key, used, max: GROUNDING_MAX_MONTH };
}

async function canUseGrounding() {
  if (!GEMINI_GROUNDING) return false;
  try {
    const { used, max } = await getGroundingUsage();
    return used < max;
  } catch (err) {
    console.error('canUseGrounding error:', err.message);
    return false;
  }
}

async function recordGroundingUse() {
  try {
    const { key, used } = await getGroundingUsage();
    await runQuery(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      [key, String(used + 1), String(used + 1)]
    );
  } catch (err) {
    console.error('recordGroundingUse error:', err.message);
  }
}

async function callGemini(system, userText, options = {}) {
  if (!GEMINI_API_KEY) return null;
  const { grounding = false, maxOutputTokens = 500 } = options;
  const groundingOn = grounding && (await canUseGrounding());
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens }
  };
  if (groundingOn) {
    payload.tools = [{ googleSearch: {} }];
  }

  const doRequest = async (p) => {
    try {
      const res = await fetch(`${GEMINI_API}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p)
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
        ? data.candidates[0].content.parts.map(part => part.text || '').join('')
        : null;
      return { ok: true, text: text ? text.trim() : null };
    } catch (err) {
      console.error('Gemini request error:', err.message);
      return { ok: false, status: -1 };
    }
  };

  if (groundingOn) {
    const first = await doRequest(payload);
    if (first.ok) {
      await recordGroundingUse();
      return first.text;
    }
    console.error('Gemini grounding error:', first.status, '; retrying without grounding');
  }

  const second = await doRequest({ ...payload, tools: undefined });
  return second.ok ? second.text : null;
}

async function askGemini(userText) {
  const system = await buildKnowledgeBase();
  return callGemini(system, userText, { grounding: true });
}

async function summarizeMessages(rows, kind) {
  const lines = rows.map(r => {
    const t = r.created_at || '';
    const sender = r.sender_id || '不明';
    return `[${t}] ${sender}: ${r.message}`;
  });
  const header = kind === 'questions'
    ? '請把以下對話整理成「待確認疑問清單」，逐條列出尚未解決或需要相關單位回覆的問題，並附上簡短背景。'
    : '請把以下對話整理成重點摘要，條列呈現（每條一行），包含主題、結論與待辦事項。';
  const system = '你是對話整理助理，請用繁體中文、條列式、精簡輸出，不要編造對話中沒有出現的內容。';
  return callGemini(system, `${header}\n\n對話紀錄（依時間順序）：\n${lines.join('\n')}`, { maxOutputTokens: 1200 });
}

// ===== AI 公告產生（原始資料 → LINE 群組版／各社個別版） =====
function parseClubAnnouncements(text, rawData) {
  const match = String(text).match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) return null;
  let arr;
  try {
    arr = JSON.parse(match[0]);
  } catch (err) {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const knownIds = new Set(String(rawData).match(/\b\d{4}\b/g) || []);
  const items = arr
    .filter(x => x && x.club_id && knownIds.has(String(x.club_id)) && x.message)
    .map(x => ({
      club_id: String(x.club_id),
      club_name: String(x.club_name || ''),
      message: String(x.message).trim()
    }));
  return items.length ? items : null;
}

async function generateAnnouncement(rawData, instructions, mode) {
  const system =
    '你是區會行政助理，負責把管理員提供的原始資料整理成可直接複製貼上的 LINE 通知。' +
    '請用繁體中文、條列式、語氣親切簡潔，只能使用原始資料中出現的內容，不得自行增刪社團或事項。';
  const note = instructions && String(instructions).trim() ? `\n補充指示：${String(instructions).trim()}` : '';

  if (mode === 'clubs') {
    const prompt = [
      '請依照以下原始資料，為每一家社團各整理一封「只包含該社自己相關事項」的 LINE 通知：',
      '1. 每封信第一行寫「社號 社名」，例如「2408 羅娜」；',
      '2. 內容只描述該社的待辦事項與繳費/補件情況，不要提到其他社的資訊；',
      '3. 原始資料中對該社的特別備註（如缺名冊紙本）必須寫進去；',
      '4. 只輸出 JSON 陣列，格式：[{"club_id":"2408","club_name":"羅娜","message":"..."}]',
      '5. 社號只能使用原始資料中出現的數字，不可自行增刪。',
      '',
      '原始資料：',
      String(rawData || ''),
      note
    ].join('\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await callGemini(system, prompt + (attempt > 0 ? '\n\n再次提醒：只輸出 JSON 陣列，不要加入任何其他說明文字。' : ''), { maxOutputTokens: 3000 });
      if (!text) return null;
      const items = parseClubAnnouncements(text, rawData);
      if (items) return items;
    }
    return null;
  }

  const prompt = [
    '請將以下原始資料整理成「LINE 群組公告簡訊版」，可直接複製貼到 LINE 群組：',
    '1. 以「📢 【重要通知】」開頭，標題說明事由；',
    '2. 條列列出各社社號/社名及相關事項/日期（例如「2408 羅娜（名冊已交 7/28）」）；',
    '3. 若資料中有某社的特別備註（如缺名冊紙本），在名單後以「特別注意」欄位單獨提醒；',
    '4. 結尾附上 1-2 行溫馨提醒與聯絡說明；',
    '5. 純文字、繁體中文、不分頁籤符號，標點符號清晰。',
    '',
    '原始資料：',
    String(rawData || ''),
    note
  ].join('\n');
  return callGemini(system, prompt, { maxOutputTokens: 1500 });
}

// ===== 來源名稱補抓（管理後台按鈕觸發，避免每則訊息呼叫 LINE API） =====
async function refreshSourceNames() {
  if (!CHANNEL_ACCESS_TOKEN) return 0;
  const sources = await getAll("SELECT source_type, source_id FROM line_sources");
  let updated = 0;
  for (const s of sources) {
    try {
      if (s.source_type === 'group') {
        const res = await fetch(`${LINE_API}/group/${encodeURIComponent(s.source_id)}/summary`, {
          headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
        });
        if (res.ok) {
          const data = await res.json();
          await runQuery(
            "UPDATE line_sources SET source_name = ?, member_count = ? WHERE source_type = 'group' AND source_id = ?",
            [data.groupName || null, data.memberCount || null, s.source_id]
          );
          updated++;
        } else {
          console.error('Group summary error:', res.status, s.source_id);
        }
      } else {
        const res = await fetch(`${LINE_API}/profile/${encodeURIComponent(s.source_id)}`, {
          headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
        });
        if (res.ok) {
          const data = await res.json();
          await runQuery(
            "UPDATE line_sources SET source_name = ? WHERE source_type = 'user' AND source_id = ?",
            [data.displayName || null, s.source_id]
          );
          updated++;
        } else {
          console.error('Profile error:', res.status, s.source_id);
        }
      }
    } catch (err) {
      console.error('refreshSourceNames error:', err.message);
    }
  }
  return updated;
}

// ===== 群組成員名單同步（把群組內所有成員拉進 line_sources，名稱含社號即可被 AI 公告比對） =====
async function syncGroupMembers() {
  const report = { enrolled: 0, failed: 0, groups: [], samples: [] };
  if (!CHANNEL_ACCESS_TOKEN) return report;
  const groups = await getAll("SELECT source_id FROM line_sources WHERE source_type = 'group'");
  for (const g of groups) {
    const gInfo = { source_id: g.source_id, ok: false, status: null, apiMembers: 0, fallbackMembers: 0 };
    try {
      let start;
      const memberIds = [];
      do {
        const url = `${LINE_API}/group/${encodeURIComponent(g.source_id)}/members/ids` + (start ? `?start=${encodeURIComponent(start)}` : '');
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` } });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error('Group members error:', res.status, g.source_id, body.slice(0, 200));
          gInfo.status = res.status;
          start = null;
          break;
        }
        const data = await res.json();
        (data.memberIds || []).forEach(id => memberIds.push(id));
        start = data.next || null;
      } while (start);

      gInfo.apiMembers = memberIds.length;
      gInfo.ok = memberIds.length > 0;
      for (const memberId of memberIds) {
        try {
          const pRes = await fetch(`${LINE_API}/profile/${encodeURIComponent(memberId)}`, {
            headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
          });
          if (!pRes.ok) { report.failed++; continue; }
          const pData = await pRes.json();
          await runQuery(
            `INSERT INTO line_sources (source_type, source_id, source_name)
             VALUES ('user', ?, ?)
             ON CONFLICT(source_type, source_id) DO UPDATE SET source_name = excluded.source_name`,
            [memberId, pData.displayName || null]
          );
          report.enrolled++;
          if (report.samples.length < 5) report.samples.push(String(pData.displayName || memberId));
        } catch (err) {
          console.error('syncGroupMembers profile error:', err.message, memberId);
          report.failed++;
        }
      }

      // 後備：members/ids 失敗時，至少收錄該群組實際發過訊息的人（sender_id）
      if (!gInfo.ok) {
        const senders = await getAll(
          "SELECT DISTINCT sender_id FROM line_messages WHERE source_type = 'group' AND source_id = ? AND sender_id IS NOT NULL",
          [g.source_id]
        );
        for (const s of senders) {
          try {
            const pRes = await fetch(`${LINE_API}/profile/${encodeURIComponent(s.sender_id)}`, {
              headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });
            if (!pRes.ok) continue;
            const pData = await pRes.json();
            await runQuery(
              `INSERT INTO line_sources (source_type, source_id, source_name)
               VALUES ('user', ?, ?)
               ON CONFLICT(source_type, source_id) DO UPDATE SET source_name = excluded.source_name`,
              [s.sender_id, pData.displayName || null]
            );
            report.enrolled++;
            gInfo.fallbackMembers++;
            if (report.samples.length < 5) report.samples.push(String(pData.displayName || s.sender_id));
          } catch (err) {
            console.error('syncGroupMembers fallback profile error:', err.message, s.sender_id);
          }
        }
      }
    } catch (err) {
      console.error('syncGroupMembers error:', err.message);
      gInfo.status = -1;
    }
    report.groups.push(gInfo);
  }
  return report;
}

function guessCategory(text) {
  if (['壞掉', 'bug', '臭蟲', '錯誤'].some(k => text.includes(k))) return '錯誤回報';
  if (['建議', '希望', '改進', '功能'].some(k => text.includes(k))) return '功能建議';
  if (['操作', '怎麼', '如何', '不會', '登入', '報名'].some(k => text.includes(k))) return '操作問題';
  return '其他';
}

async function saveFeedback(clubId, displayName, category, message) {
  const id = await insert(
    "INSERT INTO feedback (club_id, display_name, category, message, status) VALUES (?, ?, ?, ?, 'open')",
    [clubId || null, displayName || null, category, message]
  );
  return id;
}

async function handleLineEvent(event) {
  if (event.source) {
    await recordLineSource(event);
    // 群組事件（join 或群組訊息）寫入主群組 ID，供群組推播使用
    if (event.source.type === 'group' && event.source.groupId) {
      await runQuery(
        "INSERT INTO settings (key, value) VALUES ('line_group_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [String(event.source.groupId)]
      ).catch(err => console.error('save line_group_id error:', err.message));
    }
  }

  if (event.type === 'join' && event.source && event.source.groupId) {
    console.log('LINE bot joined group:', event.source.groupId);
    await replyMessage(event.replyToken, '您好，我是區會報名系統的 AI 助理。操作問題可以直接問我；輸入「意見 內容」可回報問題或建議，我會記錄並轉交開發團隊。');
    return;
  }

  if (event.type !== 'message' || event.message.type !== 'text' || !event.replyToken) return;

  await recordLineMessage(event);

  const text = (event.message.text || '').trim();
  if (!text) return;

  const lower = text.toLowerCase();

  // AI 公告草稿產生：僅限區會主群組，只回覆草稿、不自動推播
  if (lower.startsWith('公告：') || lower.startsWith('公告:')) {
    const groupRow = await getOne("SELECT value FROM settings WHERE key = 'line_group_id'");
    const mainGroupId = groupRow && groupRow.value;
    const isMainGroup = event.source && event.source.type === 'group' && String(event.source.groupId) === String(mainGroupId);
    if (!isMainGroup) {
      await replyMessage(event.replyToken, '公告產生功能僅限區會主群組使用。');
      return;
    }
    const idx = text.search(/[：:]/);
    const raw = text.slice(idx + 1).trim();
    if (raw.length < 10) {
      await replyMessage(event.replyToken, '請在「公告：」後附上原始資料，例如：公告：2408 羅娜 115/7/28，2419 久美（缺名冊紙本），請轉知各社盡速繳費');
      return;
    }
    await replyMessage(event.replyToken, '收到，正在產生公告草稿，請稍候...');
    const draft = await generateAnnouncement(raw, '', 'group');
    if (!draft) {
      await replyMessage(event.replyToken, '公告草稿產生失敗（AI 尚未設定或資料無法辨識），請至管理後台「AI 公告」操作。');
      return;
    }
    await replyMessage(event.replyToken, `📢 群組公告草稿（此為草稿，正式推播請至管理後台「AI 公告」確認後再送）：\n\n${draft}`.slice(0, 4800));
    return;
  }

  if (FEEDBACK_KEYWORDS.some(k => lower.includes(k))) {
    const id = await saveFeedback(null, 'LINE 群組', guessCategory(text), text);
    await replyMessage(event.replyToken, `已收到您的意見（編號 #${id}），已記錄並轉交開發團隊處理，感謝您的回饋！`);
    return;
  }

  const answer = await askGemini(text);
  await replyMessage(event.replyToken, answer || 'AI 助理尚未設定完成，請直接聯絡督導或區會幹事。');
}

module.exports = { verifySignature, handleLineEvent, pushToGroup, pushToUser, pushToLineUser, refreshSourceNames, syncGroupMembers, summarizeMessages, generateAnnouncement, getGroundingUsage, canUseGrounding, recordGroundingUse };
