// routes/auth.js
// Login staf (OWNER / ADMIN). Tidak ada registrasi publik — akun staf
// dibuat manual oleh OWNER lewat endpoint /api/auth/staff.

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { JWT_SECRET, authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// Rate limiter khusus login — maksimum 10 percobaan per 15 menit per IP.
// Mencegah brute-force password staf.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 10,
  skipSuccessfulRequests: true, // hanya hitung request yang gagal
  message: {
    success: false,
    code: 'TOO_MANY_ATTEMPTS',
    message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Validasi input login
const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Format email tidak valid.'),
  body('password').isLength({ min: 6 }).withMessage('Password minimal 6 karakter.'),
];

// POST /api/auth/login
router.post('/login', loginLimiter, loginValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: errors.array()[0].msg });
  }

  try {
    const { email, password } = req.body;

    const result = await query(
      `SELECT id, full_name, email, password_hash, role, is_active
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    const user = result.rows[0];

    // Gunakan pesan generik untuk mencegah user enumeration
    if (!user || !user.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Email atau password salah, atau akun nonaktif.',
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Email atau password salah.',
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role, // 'OWNER' | 'ADMIN'
      },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('[AUTH] login error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// GET /api/auth/me — cek sesi & role user yang sedang login
router.get('/me', authenticate, (req, res) => {
  return res.json({ success: true, user: req.user });
});

// POST /api/auth/logout — client-side logout hint (stateless JWT)
// Token tetap valid sampai expire — implementasi blacklist butuh Redis.
// Ini memberi sinyal explicit ke client untuk hapus token dari storage.
router.post('/logout', authenticate, (req, res) => {
  return res.json({ success: true, message: 'Logout berhasil. Silakan hapus token dari penyimpanan lokal.' });
});

// GET /api/auth/staff — OWNER lihat semua staf
router.get('/staff', authenticate, requireRole('OWNER'), async (req, res) => {
  try {
    const result = await query(
      `SELECT id, full_name, email, role, is_active, last_login_at, created_at
       FROM users ORDER BY role ASC, full_name ASC`
    );
    return res.json({ success: true, staff: result.rows });
  } catch (err) {
    console.error('[AUTH] get staff error:', err);
    return res.status(500).json({ success: false, message: 'Gagal memuat data staf.' });
  }
});

// POST /api/auth/staff — OWNER membuat akun staf baru (ADMIN/OWNER)
router.post('/staff', authenticate, requireRole('OWNER'), async (req, res) => {
  try {
    const { full_name, email, password, role } = req.body;

    if (!full_name || !email || !password || !['OWNER', 'ADMIN'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Data staf tidak lengkap atau role tidak valid.',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password staf minimal 8 karakter.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, email, role, created_at`,
      [full_name, email.toLowerCase().trim(), passwordHash, role]
    );

    return res.status(201).json({ success: true, staff: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Email sudah terdaftar.' });
    }
    console.error('[AUTH] create staff error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// PATCH /api/auth/staff/:id/toggle-active — OWNER nonaktifkan/aktifkan staf
router.patch('/staff/:id/toggle-active', authenticate, requireRole('OWNER'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE users SET is_active = NOT is_active WHERE id = $1
       RETURNING id, full_name, is_active`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Staf tidak ditemukan.' });
    }
    const staff = result.rows[0];
    return res.json({
      success: true,
      message: `Akun ${staff.full_name} ${staff.is_active ? 'diaktifkan' : 'dinonaktifkan'}.`,
      staff,
    });
  } catch (err) {
    console.error('[AUTH] toggle staff error:', err);
    return res.status(500).json({ success: false, message: 'Gagal mengubah status staf.' });
  }
});

// PATCH /api/auth/staff/:id/reset-password — OWNER reset password staf
router.patch('/staff/:id/reset-password', authenticate, requireRole('OWNER'), async (req, res) => {
  try {
    const { new_password } = req.body;
    const targetId = req.params.id;

    // Tidak boleh reset password diri sendiri via endpoint ini
    if (targetId === req.user.id) {
      return res.status(400).json({ success: false, message: 'Gunakan menu profil untuk mengubah password Anda sendiri.' });
    }

    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password baru minimal 8 karakter.' });
    }

    // Pastikan target staf ada
    const check = await query('SELECT id, full_name FROM users WHERE id = $1', [targetId]);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Staf tidak ditemukan.' });
    }

    const passwordHash = await bcrypt.hash(new_password, 12);
    await query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, targetId]
    );

    return res.json({
      success: true,
      message: `Password ${check.rows[0].full_name} berhasil direset.`,
    });
  } catch (err) {
    console.error('[AUTH] reset password error:', err);
    return res.status(500).json({ success: false, message: 'Gagal mereset password.' });
  }
});

module.exports = router;
