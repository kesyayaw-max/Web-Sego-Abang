// routes/settings.js
// Endpoint konfigurasi restoran — dibaca oleh frontend pelanggan (QRIS URL)
// dan bisa diubah Owner tanpa perlu redeploy backend.

const express = require('express');
const { query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// Kunci yang boleh dibaca publik (tidak perlu login)
const PUBLIC_KEYS = ['qris_static_image_url', 'qris_bank_name', 'table_lock_duration_minutes'];

// GET /api/settings — baca semua setting (publik hanya dapat key yang aman)
router.get('/settings', async (req, res) => {
  try {
    const result = await query(`SELECT key, value FROM restaurant_settings ORDER BY key`);
    const allSettings = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));

    // Jika ada token admin yang valid, kembalikan semua setting
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (token) {
      // Coba verifikasi token, jika valid kembalikan semua
      try {
        const jwt = require('jsonwebtoken');
        const { JWT_SECRET } = require('../middleware/auth');
        jwt.verify(token, JWT_SECRET);
        return res.json({ success: true, settings: allSettings });
      } catch (_e) {
        // Token invalid, lanjut ke publik
      }
    }

    // Publik: hanya setting yang aman
    const publicSettings = {};
    for (const key of PUBLIC_KEYS) {
      if (allSettings[key] !== undefined) publicSettings[key] = allSettings[key];
    }
    return res.json({ success: true, settings: publicSettings });
  } catch (err) {
    console.error('[SETTINGS] get error:', err);
    return res.status(500).json({ success: false, message: 'Gagal memuat konfigurasi.' });
  }
});

// PATCH /api/settings/:key — update satu setting — HANYA OWNER
router.patch('/settings/:key', authenticate, requireRole('OWNER'), async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined || value === null) {
      return res.status(400).json({ success: false, message: 'Nilai setting wajib diisi.' });
    }

    // Validasi khusus per key
    if (key === 'table_lock_duration_minutes') {
      const mins = parseInt(value);
      if (isNaN(mins) || mins < 1 || mins > 60) {
        return res.status(400).json({ success: false, message: 'Durasi kunci meja harus antara 1–60 menit.' });
      }
    }

    const result = await query(
      `INSERT INTO restaurant_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING key, value`,
      [key, String(value), req.user.id]
    );

    return res.json({ success: true, setting: result.rows[0] });
  } catch (err) {
    console.error('[SETTINGS] update error:', err);
    return res.status(500).json({ success: false, message: 'Gagal mengubah konfigurasi.' });
  }
});

// PUT /api/settings — update beberapa setting sekaligus — HANYA OWNER
router.put('/settings', authenticate, requireRole('OWNER'), async (req, res) => {
  try {
    const { settings } = req.body; // { key: value, key2: value2 }
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ success: false, message: 'Format settings tidak valid.' });
    }

    const updated = [];
    for (const [key, value] of Object.entries(settings)) {
      const result = await query(
        `INSERT INTO restaurant_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING key, value`,
        [key, String(value), req.user.id]
      );
      updated.push(result.rows[0]);
    }

    return res.json({ success: true, updated });
  } catch (err) {
    console.error('[SETTINGS] bulk update error:', err);
    return res.status(500).json({ success: false, message: 'Gagal mengubah konfigurasi.' });
  }
});

// GET /api/settings/printer/test — test koneksi TCP ke printer — HANYA OWNER
router.get('/settings/printer/test', authenticate, requireRole('OWNER'), async (req, res) => {
  const { ip, port = '9100' } = req.query;
  if (!ip) return res.status(400).json({ success: false, message: 'IP wajib diisi.' });

  const net = require('net');
  const socket = new net.Socket();
  const TIMEOUT = 3000;
  let responded = false;

  const done = (reachable, msg) => {
    if (responded) return;
    responded = true;
    socket.destroy();
    return res.json({ success: true, reachable, message: msg });
  };

  socket.setTimeout(TIMEOUT);
  socket.on('connect', () => done(true, `Printer terhubung di ${ip}:${port}`));
  socket.on('timeout', () => done(false, 'Koneksi timeout'));
  socket.on('error', (e) => done(false, e.message));
  socket.connect(parseInt(port), ip);
});

module.exports = router;
