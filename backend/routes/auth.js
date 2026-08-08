// routes/auth.js
// Login staf (OWNER / ADMIN). Tidak ada registrasi publik — akun staf
// dibuat manual oleh OWNER lewat endpoint /api/auth/staff.

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { JWT_SECRET, authenticate, requireRole } = require('../middleware/auth');
const { logAudit, clientIp } = require('../services/auditService');

const router = express.Router();

// ---------------------------------------------------------------------
// Refresh token: dipakai supaya access token JWT bisa berumur pendek
// (2 jam, lebih aman kalau bocor) tanpa memaksa staf login ulang tiap
// 2 jam. Refresh token sendiri random string 40 byte, DISIMPAN SEBAGAI
// HASH SHA-256 di tabel refresh_tokens (bukan token mentahnya) supaya
// kalau database bocor, token tidak langsung bisa dipakai.
// ---------------------------------------------------------------------
const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '2h';
const REFRESH_TOKEN_EXPIRES_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS || '7', 10);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  );
}

async function issueRefreshToken(userId, req) {
  const rawToken = crypto.randomBytes(40).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(rawToken), req.headers['user-agent'] || null, clientIp(req), expiresAt]
  );

  return rawToken;
}

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
      await logAudit({
        userEmail: email,
        action: 'LOGIN_FAILED',
        ip: clientIp(req),
        metadata: { reason: !user ? 'email_not_found' : 'inactive_account' },
      });
      return res.status(401).json({
        success: false,
        message: 'Email atau password salah, atau akun nonaktif.',
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      await logAudit({
        userId: user.id,
        userEmail: user.email,
        action: 'LOGIN_FAILED',
        ip: clientIp(req),
        metadata: { reason: 'wrong_password' },
      });
      return res.status(401).json({
        success: false,
        message: 'Email atau password salah.',
      });
    }

    const token = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id, req);

    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    await logAudit({
      userId: user.id,
      userEmail: user.email,
      action: 'LOGIN_SUCCESS',
      ip: clientIp(req),
    });

    return res.json({
      success: true,
      token,
      refreshToken,
      expiresIn: ACCESS_TOKEN_EXPIRES_IN,
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

// POST /api/auth/refresh — tukar refresh token dengan access token baru.
// Refresh token juga DIROTASI (yang lama langsung dicabut) supaya kalau
// satu refresh token bocor & dipakai dua kali, itu jadi sinyal pencurian
// yang bisa dideteksi (token lama otomatis invalid).
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'refreshToken wajib diisi.' });
    }

    const tokenHash = hashToken(refreshToken);
    const result = await query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
              u.email, u.full_name, u.role, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [tokenHash]
    );

    const row = result.rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at) < new Date() || !row.is_active) {
      return res.status(401).json({
        success: false,
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Sesi sudah berakhir. Silakan login kembali.',
      });
    }

    // Cabut token lama (rotasi), buat token baru.
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
    const newRefreshToken = await issueRefreshToken(row.user_id, req);

    const newAccessToken = signAccessToken({
      id: row.user_id,
      email: row.email,
      full_name: row.full_name,
      role: row.role,
    });

    return res.json({
      success: true,
      token: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    });
  } catch (err) {
    console.error('[AUTH] refresh error:', err);
    return res.status(500).json({ success: false, message: 'Gagal memperbarui sesi.' });
  }
});

// GET /api/auth/me — cek sesi & role user yang sedang login
router.get('/me', authenticate, (req, res) => {
  return res.json({ success: true, user: req.user });
});

// POST /api/auth/logout — mencabut refresh token (sesi) di database,
// jadi tidak bisa dipakai lagi untuk minta access token baru walau
// access token JWT yang sudah beredar tetap valid sampai expire
// (maksimal ACCESS_TOKEN_EXPIRES_IN, sekarang jauh lebih pendek
// daripada versi lama yang 12 jam).
router.post('/logout', authenticate, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND user_id = $2`,
        [hashToken(refreshToken), req.user.id]
      );
    }
    await logAudit({ userId: req.user.id, userEmail: req.user.email, action: 'LOGOUT', ip: clientIp(req) });
    return res.json({ success: true, message: 'Logout berhasil.' });
  } catch (err) {
    console.error('[AUTH] logout error:', err);
    return res.status(500).json({ success: false, message: 'Gagal logout.' });
  }
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

    await logAudit({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'STAFF_CREATED',
      entityType: 'user',
      entityId: result.rows[0].id,
      ip: clientIp(req),
      metadata: { created_email: result.rows[0].email, role },
    });

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

    await logAudit({
      userId: req.user.id,
      userEmail: req.user.email,
      action: staff.is_active ? 'STAFF_ACTIVATED' : 'STAFF_DEACTIVATED',
      entityType: 'user',
      entityId: staff.id,
      ip: clientIp(req),
    });

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

    // Cabut semua sesi (refresh token) staf yang password-nya direset,
    // supaya sesi lama langsung tidak berlaku.
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [targetId]);

    await logAudit({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'STAFF_PASSWORD_RESET',
      entityType: 'user',
      entityId: targetId,
      ip: clientIp(req),
    });

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
