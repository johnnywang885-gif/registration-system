const crypto = require('crypto');
const { getOne, runQuery, insert, getAll } = require('./database');
const { getSettings, taipeiToday } = require('./deadlines');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_GROUNDING = ['on', '1', 'true'].includes(String(process.env.GEMINI_GROUNDING || '').toLowerCase());
// NaN 守衛：環境變數非數字時退回預設 4800
const GROUNDING_MAX_MONTH = (() => {
  const v = parseInt(process.env.GEMINI_GROUNDING_MAX_MONTH, 10);
  return Number.isFinite(v) && v > 0 ? v : 4800;
})();
const LINE_API = 'https://api.line.me/v2/bot';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const SYSTEM_URL = process.env.SYSTEM_URL || 'https://registration-system-production-4e05.up.railway.app';

const FEEDBACK_KEYWORDS = ['意見', '建議', '回報', '改進', '壞掉', 'bug', '臭蟲'];

// 統一 fetch：逾時自動中止，避免無 timeout 的呼叫卡死
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Gemini 呼叫併發上限（群組訊息轟炸時避免放大 429）
const GEMINI_MAX_CONCURRENT = 2;
let geminiActive = 0;
const geminiWaiters = [];
async function withGeminiSlot(fn) {
  if (geminiActive >= GEMINI_MAX_CONCURRENT) {
    await new Promise(r => geminiWaiters.push(r));
  }
  geminiActive++;
  try {
    return await fn();
  } finally {
    geminiActive--;
    const next = geminiWaiters.shift();
    if (next) next();
  }
}

