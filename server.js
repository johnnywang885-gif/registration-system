require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const { initDatabase, getAll, getOne, runQuery, insert, importClubs, saveDatabase } = require('./database');
const { generateToken, authMiddleware, adminMiddleware } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'payments');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `payment_${req.user.clubId}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支援的檔案格式，僅支援 JPG/PNG/GIF/PDF'));
    }
  }
});

function startServer() {
  const uploadsDir = path.join(__dirname, 'uploads', 'payments');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  // ===== Health Check =====
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // ===== Public Routes =====
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
  });

  app.get('/payment', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'payment.html'));
  });

  app.get('/summary', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'summary.html'));
  });

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });

  // ===== Auth API =====
  app.post('/api/login', async (req, res) => {
    const { clubId, password } = req.body;
    if (!clubId || !password) {
      return res.status(400).json({ error: '請輸入帳號和密碼' });
    }

    let club;
    const input = String(clubId).trim();
    if (input.toLowerCase() === 'admin' || input === '0') {
      club = await getOne("SELECT * FROM clubs WHERE is_admin = 1 LIMIT 1");
    } else {
      const numericId = parseInt(input);
      if (isNaN(numericId)) {
        return res.status(401).json({ error: '帳號格式不正確' });
      }
      club = await getOne("SELECT * FROM clubs WHERE club_id = ?", [numericId]);
    }

    if (!club) {
      return res.status(401).json({ error: '帳號不存在' });
    }

    if (!bcrypt.compareSync(password, club.password)) {
      return res.status(401).json({ error: '密碼錯誤' });
    }

    const token = generateToken(club);
    res.json({
      token,
      clubId: club.club_id,
      clubName: club.club_name,
      isAdmin: club.is_admin === 1
    });
  });

  app.get('/api/me', authMiddleware, async (req, res) => {
    const club = await getOne("SELECT club_id, club_name, is_admin FROM clubs WHERE club_id = ?", [req.user.clubId]);
    if (!club) return res.status(404).json({ error: '社團不存在' });
    res.json(club);
  });

  // ===== Summary API (Public) =====
  app.get('/api/summary', async (req, res) => {
    const settingsRows = await getAll("SELECT key, value FROM settings");
    const settings = {};
    settingsRows.forEach(s => { settings[s.key] = s.value; });

    const summary = await getAll(`
      SELECT c.club_id, c.club_name,
        COUNT(r.id) as total_count,
        MAX(r.created_at) as last_register_time
      FROM clubs c
      LEFT JOIN registrations r ON c.club_id = r.club_id AND r.status != 'forfeited'
      WHERE c.is_admin = 0
      GROUP BY c.club_id, c.club_name
      ORDER BY c.club_id
    `);

    const phase1Total = await getOne("SELECT COUNT(*) as cnt FROM registrations WHERE phase = 1 AND status != 'forfeited'");
    const phase2Total = await getOne("SELECT COUNT(*) as cnt FROM registrations WHERE phase = 2 AND status != 'forfeited'");

    res.json({
      settings,
      summary,
      phase1Total: phase1Total?.cnt || 0,
      phase2Total: phase2Total?.cnt || 0
    });
  });

  // ===== Registration API =====
  app.get('/api/my-registrations', authMiddleware, async (req, res) => {
    const registrations = await getAll(
      "SELECT * FROM registrations WHERE club_id = ? ORDER BY created_at DESC",
      [req.user.clubId]
    );
    const club = await getOne("SELECT club_id, club_name FROM clubs WHERE club_id = ?", [req.user.clubId]);
    const count = await getOne("SELECT COUNT(*) as cnt FROM registrations WHERE club_id = ? AND status != 'forfeited'", [req.user.clubId]);
    res.json({
      club,
      registrations,
      count: count?.cnt || 0
    });
  });

  app.post('/api/registrations', authMiddleware, async (req, res) => {
    const settingsRows = await getAll("SELECT key, value FROM settings");
    const settings = {};
    settingsRows.forEach(s => { settings[s.key] = s.value; });
    const currentPhase = parseInt(settings.current_phase || '1');

    const { position, name, id_card, birthday, phone, meal_type } = req.body;
    if (!name) return res.status(400).json({ error: '請輸入姓名' });

    const id = await insert(
      "INSERT INTO registrations (club_id, position, name, id_card, birthday, phone, meal_type, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [req.user.clubId, position || '', name, id_card || '', birthday || '', phone || '', meal_type || '', currentPhase]
    );

    res.json({ id, message: '報名成功' });
  });

  app.put('/api/registrations/:id', authMiddleware, async (req, res) => {
    const reg = await getOne("SELECT * FROM registrations WHERE id = ? AND club_id = ?", [req.params.id, req.user.clubId]);
    if (!reg) return res.status(404).json({ error: '報名資料不存在' });

    const { position, name, id_card, birthday, phone, meal_type } = req.body;
    await runQuery(
      "UPDATE registrations SET position = ?, name = ?, id_card = ?, birthday = ?, phone = ?, meal_type = ? WHERE id = ? AND club_id = ?",
      [position || '', name, id_card || '', birthday || '', phone || '', meal_type || '', req.params.id, req.user.clubId]
    );

    res.json({ message: '更新成功' });
  });

  app.delete('/api/registrations/:id', authMiddleware, async (req, res) => {
    const reg = await getOne("SELECT * FROM registrations WHERE id = ? AND club_id = ?", [req.params.id, req.user.clubId]);
    if (!reg) return res.status(404).json({ error: '報名資料不存在' });

    await runQuery("DELETE FROM registrations WHERE id = ? AND club_id = ?", [req.params.id, req.user.clubId]);
    res.json({ message: '刪除成功' });
  });

  // ===== Payment Proof API =====
  app.post('/api/payment/upload', authMiddleware, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '請選擇檔案' });

    const { registration_id } = req.body;
    const fileType = req.file.mimetype === 'application/pdf' ? 'pdf' : 'image';

    const id = await insert(
      "INSERT INTO payment_proofs (registration_id, club_id, file_path, file_type, file_name) VALUES (?, ?, ?, ?, ?)",
      [registration_id || null, req.user.clubId, `/uploads/payments/${req.file.filename}`, fileType, req.file.originalname]
    );

    res.json({ id, message: '上傳成功', filePath: `/uploads/payments/${req.file.filename}` });
  });

  app.get('/api/payment/my-uploads', authMiddleware, async (req, res) => {
    const uploads = await getAll(
      "SELECT * FROM payment_proofs WHERE club_id = ? ORDER BY uploaded_at DESC",
      [req.user.clubId]
    );
    res.json(uploads);
  });

  // ===== Admin API =====
  app.get('/api/admin/all', authMiddleware, adminMiddleware, async (req, res) => {
    const { club_id, phase, status } = req.query;
    let sql = `
      SELECT r.*, c.club_name
      FROM registrations r
      JOIN clubs c ON r.club_id = c.club_id
      WHERE 1=1
    `;
    const params = [];

    if (club_id) { sql += " AND r.club_id = ?"; params.push(parseInt(club_id)); }
    if (phase) { sql += " AND r.phase = ?"; params.push(parseInt(phase)); }
    if (status) { sql += " AND r.status = ?"; params.push(status); }

    sql += " ORDER BY r.club_id, r.created_at";
    const registrations = await getAll(sql, params);
    res.json(registrations);
  });

  app.put('/api/admin/payment/:id', authMiddleware, adminMiddleware, async (req, res) => {
    await runQuery("UPDATE registrations SET status = 'paid' WHERE id = ?", [req.params.id]);
    res.json({ message: '已標記為已繳費' });
  });

  app.put('/api/admin/forfeit/:id', authMiddleware, adminMiddleware, async (req, res) => {
    await runQuery("UPDATE registrations SET status = 'forfeited' WHERE id = ?", [req.params.id]);
    res.json({ message: '已標記為棄權' });
  });

  app.put('/api/admin/reset-status/:id', authMiddleware, adminMiddleware, async (req, res) => {
    await runQuery("UPDATE registrations SET status = 'registered' WHERE id = ?", [req.params.id]);
    res.json({ message: '已重設狀態' });
  });

  // Payment proof review
  app.get('/api/payment/all', authMiddleware, adminMiddleware, async (req, res) => {
    const proofs = await getAll(`
      SELECT p.*, c.club_name
      FROM payment_proofs p
      JOIN clubs c ON p.club_id = c.club_id
      ORDER BY p.uploaded_at DESC
    `);
    res.json(proofs);
  });

  app.put('/api/payment/review/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const { action } = req.body;
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await runQuery(
      "UPDATE payment_proofs SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
      [newStatus, req.user.clubId.toString(), req.params.id]
    );

    if (action === 'approve') {
      const proof = await getOne("SELECT * FROM payment_proofs WHERE id = ?", [req.params.id]);
      if (proof && proof.registration_id) {
        await runQuery("UPDATE registrations SET status = 'paid' WHERE id = ?", [proof.registration_id]);
      }
    }

    res.json({ message: action === 'approve' ? '已確認繳費' : '已駁回' });
  });

  // Club management
  app.get('/api/admin/clubs', authMiddleware, adminMiddleware, async (req, res) => {
    const clubs = await getAll("SELECT club_id, club_name, is_admin FROM clubs ORDER BY club_id");
    res.json(clubs);
  });

  app.post('/api/admin/clubs', authMiddleware, adminMiddleware, async (req, res) => {
    const { club_id, club_name, password } = req.body;
    if (!club_id || !club_name) return res.status(400).json({ error: '請輸入社號和社名' });

    const defaultPwd = password || String(club_id).slice(-4);
    const hash = bcrypt.hashSync(defaultPwd, 10);

    await insert("INSERT OR REPLACE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, 0)",
      [parseInt(club_id), club_name, hash]);
    res.json({ message: '新增成功' });
  });

  app.put('/api/admin/clubs/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const { club_name } = req.body;
    await runQuery("UPDATE clubs SET club_name = ? WHERE club_id = ? AND is_admin = 0", [club_name, parseInt(req.params.id)]);
    res.json({ message: '更新成功' });
  });

  app.delete('/api/admin/clubs/:id', authMiddleware, adminMiddleware, async (req, res) => {
    await runQuery("DELETE FROM clubs WHERE club_id = ? AND is_admin = 0", [parseInt(req.params.id)]);
    res.json({ message: '刪除成功' });
  });

  app.put('/api/admin/clubs/:id/reset-password', authMiddleware, adminMiddleware, async (req, res) => {
    const { password } = req.body;
    const defaultPwd = password || String(req.params.id).slice(-4);
    const hash = bcrypt.hashSync(defaultPwd, 10);
    await runQuery("UPDATE clubs SET password = ? WHERE club_id = ?", [hash, parseInt(req.params.id)]);
    res.json({ message: '密碼已重設' });
  });

  app.post('/api/admin/import-clubs', authMiddleware, adminMiddleware, async (req, res) => {
    const { clubs } = req.body;
    if (!clubs || !Array.isArray(clubs)) return res.status(400).json({ error: '資料格式錯誤' });

    await importClubs(clubs);
    res.json({ message: `成功匯入 ${clubs.length} 個社團` });
  });

  app.post('/api/admin/import-excel', authMiddleware, adminMiddleware, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '請選擇檔案' });

    try {
      const workbook = XLSX.readFile(req.file.path);
      const sheetName = workbook.SheetNames.find(n => n.includes('社號社名')) || workbook.SheetNames[1];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet);

      const clubs = data
        .filter(row => row['社號'] && row['社名'])
        .map(row => ({
          club_id: parseInt(row['社號']),
          club_name: row['社名']
        }));

      await importClubs(clubs);
      fs.unlinkSync(req.file.path);
      res.json({ message: `成功匯入 ${clubs.length} 個社團` });
    } catch (err) {
      res.status(500).json({ error: '匯入失敗: ' + err.message });
    }
  });

  // Settings
  app.get('/api/admin/settings', authMiddleware, adminMiddleware, async (req, res) => {
    const settingsRows = await getAll("SELECT key, value FROM settings");
    const settings = {};
    settingsRows.forEach(s => { settings[s.key] = s.value; });
    res.json(settings);
  });

  app.put('/api/admin/settings', authMiddleware, adminMiddleware, async (req, res) => {
    const settings = req.body;
    const stmts = Object.entries(settings).map(([key, value]) => ({
      sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      args: [key, String(value)]
    }));
    const { getDb } = require('./database');
    await getDb().batch(stmts, 'write');
    res.json({ message: '設定已更新' });
  });

  // Full Backup (JSON)
  app.get('/api/admin/backup', authMiddleware, adminMiddleware, async (req, res) => {
    const clubs = await getAll("SELECT * FROM clubs");
    const registrations = await getAll("SELECT * FROM registrations");
    const paymentProofs = await getAll("SELECT * FROM payment_proofs");
    const settings = await getAll("SELECT * FROM settings");

    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      clubs,
      registrations,
      payment_proofs: paymentProofs,
      settings
    };

    const json = JSON.stringify(backup, null, 2);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=backup_${new Date().toISOString().slice(0,10)}.json`);
    res.send(json);
  });

  // Full Restore (JSON)
  app.post('/api/admin/restore', authMiddleware, adminMiddleware, async (req, res) => {
    const backup = req.body;
    if (!backup || !backup.clubs || !backup.registrations) {
      return res.status(400).json({ error: '備份檔案格式不正確' });
    }

    try {
      const { getDb } = require('./database');
      const dbConn = getDb();

      // Clear existing data
      await dbConn.batch([
        "DELETE FROM payment_proofs",
        "DELETE FROM registrations",
        "DELETE FROM settings",
        "DELETE FROM clubs WHERE is_admin = 0"
      ], 'write');

      // Restore clubs
      const clubStmts = backup.clubs.map(c => ({
        sql: "INSERT OR REPLACE INTO clubs (club_id, club_name, password, is_admin) VALUES (?, ?, ?, ?)",
        args: [c.club_id, c.club_name, c.password, c.is_admin || 0]
      }));
      if (clubStmts.length > 0) await dbConn.batch(clubStmts, 'write');

      // Restore registrations
      const regStmts = backup.registrations.map(r => ({
        sql: "INSERT OR REPLACE INTO registrations (id, club_id, position, name, id_card, birthday, phone, meal_type, phase, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [r.id, r.club_id, r.position || '', r.name, r.id_card || '', r.birthday || '', r.phone || '', r.meal_type || '', r.phase || 1, r.status || 'registered', r.created_at || null]
      }));
      if (regStmts.length > 0) await dbConn.batch(regStmts, 'write');

      // Restore payment proofs
      if (backup.payment_proofs && backup.payment_proofs.length > 0) {
        const ppStmts = backup.payment_proofs.map(p => ({
          sql: "INSERT OR REPLACE INTO payment_proofs (id, registration_id, club_id, file_path, file_type, file_name, status, reviewed_by, reviewed_at, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [p.id, p.registration_id, p.club_id, p.file_path, p.file_type, p.file_name || '', p.status || 'pending', p.reviewed_by || null, p.reviewed_at || null, p.uploaded_at || null]
        }));
        await dbConn.batch(ppStmts, 'write');
      }

      // Restore settings
      if (backup.settings && backup.settings.length > 0) {
        const settStmts = backup.settings.map(s => ({
          sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
          args: [s.key, s.value]
        }));
        await dbConn.batch(settStmts, 'write');
      }

      res.json({ message: `還原成功：${backup.clubs.length} 個社團、${backup.registrations.length} 筆報名` });
    } catch (err) {
      res.status(500).json({ error: '還原失敗: ' + err.message });
    }
  });

  // Export Excel
  app.get('/api/admin/export', authMiddleware, adminMiddleware, async (req, res) => {
    const { club_id, phase } = req.query;
    let sql = `
      SELECT r.*, c.club_name
      FROM registrations r
      JOIN clubs c ON r.club_id = c.club_id
      WHERE 1=1
    `;
    const params = [];
    if (club_id) { sql += " AND r.club_id = ?"; params.push(parseInt(club_id)); }
    if (phase) { sql += " AND r.phase = ?"; params.push(parseInt(phase)); }
    sql += " ORDER BY r.club_id, r.created_at";

    const data = await getAll(sql, params);
    const exportData = data.map(r => ({
      '社號': r.club_id,
      '社名': r.club_name,
      '職稱': r.position,
      '姓名': r.name,
      '身分證': r.id_card,
      '生日': r.birthday,
      '手機': r.phone,
      '素/葷': r.meal_type,
      '階段': r.phase,
      '狀態': r.status === 'registered' ? '已報名' : r.status === 'paid' ? '已繳費' : '棄權',
      '登錄時間': r.created_at
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(exportData);
    XLSX.utils.book_append_sheet(wb, ws, '報名資料');

    const summaryData = await getAll(`
      SELECT c.club_id, c.club_name,
        COUNT(CASE WHEN r.status = 'registered' THEN 1 END) as reg_count,
        COUNT(CASE WHEN r.status = 'paid' THEN 1 END) as paid_count,
        COUNT(CASE WHEN r.status = 'forfeited' THEN 1 END) as forfeit_count,
        COUNT(CASE WHEN r.status != 'forfeited' THEN 1 END) as total_count
      FROM clubs c
      LEFT JOIN registrations r ON c.club_id = r.club_id
      WHERE c.is_admin = 0
      GROUP BY c.club_id, c.club_name
      ORDER BY c.club_id
    `);
    const summarySheet = XLSX.utils.json_to_sheet(summaryData.map(s => ({
      '社號': s.club_id,
      '社名': s.club_name,
      '已報名人數': s.reg_count || 0,
      '已繳費人數': s.paid_count || 0,
      '棄權人數': s.forfeit_count || 0,
      '總報名人數': s.total_count || 0
    })));
    XLSX.utils.book_append_sheet(wb, summarySheet, '彙整統計');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=registration_report.xlsx');
    res.send(buffer);
  });
  // ===== Start Server =====
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });

  // ===== Init Database (non-blocking, in background) =====
  initDatabase()
    .then(() => console.log('Database ready'))
    .catch(err => console.error('Database init failed:', err.message));
}

startServer();
