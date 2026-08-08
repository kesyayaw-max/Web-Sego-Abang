// middleware/auth.js
// Autentikasi berbasis JWT + otorisasi berbasis role (OWNER / ADMIN).
//
// Prinsip: OWNER adalah superset dari ADMIN untuk operasional harian,
// tapi ada endpoint yang HANYA boleh diakses OWNER (CRUD kategori menu).
// Endpoint tersebut memakai requireRole('OWNER') secara eksplisit.

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// Guard: jangan biarkan server berjalan tanpa JWT_SECRET di production
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[AUTH] FATAL: JWT_SECRET tidak di-set di environment! Server dihentikan.');
    process.exit(1);
  } else {
    console.warn('[AUTH] PERINGATAN: JWT_SECRET tidak di-set, memakai secret default development. JANGAN pakai ini di production!');
  }
}

const EFFECTIVE_SECRET = JWT_SECRET || 'dev_secret_jangan_pakai_di_production_12345';

/**
 * Memverifikasi token JWT dari header Authorization: Bearer <token>.
 * Jika valid, melampirkan payload user ke req.user.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      code: 'NO_TOKEN',
      message: 'Token otentikasi tidak ditemukan. Silakan login kembali.',
    });
  }

  try {
    const payload = jwt.verify(token, EFFECTIVE_SECRET);
    req.user = payload; // { id, email, role, full_name }
    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      code: 'INVALID_TOKEN',
      message: 'Sesi login tidak valid atau sudah kedaluwarsa.',
    });
  }
}

/**
 * Factory middleware untuk membatasi akses berdasarkan role tertentu.
 * Contoh: requireRole('OWNER') hanya meloloskan user dengan role OWNER.
 *         requireRole('OWNER', 'ADMIN') meloloskan keduanya.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        code: 'NOT_AUTHENTICATED',
        message: 'Anda harus login terlebih dahulu.',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN_ROLE',
        message: `Aksi ini hanya diperbolehkan untuk role: ${allowedRoles.join(', ')}.`,
      });
    }

    return next();
  };
}

module.exports = { authenticate, requireRole, JWT_SECRET: EFFECTIVE_SECRET };