function verifySignature(rawBody, signature) {
  if (!CHANNEL_SECRET || !signature || !rawBody) return false;
  const digest = crypto.createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// LINE API 呼叫（含 429 重試一次：尊重 Retry-After）
async function lineRequest(path, payload) {
  const doCall = () => fetchWithTimeout(`${LINE_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify(payload)
  }, 15000);
  let res = await doCall();
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '1', 10);
    await new Promise(r => setTimeout(r, Math.min(isNaN(retryAfter) ? 1000 : retryAfter * 1000, 10000)));
    res = await doCall();
  }
  return res;
}

async function replyMessage(replyToken, text) {
  if (!CHANNEL_ACCESS_TOKEN || !replyToken) return false;
  try {
    const res = await lineRequest('/message/reply', { replyToken, messages: [{ type: 'text', text }] });
    if (!res.ok) console.error('LINE reply error:', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.error('LINE reply error:', err.message);
    return false;
  }
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
  try {
    const res = await lineRequest('/message/push', { to, messages: [{ type: 'text', text }] });
    if (!res.ok) console.error('LINE push error:', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.error('LINE push error:', err.message);
    return false;
  }
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
async function buildKnowledgeBase(extraEntries = []) {
  const s = await getSettings();
  const lines = [
    '你是「CULROC 區會報名系統」的 AI 助理，請用繁體中文簡潔回答使用者問題。',
    `目前設定：第一階段截止 ${s.phase1_deadline || '未設定'}、繳費截止 ${s.payment_deadline || '未設定'}、第二階段截止 ${s.phase2_deadline || '未設定'}、每社保障 ${s.guaranteed_quota || 10} 名、總名額 ${s.phase1_total_quota || 160} 人。`,
    '規則摘要：第一階段超過保障名額或滿 160 人列為候補；繳費截止前未上傳並獲核准之繳費證明者，已報名自動棄權（未繳費視同未報名）；未繳費社團的候補不會自動遞補；第二階段滿 160 人時自動轉候補，需管理員手動遞補。',
    `系統網址：${SYSTEM_URL}/ ；報名系統簡介：${SYSTEM_URL}/intro.html`
  ];
  if (extraEntries && extraEntries.length) {
    lines.push('===== 社務知識庫（管理員提供的資料，依相關度排序，可能包含與問題無關的條目）=====');
    lines.push(...extraEntries);
  }
  lines.push(
    '回答規則：',
    '1. 報名系統相關問題（報名、繳費、階段、遞補）請依上述系統規則與知識庫精準回答；',
    '2. 只能使用上述系統規則與知識庫中「明確出現」的資訊回答，不得猜測或編造；',
    '3. 知識庫沒有與問題相關的明確答案時，只回覆「無相關資料」四個字，不要嘗試自行回答；',
    '4. 絕對不要提供任何個人報名資料（姓名、身分證、手機、生日等）。'
  );
  return lines.join('\n');
}

async function buildWebSearchPrompt() {
  const s = await getSettings();
  return [
    '你是「CULROC 區會報名系統」的 AI 助理，請用繁體中文簡潔回答使用者問題。',
    `目前設定：第一階段截止 ${s.phase1_deadline || '未設定'}、繳費截止 ${s.payment_deadline || '未設定'}、第二階段截止 ${s.phase2_deadline || '未設定'}、每社保障 ${s.guaranteed_quota || 10} 名、總名額 ${s.phase1_total_quota || 160} 人。`,
    '規則摘要：第一階段超過保障名額或滿 160 人列為候補；繳費截止前未上傳並獲核准之繳費證明者，已報名自動棄權（未繳費視同未報名）；未繳費社團的候補不會自動遞補；第二階段滿 160 人時自動轉候補，需管理員手動遞補。',
    `系統網址：${SYSTEM_URL}/ ；報名系統簡介：${SYSTEM_URL}/intro.html`,
    '回答規則：',
    '1. 報名系統相關問題（報名、繳費、階段、遞補）請依上述系統規則精準回答，不要用網路資料取代；',
    '2. 非系統問題可用網路搜尋查證後回答；搜尋結果與問題無關或無法確定時，只回覆「無法回答」四個字，不要編造；',
    '3. 使用網路搜尋資訊回答時，回答結尾加一行「（資料來源：網路查詢）」；',
    '4. 絕對不要提供任何個人報名資料（姓名、身分證、手機、生日等）。'
  ].join('\n');
}

// ===== 知識庫檢索（關鍵字計分，取最相關 top-N 併入 prompt） =====
function knowledgeScore(text, query) {
  const q = String(query || '');
  const bigrams = [];
  for (let i = 0; i < q.length - 1; i++) {
    if (/[\u4e00-\u9fff]/.test(q[i]) && /[\u4e00-\u9fff]/.test(q[i + 1])) bigrams.push(q.slice(i, i + 2));
  }
  const ids = (q.match(/\d{4}/g) || []);
  const hasQuery = (hay) => /[A-Za-z0-9]/.test(hay);
  let score = 0;
  for (const b of bigrams) if (text.includes(b)) score++;
  for (const n of ids) if (text.includes(n)) score += 3;
  if (hasQuery(text) && hasQuery(q)) {
    for (const t of (q.match(/[A-Za-z0-9]{2,}/g) || [])) if (text.includes(t)) score += 2;
  }
  return score;
}

async function retrieveKnowledge(query, limit = 3, maxChars = 6000) {
  try {
    const rows = await getAll("SELECT id, title, content FROM knowledge WHERE active = 1");
    const scored = rows
      .map(r => ({ ...r, score: knowledgeScore((r.title || '') + '\n' + (r.content || ''), query) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const chunks = [];
    let total = 0;
    for (const r of scored) {
      const chunk = `【${r.title}】\n${r.content}`;
      if (total + chunk.length > maxChars) break;
      chunks.push(chunk);
      total += chunk.length;
    }
    return chunks;
  } catch (err) {
    console.error('retrieveKnowledge error:', err.message);
    return [];
  }
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

async function geminiRequest(system, userText, options = {}) {
  if (!GEMINI_API_KEY) return { text: null, usedGrounding: false, sources: [] };
  const { grounding = false, maxOutputTokens = 500, images = [] } = options;
  const groundingOn = grounding && (await canUseGrounding());
  const parts = [];
  if (userText) parts.push({ text: userText });
  for (const img of images) {
    if (img && img.data) {
      parts.push({ inline_data: { mime_type: img.mimeType || 'image/png', data: img.data } });
    }
  }
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.3, maxOutputTokens }
  };
  if (groundingOn) {
    payload.tools = [{ googleSearch: {} }];
  }

  const doRequest = async (p, retries = 3) => {
    for (let attempt = 0; attempt < retries; attempt++) {
      let res;
      try {
        res = await withGeminiSlot(() => fetchWithTimeout(`${GEMINI_API}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GEMINI_API_KEY },
          body: JSON.stringify(p)
        }, 60000));
      } catch (err) {
        // 網路錯誤／逾時：短退避重試
        if (attempt < retries - 1) {
          const waitSec = Math.min(5, 2 ** attempt);
          console.error('Gemini network error, retry in', waitSec, 's (attempt', attempt + 1, '/', retries, ')', err.message);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
        console.error('Gemini request error:', err.message);
        return { ok: false, status: -1, usedGrounding: false, sources: [] };
      }
      if (res.status === 429 || res.status >= 500) {
        let errBody = '';
        try { errBody = await res.text(); } catch (_) {}
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const retryMatch = errBody.match(/retry (?:in|after) ([\d.]+)s/i);
        let waitSec = retryAfter > 0 ? retryAfter : (retryMatch ? parseFloat(retryMatch[1]) : (attempt + 1) * 5);
        waitSec = Math.min(waitSec, 20); // 退避上限：LINE reply token 約 1 分鐘時效，不能無止盡等
        if (attempt < retries - 1) {
          console.error('Gemini', res.status, 'rate limit, retry in', waitSec, 's (attempt', attempt + 1, '/', retries, ')');
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
        console.error('Gemini', res.status, 'exhausted after', retries, 'retries');
        return { ok: false, status: res.status, usedGrounding: false, sources: [] };
      }
      if (!res.ok) {
        let errBody = '';
        try { errBody = await res.text(); } catch (_) {}
        console.error('Gemini API error:', res.status, errBody.slice(0, 500));
        return { ok: false, status: res.status, usedGrounding: false, sources: [] };
      }
      const data = await res.json();
      const cand = data.candidates && data.candidates[0];
      const text = cand && cand.content && cand.content.parts
        ? cand.content.parts.map(part => part.text || '').join('')
        : null;
      let usedGrounding = false;
      let sources = [];
      if (cand && cand.groundingMetadata) {
        usedGrounding = true;
        if (Array.isArray(cand.groundingMetadata.groundingChunks)) {
          sources = cand.groundingMetadata.groundingChunks
            .filter(c => c && c.web && c.web.uri)
            .map(c => ({ uri: c.web.uri, title: c.web.title || '' }));
        }
      }
      return { ok: true, text: text ? text.trim() : null, usedGrounding, sources };
    }
    return { ok: false, status: -1, usedGrounding: false, sources: [] };
  };

  if (groundingOn) {
    const first = await doRequest(payload, 2);
    if (first.ok) {
      // 只在「真的用了網路搜尋」時計費（groundingMetadata 出現才算），防止一般回答吃掉搜尋額度
      if (first.usedGrounding) await recordGroundingUse();
      return first;
    }
    console.error('Gemini grounding error:', first.status, '; retrying without grounding');
  }

  return doRequest({ ...payload, tools: undefined });
}

