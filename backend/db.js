// db.js
// Koneksi pool ke PostgreSQL. Semua query di backend memakai pool ini
// supaya bisa menjalankan transaksi ACID (penting untuk seat locking).

const { Pool } = require('pg');

// Railway Postgres (dan sebagian besar PaaS lain) menyediakan satu
// variable DATABASE_URL berisi seluruh kredensial koneksi. Kalau
// variable itu ada, pakai itu; kalau tidak (mis. development lokal),
// fallback ke variable DB_HOST/DB_USER/dst yang terpisah.
const connectionConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      // Railway & kebanyakan PaaS mewajibkan SSL tapi dengan sertifikat
      // self-signed, sehingga rejectUnauthorized harus false.
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'sego_abang',
    };

const pool = new Pool({
  ...connectionConfig,
  max: 20,                       // maksimum koneksi dalam pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  // Koneksi idle yang error tidak boleh mematikan seluruh proses server
  console.error('[DB] Unexpected error pada idle client', err);
});

/**
 * Helper untuk menjalankan satu query sederhana di luar transaksi.
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    console.log('[DB] query', { text, duration, rows: result.rowCount });
  }
  return result;
}

/**
 * Helper untuk menjalankan sekumpulan query di dalam SATU transaksi.
 * `callback` menerima `client` (koneksi terikat transaksi) dan harus
 * mengembalikan Promise. Jika callback throw, transaksi otomatis
 * di-ROLLBACK; jika sukses, otomatis di-COMMIT.
 *
 * Ini krusial untuk fitur seat-locking: cek status meja + kunci meja
 * + buat booking HARUS atomik, tidak boleh ada celah antar-request.
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
