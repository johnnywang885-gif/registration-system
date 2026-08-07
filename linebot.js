const crypto = require('crypto');
const { getOne, runQuery, insert } = require('./database');
const { getSettings } = require('./deadlines');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LINE_API = 'https://api.line.me/v2/bot';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
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
  const res = await fetch(`${LINE_API}/message/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text }] })
  });
  if (!res.ok) console.error('LINE push error:', res.status, await res.text().catch(() => ''));
  return res.ok;
}

async function buildKnowledgeBase() {
  const s = await getSettings();
  return [
    '你是「CULROC 區會報名系統」的 AI 助理，請用繁體中文簡潔回答使用者關於報名系統的問題。',
    '回答僅限系統規則與操作說明；絕對不要提供任何個人報名資料（姓名、身分證、手機、生日等）。',
    `目前設定：第一階段截止 ${s.phase1_deadline || '未設定'}、繳費截止 ${s.payment_deadline || '未設定'}、第二階段截止 ${s.phase2_deadline || '未設定'}、每社保障 ${s.guaranteed_quota || 10} 名、總名額 ${s.phase1_total_quota || 160} 人。`,
    '規則摘要：第一階段超過保障名額或滿 160 人列為候補；繳費截止前未上傳並獲核准之繳費證明者，已報名自動棄權（未繳費視同未報名）；未繳費社團的候補不會自動遞補；第二階段滿 160 人時自動轉候補，需管理員手動遞補。',
    `系統網址：${SYSTEM_URL}/ ；報名系統簡介：${SYSTEM_URL}/intro.html`,
    '若使用者表達的是對系統的意見、建議或錯誤回報（而非操作疑問），開頭回覆「已收到您的意見」並簡短確認即可。'
  ].join('\n');
}

async function askGemini(userText) {
  if (!GEMINI_API_KEY) return null;
  const system = await buildKnowledgeBase();
  const res = await fetch(`${GEMINI_API}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 500 }
    })
  });
  if (!res.ok) {
    console.error('Gemini error:', res.status);
    return null;
  }
  const data = await res.json();
  const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
    ? data.candidates[0].content.parts.map(p => p.text || '').join('')
    : null;
  return text ? text.trim() : null;
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
  if (event.type === 'join' && event.source && event.source.groupId) {
    await runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES ('line_group_id', ?)", [event.source.groupId]);
    console.log('LINE bot joined group:', event.source.groupId);
    await replyMessage(event.replyToken, '您好，我是區會報名系統的 AI 助理。操作問題可以直接問我；輸入「意見 內容」可回報問題或建議，我會記錄並轉交開發團隊。');
    return;
  }

  if (event.type !== 'message' || event.message.type !== 'text' || !event.replyToken) return;

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

module.exports = { verifySignature, handleLineEvent, pushToGroup };
