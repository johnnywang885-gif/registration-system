const crypto = require('crypto');
const { getOne, runQuery, insert, getAll } = require('./database');
const { getSettings } = require('./deadlines');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_GROUNDING = ['on', '1', 'true'].includes(String(process.env.GEMINI_GROUNDING || '').toLowerCase());
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

async function callGemini(system, userText, options = {}) {
  if (!GEMINI_API_KEY) return null;
  const { grounding = false, maxOutputTokens = 500 } = options;
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens }
  };
  if (grounding && GEMINI_GROUNDING) {
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

  if (grounding && GEMINI_GROUNDING) {
    const first = await doRequest(payload);
    if (first.ok) return first.text;
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
  if (FEEDBACK_KEYWORDS.some(k => lower.includes(k))) {
    const id = await saveFeedback(null, 'LINE 群組', guessCategory(text), text);
    await replyMessage(event.replyToken, `已收到您的意見（編號 #${id}），已記錄並轉交開發團隊處理，感謝您的回饋！`);
    return;
  }

  const answer = await askGemini(text);
  await replyMessage(event.replyToken, answer || 'AI 助理尚未設定完成，請直接聯絡督導或區會幹事。');
}

module.exports = { verifySignature, handleLineEvent, pushToGroup, pushToUser, pushToLineUser, refreshSourceNames, summarizeMessages };
