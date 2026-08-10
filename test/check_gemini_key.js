const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

if (!GEMINI_API_KEY) {
  console.error('請先設定 GEMINI_API_KEY 環境變數');
  console.error('用法：$env:GEMINI_API_KEY="..." ; node test/check_gemini_key.js');
  process.exitCode = 1;
  return;
}

const API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function call(tools) {
  const payload = {
    contents: [{ role: 'user', parts: [{ text: '用一句話回答：1+1=?' }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 100 }
  };
  if (tools) payload.tools = [{ googleSearch: {} }];
  const res = await fetch(`${API}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  const text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
    ? data.candidates[0].content.parts.map(p => p.text || '').join('')
    : '').trim();
  const grounded = !!(data.candidates && data.candidates[0] && data.candidates[0].groundingMetadata);
  return { ok: res.ok, status: res.status, text, grounded, error: (data.error && data.error.message) || '' };
}

(async () => {
  console.log(`模型：${GEMINI_MODEL}`);
  console.log('--- 1) 一般問答 ---');
  const plain = await call(null);
  console.log(`  ${plain.ok ? 'OK' : 'FAIL'} status=${plain.status} 回覆=${plain.text.slice(0, 60) || '(無)'} ${plain.error}`);
  console.log('--- 2) 網路搜尋（Grounding with Google Search）---');
  const search = await call(true);
  console.log(`  ${search.ok ? 'OK' : 'FAIL'} status=${search.status} grounded=${search.grounded} 回覆=${search.text.slice(0, 60) || '(無)'} ${search.error}`);
  console.log('');
  if (!plain.ok) {
    console.log('結論：key 完全無法使用（檢查 key 是否有效、是否已被限制）');
    process.exitCode = 1;
    return;
  }
  if (search.ok) {
    console.log(`結論：搜尋可用（付費 key）${search.grounded ? '，回應含 grounding metadata' : ''}。可於 Railway 設定 GEMINI_GROUNDING=on 啟用。`);
  } else {
    console.log('結論：一般問答可用，但搜尋不可用（free tier 或該模型不支援）→ 搜尋需付費 key。');
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