async function callGemini(system, userText, options = {}) {
  const result = await geminiRequest(system, userText, options);
  return result.text;
}

// ===== 三層問答流程：知識庫 → 網路搜尋（註明來源） → 忙線＋自動開單 =====
function normalizeMarker(text) {
  return String(text || '').replace(/[\s，。！？,.!?、；;:："'「」（）()【】]/g, '').trim();
}

function stage1Miss(text) {
  const t = normalizeMarker(text);
  return t.length < 40 && /無相關資料|沒有相關資料|找不到相關資料|暫無相關資料/.test(t);
}

function stage2Fail(text) {
  const t = normalizeMarker(text);
  return t.length < 40 && /無法回答|不能回答|無答案|未找到答案|沒有找到|無法提供/.test(t);
}

async function busyReplyText() {
  const s = await getSettings();
  const name = String(s.bot_name || '').trim();
  const base = '抱歉，因忙線中暫時無法回答。您的問題我已記錄，稍後回覆您，請見諒！';
  return name ? `${base}\n（${name}）` : base;
}

async function answerQuestion(userText) {
  try {
    // 第 1 層：知識庫（只帶知識庫、不開搜尋；未命中回固定標記「無相關資料」）
    const entries = await retrieveKnowledge(userText);
    const stage1System = await buildKnowledgeBase(entries);
    const stage1 = await geminiRequest(stage1System, userText, { maxOutputTokens: 800 });
    if (stage1.text && !stage1Miss(stage1.text)) {
      return { text: stage1.text, tier: 'kb' };
    }

    // 第 2 層：網路搜尋（知識庫未命中才觸發；結果附註「網路查詢」來源）
    const stage2System = await buildWebSearchPrompt();
    const stage2 = await geminiRequest(stage2System, userText, { grounding: true, maxOutputTokens: 800 });
    if (stage2.text && !stage2Fail(stage2.text)) {
      let text = stage2.text;
      if (stage2.usedGrounding) {
        const url = stage2.sources[0] && stage2.sources[0].uri;
        text += url ? `\n（資料來源：網路查詢：${url}）` : '\n（資料來源：網路查詢）';
      }
      return { text, tier: 'web' };
    }
  } catch (err) {
    console.error('answerQuestion error:', err.message);
  }

  // 第 3 層：忙線訊息（可帶 bot_name 分身署名）；任何異常也走這裡並開單，不讓事件死掉
  return { text: await busyReplyText(), tier: 'busy', unanswered: true };
}

async function askGemini(userText) {
  const result = await answerQuestion(userText);
  return result.text;
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

// ===== AI 公告產生（原始資料 → LINE 群組版／各社個別版；支援圖片判讀） =====
function parseClubAnnouncements(text, rawData, allowImageIds) {
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
  const items = [];
  const seenIds = new Set();
  for (const x of arr) {
    if (!x || !x.club_id || !x.message) continue;
    const cid = String(x.club_id);
    if (!(knownIds.has(cid) || (allowImageIds && /^\d{4}$/.test(cid)))) continue;
    if (seenIds.has(cid)) continue; // 同社去重，保留第一筆
    seenIds.add(cid);
    items.push({
      club_id: cid,
      club_name: String(x.club_name || ''),
      message: String(x.message).trim()
    });
  }
  return items.length ? items : null;
}

async function generateAnnouncement(rawData, instructions, mode, images) {
  const system =
    '你是區會行政助理，負責把管理員提供的原始資料整理成可直接複製貼上的 LINE 通知。' +
    '請用繁體中文、條列式、語氣親切簡潔，只能使用原始資料中出現的內容，不得自行增刪社團或事項。';
  const note = instructions && String(instructions).trim() ? `\n補充指示：${String(instructions).trim()}` : '';
  const imgNote = images && images.length
    ? `\n另外附上 ${images.length} 張原始資料圖片（如截圖/名冊/圖表）：請從圖片判讀社號、社名、日期與事項；文字資料與圖片並存時以圖片內容為準，社號以圖片中實際出現的為準。`
    : '';

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
      imgNote,
      note
    ].join('\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callGemini(system, prompt + (attempt > 0 ? '\n\n再次提醒：只輸出 JSON 陣列，不要加入任何其他說明文字。' : ''), { maxOutputTokens: 3000, images });
        if (!text) {
          console.error('generateAnnouncement[clubs] Gemini returned null, attempt:', attempt);
          if (attempt === 0) await new Promise(r => setTimeout(r, 10000));
          continue; // 429/失敗時等 10 秒後重試（不再提早 return null）
        }
        const items = parseClubAnnouncements(text, rawData, !!(images && images.length));
        if (items) return items;
      } catch (err) {
        console.error('generateAnnouncement[clubs] exception:', err.message);
        return null;
      }
    }
    return null;
  }

  const prompt = [
    '從以下資料（文字或圖片）提取所有社團，整理為LINE公告：',
    '1. 先列出「📢 【重要通知】」標題+事由；',
    '2. 條列每社「社號 社名」含事項或日期，備註併入該社行內；',
    '3. 結尾1-2行提醒語。',
    '',
    '⚠️ 重要：務必列「所有」社團，不可省略任何一社。',
    '',
    '資料：',
    String(rawData || ''),
    imgNote,
    note
  ].join('\n');
  try {
    const text = await callGemini(system, prompt, { maxOutputTokens: 4000, images });
    if (!text) {
      console.error('generateAnnouncement[group] Gemini returned null — images:', images.length, 'rawData length:', String(rawData).length);
      // 空結果補一次重試（隔 10 秒），避免單次 429/中斷直接回 null
      await new Promise(r => setTimeout(r, 10000));
      return await callGemini(system, prompt, { maxOutputTokens: 4000, images });
    }
    return text;
  } catch (err) {
    console.error('generateAnnouncement[group] exception:', err.message);
    return null;
  }
}

