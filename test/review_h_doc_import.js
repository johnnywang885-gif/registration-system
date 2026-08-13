const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'review_h.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.TURSO_DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.TURSO_AUTH_TOKEN = '';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '34898';

const BASE = 'http://127.0.0.1:34898';

async function waitDbReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/summary`);
      if (res.ok) return;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server / DB not ready in time');
}

function buildMinimalPdf(text) {
  const objs = [];
  objs[1] = '<</Type/Catalog/Pages 2 0 R>>';
  objs[2] = '<</Type/Pages/Kids[3 0 R]/Count 1>>';
  objs[3] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>';
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objs[4] = `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}\nendstream`;
  objs[5] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(body);
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body, 'utf8');
}

async function uploadFiles(files, auth) {
  const fd = new FormData();
  for (const f of files) {
    fd.append('files', new Blob([f.buffer], { type: f.mime }), f.name);
  }
  const res = await fetch(`${BASE}/api/admin/knowledge/upload`, {
    method: 'POST',
    headers: auth,
    body: fd
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  require('../server');
  await waitDbReady();

  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clubId: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();
  if (!token) throw new Error('admin login failed');
  const auth = { 'Authorization': `Bearer ${token}` };
  const getList = async () => (await (await fetch(`${BASE}/api/admin/knowledge`, { headers: auth })).json());

  // 1. Excel（xlsx lib 生成，多工作表）
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['社號', '社名', '社費'],
    ['2408', '羅娜', '5000'],
    ['2419', '久美', '5000']
  ]), '社費');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['事項', '期限'], ['繳交名冊紙本', '115/8/20']]), '名冊');
  const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  let r = await uploadFiles([{ name: '社務資料.xlsx', buffer: xlsxBuf, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }], auth);
  console.log('--- Excel 上傳 ---');
  console.log('  status=' + r.status + ' total=' + r.data.total + ' failed=' + r.data.failed);
  console.log('  message=' + r.data.message);
  if (r.status !== 200 || r.data.total < 2 || r.data.failed !== 0) throw new Error('xlsx upload should insert 2 entries');
  let list = await getList();
  const xlsxRow = list.find(x => x.title === '社務資料（社費）');
  if (!xlsxRow || !xlsxRow.content.includes('2408') || !xlsxRow.content.includes('羅娜')) throw new Error('xlsx sheet 社費 entry missing cell text');
  const xlsxRow2 = list.find(x => x.title === '社務資料（名冊）');
  if (!xlsxRow2 || !xlsxRow2.content.includes('115/8/20')) throw new Error('xlsx sheet 名冊 entry missing');

  // 2. TXT
  r = await uploadFiles([{ name: '繳費說明.txt', buffer: Buffer.from('各社請於繳費截止日前完成匯款並上傳繳費證明。', 'utf8'), mime: 'text/plain' }], auth);
  console.log('--- TXT 上傳 ---');
  console.log('  status=' + r.status + ' total=' + r.data.total);
  if (r.status !== 200 || r.data.total !== 1) throw new Error('txt upload should insert 1 entry');

  // 3. DOCX（docx 包生成）
  const { Document, Packer, Paragraph, TextRun } = require('docx');
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('名冊繳交規定測試：各社需於 115/8/20 前繳交紙本名冊。')] })] }] });
  const docxBuf = await Packer.toBuffer(doc);
  r = await uploadFiles([{ name: '名冊規定.docx', buffer: docxBuf, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }], auth);
  console.log('--- DOCX 上傳 ---');
  console.log('  status=' + r.status + ' total=' + r.data.total);
  if (r.status !== 200 || r.data.total !== 1) throw new Error('docx upload should insert 1 entry');
  list = await getList();
  const docxRow = list.find(x => x.title === '名冊規定');
  if (!docxRow || !docxRow.content.includes('115/8/20')) throw new Error('docx entry missing text');

  // 4. PDF（手刻最小 PDF）
  r = await uploadFiles([{ name: '行事曆.pdf', buffer: buildMinimalPdf('PDF text test OK'), mime: 'application/pdf' }], auth);
  console.log('--- PDF 上傳 ---');
  console.log('  status=' + r.status + ' total=' + r.data.total);
  if (r.status !== 200 || r.data.total !== 1) throw new Error('pdf upload should insert 1 entry');
  list = await getList();
  const pdfRow = list.find(x => x.title === '行事曆');
  if (!pdfRow || !pdfRow.content.includes('PDF text test')) throw new Error('pdf entry missing text');

  // 5. 不支援格式 .doc → 失敗細節；空白 txt → 判讀失敗
  r = await uploadFiles([{ name: '舊版.doc', buffer: Buffer.from('xxx'), mime: 'application/msword' }], auth);
  console.log('--- 不支援格式 ---');
  console.log('  status=' + r.status + ' total=' + r.data.total + ' failed=' + r.data.failed + ' message=' + r.data.message);
  if (r.status !== 200 || r.data.total !== 0 || !r.data.message.includes('不支援')) throw new Error('unsupported format should fail with message');
  r = await uploadFiles([{ name: '空白.txt', buffer: Buffer.from('   \n\n ', 'utf8'), mime: 'text/plain' }], auth);
  console.log('--- 空白檔 ---');
  console.log('  status=' + r.status + ' failed=' + r.data.failed + ' message=' + r.data.message);
  if (r.status !== 200 || r.data.total !== 0 || !r.data.message.includes('判讀')) throw new Error('empty file should fail with 判讀 message');

  // 6. 大檔分段（>2500 字 → 多筆「段落 n」）
  const longText = '段落測試內容。'.repeat(600);
  r = await uploadFiles([{ name: '長文件.txt', buffer: Buffer.from(longText, 'utf8'), mime: 'text/plain' }], auth);
  console.log('--- 大檔分段 ---');
  console.log('  total=' + r.data.total + '（預期 ≥2 段）');
  if (r.data.total < 2) throw new Error('long file should be split into multiple entries');
  list = await getList();
  const seg = list.filter(x => x.title.startsWith('長文件'));
  if (!seg.some(x => /段落 1\/\d+/.test(x.title))) throw new Error('segment title missing 段落 n/m');

  // 7. 備份含全部知識列
  const backup = await (await fetch(`${BASE}/api/admin/backup`, { headers: auth })).json();
  console.log('--- 備份 ---');
  console.log('  knowledge 筆數=' + (backup.knowledge || []).length);
  if (!backup.knowledge || backup.knowledge.length < 6) throw new Error('backup must include uploaded knowledge rows');

  // 8. 知識庫檢索能吃上傳的文字（Excel 社費內容）
  const { retrieveKnowledge } = require('../linebot');
  const hits = await retrieveKnowledge('羅娜的社費是多少');
  console.log('--- 檢索上傳內容 ---');
  hits.forEach(h => console.log('  ' + h.split('\n')[0]));
  if (!hits.some(h => h.includes('社務資料'))) throw new Error('retrieveKnowledge should find xlsx-imported content');

  console.log('\n全部階段 PASS');
  setTimeout(() => process.exit(0), 150);
}

main().catch(err => { console.error(err); process.exit(1); });