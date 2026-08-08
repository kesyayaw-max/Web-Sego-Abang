#!/usr/bin/env node
// database/seed.js
// Script seed data akun & menu untuk RM. Sego Abang Pendopo Wonomarto.
// Jalankan SETELAH schema.sql berhasil diaplikasikan:
//   cd backend && node ../database/seed.js
//
// Script ini membuat hash bcrypt yang sungguhan sehingga login bisa
// langsung dipakai tanpa mengganti hash manual.

require('dotenv').config({ path: require('path').join(__dirname, '../backend/.env') });

const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        database: process.env.DB_NAME || 'sego_abang',
      }
);

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('🌱 Memulai seeding...');

    // ─── USERS ──────────────────────────────────────────────────────────
    console.log('  [1/3] Membuat akun staf...');

    const ownerPassword = process.env.SEED_OWNER_PASSWORD || 'SegoAbang@Owner2026!';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'SegoAbang@Admin2026!';

    const [ownerHash, adminHash] = await Promise.all([
      bcrypt.hash(ownerPassword, 12),
      bcrypt.hash(adminPassword, 12),
    ]);

    // Upsert supaya script bisa dijalankan berulang tanpa error duplicate
    await client.query(`
      INSERT INTO users (full_name, email, password_hash, role)
      VALUES
        ('Pak Slamet (Owner)', 'owner@segoabang.id', $1, 'OWNER'),
        ('Mbak Sari (Kasir)',  'admin@segoabang.id', $2, 'ADMIN')
      ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            full_name     = EXCLUDED.full_name
    `, [ownerHash, adminHash]);

    console.log(`  ✅ Owner: owner@segoabang.id / ${ownerPassword}`);
    console.log(`  ✅ Admin: admin@segoabang.id / ${adminPassword}`);

    // ─── MENUS ──────────────────────────────────────────────────────────
    console.log('  [2/3] Mengisi data menu...');

    // Ambil ID kategori dari DB
    const catRes = await client.query(`SELECT id, name FROM categories`);
    const catMap = Object.fromEntries(catRes.rows.map((r) => [r.name, r.id]));

    const menus = [
      // Sego & Lauk
      { cat: 'Sego & Lauk', name: 'Sego Abang Komplit',     price: 25000, order: 1 },
      { cat: 'Sego & Lauk', name: 'Sego Abang Polos',       price: 18000, order: 2 },
      { cat: 'Sego & Lauk', name: 'Empal Gepuk',            price: 22000, order: 3 },
      { cat: 'Sego & Lauk', name: 'Ayam Goreng Kampung',    price: 28000, order: 4 },
      { cat: 'Sego & Lauk', name: 'Sayur Lombok Ijo',       price: 12000, order: 5 },
      { cat: 'Sego & Lauk', name: 'Tempe Bacem',            price: 8000,  order: 6 },
      { cat: 'Sego & Lauk', name: 'Telur Ceplok Kecap',     price: 10000, order: 7 },
      // Wedangan
      { cat: 'Wedangan',    name: 'Wedang Uwuh',            price: 10000, order: 1 },
      { cat: 'Wedangan',    name: 'Wedang Jahe',            price: 8000,  order: 2 },
      { cat: 'Wedangan',    name: 'Kopi Joss',              price: 9000,  order: 3 },
      { cat: 'Wedangan',    name: 'Teh Tarik',              price: 7000,  order: 4 },
      { cat: 'Wedangan',    name: 'Es Dawet',               price: 10000, order: 5 },
      // Kudapan
      { cat: 'Kudapan',     name: 'Tempe Mendoan',          price: 12000, order: 1 },
      { cat: 'Kudapan',     name: 'Bakwan Jagung',          price: 10000, order: 2 },
      { cat: 'Kudapan',     name: 'Tahu Isi Goreng',        price: 8000,  order: 3 },
      { cat: 'Kudapan',     name: 'Lumpia Semarang',        price: 15000, order: 4 },
    ];

    for (const m of menus) {
      const catId = catMap[m.cat];
      if (!catId) {
        console.warn(`  ⚠️  Kategori "${m.cat}" tidak ditemukan, skip menu "${m.name}"`);
        continue;
      }
      await client.query(`
        INSERT INTO menus (category_id, name, price, display_order)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
      `, [catId, m.name, m.price, m.order]);
    }
    console.log(`  ✅ ${menus.length} menu diisi`);

    // ─── VERIFY ─────────────────────────────────────────────────────────
    console.log('  [3/3] Verifikasi...');
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM users)               AS users,
        (SELECT COUNT(*) FROM categories)          AS categories,
        (SELECT COUNT(*) FROM menus)               AS menus,
        (SELECT COUNT(*) FROM restaurant_tables)   AS tables
    `);
    console.log('  📊 Ringkasan:', counts.rows[0]);

    await client.query('COMMIT');
    console.log('\n✅ Seeding selesai!');
    console.log('\nCatatan keamanan:');
    console.log('  - Ganti password default sebelum dipakai di production');
    console.log('  - Set SEED_OWNER_PASSWORD & SEED_ADMIN_PASSWORD di .env untuk password custom\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding gagal:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
