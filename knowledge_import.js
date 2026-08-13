const path = require('path');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');

const MAX_TOTAL_CHARS = 60000;
const SEGMENT_CHARS = 2500;

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

// busboy 常把 UTF-8 檔名誤解為 Latin-1（中文檔名變 mojibake）；重新編碼若還原成合法 UTF-8 就採用
function fixFilename(name) {
  const buf = Buffer.from(String(name), 'latin1');
  const decoded = buf.toString('utf8');
  if (!decoded.includes('\uFFFD')) return decoded;
  return String(name);
}

function baseTitleOf(filename) {
  return path.basename(String(filename || '')).replace(/\.[^.]+$/, '');
}

// 大檔分段：超過 segChars 切成多筆（標題帶段落編號），檢索取中段落
function splitEntry(title, content, segChars = SEGMENT_CHARS) {
  if (content.length <= segChars) return [{ title, content }];
  const parts = [];
  let rest = content;
  while (rest.length > segChars) {
    let cut = rest.lastIndexOf('\n', segChars);
    if (cut < segChars * 0.5) cut = segChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.map((p, i) => ({ title: `${title}（段落 ${i + 1}/${parts.length}）`, content: p }));
}

async function extractEntriesFromFile(filename, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('檔案內容為空');
  const baseTitle = baseTitleOf(filename);
  const ext = extOf(filename);

  if (ext === 'xlsx' || ext === 'xls') {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const entries = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      const lines = rows
        .map(row => (Array.isArray(row) ? row.map(c => String(c == null ? '' : c).trim()).filter(Boolean).join('，') : '').trim())
        .filter(Boolean);
      const content = normalizeText(lines.join('\n'));
      if (content) entries.push({ title: `${baseTitle}（${name}）`, content });
    }
    if (!entries.length) throw new Error('無法從 Excel 判讀出文字（可能為空白工作表）');
    return entries;
  }

  let text = '';
  if (ext === 'txt') {
    text = buffer.toString('utf8');
  } else if (ext === 'pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      text = result.text || '';
    } finally {
      await parser.destroy().catch(() => {});
    }
  } else if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value || '';
  } else {
    throw new Error('不支援的檔案格式（僅支援 .pdf / .docx / .xlsx / .xls / .txt）');
  }

  text = normalizeText(text);
  if (!text) throw new Error('無法從檔案中判讀出文字（掃描 PDF 或圖片內容不支援，請改用可選字的檔案或直接貼文）');
  if (text.length > MAX_TOTAL_CHARS) text = text.slice(0, MAX_TOTAL_CHARS);
  return [{ title: baseTitle, content: text }];
}

async function parseUploadedFile(filename, buffer) {
  const entries = await extractEntriesFromFile(filename, buffer);
  const out = [];
  for (const e of entries) out.push(...splitEntry(e.title, e.content));
  return out;
}

module.exports = { parseUploadedFile, extractEntriesFromFile, splitEntry, extOf, fixFilename, normalizeText };