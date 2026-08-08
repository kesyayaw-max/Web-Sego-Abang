// services/auditService.js
// Helper terpusat untuk mencatat jejak audit aktivitas staf ke tabel
// `audit_logs`. Dipanggil dari route yang melakukan aksi sensitif:
// login (sukses/gagal), konfirmasi pembayaran, pembatalan booking,
// CRUD menu/kategori, dan manajemen akun staf.
//
// Sengaja dibuat "fire-and-forget-safe": kalau pencatatan audit gagal
// (mis. DB sedang bermasalah), itu TIDAK BOLEH menggagalkan aksi utama
// yang sedang dilakukan user — jadi errornya cuma di-log ke console.

const { query } = require('../db');

/**
 * @param {Object} entry
 * @param {string|null} entry.userId      - UUID user, null jika aksi anonim/gagal login
 * @param {string|null} entry.userEmail   - snapshot email (berguna walau userId null, mis. login gagal)
 * @param {string}      entry.action      - kode aksi, mis. 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'BOOKING_CONFIRMED'
 * @param {string}      [entry.entityType]- mis. 'booking', 'menu', 'user'
 * @param {string}      [entry.entityId]  - UUID entitas terkait
 * @param {string}      [entry.ip]        - IP address request
 * @param {Object}      [entry.metadata]  - detail tambahan bebas (disimpan sebagai JSONB)
 */
async function logAudit({ userId = null, userEmail = null, action, entityType = null, entityId = null, ip = null, metadata = null }) {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, userEmail, action, entityType, entityId, ip, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    // Sengaja tidak di-throw: audit log tidak boleh menggagalkan alur utama.
    console.error('[AUDIT] gagal mencatat audit log:', err.message, { action, entityType, entityId });
  }
}

/** Helper untuk ambil IP klien dengan aman (menghormati proxy Railway). */
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
}

module.exports = { logAudit, clientIp };