// ===== 來源名稱補抓（管理後台按鈕觸發，避免每則訊息呼叫 LINE API） =====
async function refreshSourceNames() {
  if (!CHANNEL_ACCESS_TOKEN) return 0;
  const sources = await getAll("SELECT source_type, source_id FROM line_sources");
  let updated = 0;
  for (const s of sources) {
    try {
      if (s.source_type === 'group') {
        const res = await fetchWithTimeout(`${LINE_API}/group/${encodeURIComponent(s.source_id)}/summary`, {
          headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
        }, 15000);
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
        const res = await fetchWithTimeout(`${LINE_API}/profile/${encodeURIComponent(s.source_id)}`, {
          headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
        }, 15000);
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
  // 群組來源：line_sources 的 group 列 ∪ 歷史群組訊息中出現過的 groupId（補回可能遺失的群組列）
  const row1 = await getAll("SELECT source_id FROM line_sources WHERE source_type = 'group'");
  const row2 = await getAll("SELECT DISTINCT source_id FROM line_messages WHERE source_type = 'group' AND source_id IS NOT NULL");
  const seen = new Map();
  row1.forEach(r => seen.set(r.source_id, true));
  for (const r of row2) {
    if (!seen.has(r.source_id)) {
      await runQuery(
        "INSERT OR IGNORE INTO line_sources (source_type, source_id) VALUES ('group', ?)",
        [r.source_id]
      ).catch(() => {});
      seen.set(r.source_id, true);
    }
  }
  const groups = [...seen.keys()].map(id => ({ source_id: id }));
  for (const g of groups) {
    const gInfo = { source_id: g.source_id, ok: false, status: null, apiMembers: 0, fallbackMembers: 0 };
    let paginationBroke = false;
    try {
      let start;
      const memberIds = [];
      do {
        const url = `${LINE_API}/group/${encodeURIComponent(g.source_id)}/members/ids` + (start ? `?start=${encodeURIComponent(start)}` : '');
        const res = await fetchWithTimeout(url, { headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` } }, 15000);
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
      // 分頁中途失敗（有 start 但迴圈被 break）代表名單不完整
      if (gInfo.status !== null) paginationBroke = true;

      gInfo.apiMembers = memberIds.length;
      gInfo.ok = memberIds.length > 0;
      for (const memberId of memberIds) {
        try {
          const pRes = await fetchWithTimeout(`${LINE_API}/profile/${encodeURIComponent(memberId)}`, {
            headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
          }, 15000);
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

      // 後備：members/ids 失敗或分頁中斷時，收錄該群組實際發過訊息的人（sender_id）補缺口
      if (!gInfo.ok || paginationBroke) {
        const senders = await getAll(
          "SELECT DISTINCT sender_id FROM line_messages WHERE source_type = 'group' AND source_id = ? AND sender_id IS NOT NULL",
          [g.source_id]
        );
        for (const s of senders) {
          try {
            const pRes = await fetchWithTimeout(`${LINE_API}/profile/${encodeURIComponent(s.sender_id)}`, {
              headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            }, 15000);
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

// ===== Webhook 送達診斷計數（settings 表，供後台一鍵查看 LINE 事件是否有送達） =====
async function recordWebhookDiag(status, events) {
  try {
    const now = new Date().toISOString();
    if (status === 'ping') {
      await runQuery(
        "INSERT INTO settings (key, value) VALUES ('webhook_pings', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
      );
    } else if (status === 'reject') {
      await runQuery(
        "INSERT INTO settings (key, value) VALUES ('webhook_rejected', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
      );
    } else if (status === 'events') {
      const srcs = Array.isArray(events) ? events
        .filter(e => e && e.source)
        .map(e => `${e.source.type || '?'}:${e.source[`${e.source.type}Id`] || e.source.userId || '?'}`)
        .join(',') : '';
      const types = Array.isArray(events) ? events.map(e => e.type || '?').join(',') : '';
      await runQuery(
        "INSERT INTO settings (key, value) VALUES ('webhook_events', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)",
        [Array.isArray(events) ? events.length : 0]
      );
      await runQuery(
        "INSERT INTO settings (key, value) VALUES ('webhook_last_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [now]
      );
      await runQuery(
        "INSERT INTO settings (key, value) VALUES ('webhook_last_types', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [types]
      );
      await runQuery(
        "INSERT INTO settings (key, value) VALUES ('webhook_last_sources', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [srcs]
      );
    }
  } catch (err) {
    console.error('recordWebhookDiag error:', err.message);
  }
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

  const answer = await answerQuestion(text);
  if (answer.unanswered) {
    await saveFeedback(null, 'LINE 群組', guessCategory(text), '【AI 未解答】' + text);
  }
  await replyMessage(event.replyToken, answer.text || '抱歉，因忙線中暫時無法回答。您的問題我已記錄，稍後回覆您，請見諒！');
}

module.exports = { verifySignature, handleLineEvent, pushToGroup, pushToUser, pushToLineUser, refreshSourceNames, syncGroupMembers, summarizeMessages, generateAnnouncement, getGroundingUsage, canUseGrounding, recordGroundingUse, recordWebhookDiag, answerQuestion, retrieveKnowledge };
