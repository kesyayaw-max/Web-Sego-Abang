// routes/menu.js
// Endpoint menu & kategori.
//
// PEMBAGIAN HAK AKSES:
//  - GET (lihat menu/kategori)               -> publik, siapa saja
//  - PATCH toggle stok (Tersedia/Habis)       -> OWNER & ADMIN
//  - POST / PUT / DELETE kategori             -> HANYA OWNER
//  - POST / PUT / DELETE menu (nama, harga)   -> HANYA OWNER

const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// KATEGORI
// ─────────────────────────────────────────────────────────────

// GET /api/categories — publik
router.get('/categories', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, description, display_order, is_active
       FROM categories WHERE is_active = TRUE ORDER BY display_order ASC`
    );
    return res.json({ success: true, categories: result.rows });
  } catch (err) {
    console.error('[MENU] get categories error:', err);
    return res.status(500).json({ success: false, message: 'Gagal memuat kategori.' });
  }
});

// POST /api/categories — HANYA OWNER
router.post(
  '/categories',
  authenticate,
  requireRole('OWNER'),
  [
    body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Nama kategori 2–100 karakter.'),
    body('display_order').optional().isInt({ min: 0 }).withMessage('Urutan tampil harus angka positif.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

    try {
      const { name, description, display_order } = req.body;
      const result = await query(
        `INSERT INTO categories (name, description, display_order, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4)
         RETURNING id, name, description, display_order`,
        [name.trim(), description || null, display_order ?? 0, req.user.id]
      );
      return res.status(201).json({ success: true, category: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ success: false, message: 'Nama kategori sudah ada.' });
      }
      console.error('[MENU] create category error:', err);
      return res.status(500).json({ success: false, message: 'Gagal membuat kategori.' });
    }
  }
);

// PUT /api/categories/:id — HANYA OWNER
router.put('/categories/:id', authenticate, requireRole('OWNER'), async (req, res) => {
  try {
    const { name, description, display_order } = req.body;
    if (name && (name.trim().length < 2 || name.trim().length > 100)) {
      return res.status(400).json({ success: false, message: 'Nama kategori 2–100 karakter.' });
    }
    const result = await query(
      `UPDATE categories
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           display_order = COALESCE($3, display_order),
           updated_by = $4
       WHERE id = $5
       RETURNING id, name, description, display_order`,
      [name?.trim(), description, display_order, req.user.id, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Kategori tidak ditemukan.' });
    }
    return res.json({ success: true, category: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Nama kategori sudah ada.' });
    }
    console.error('[MENU] update category error:', err);
    return res.status(500).json({ success: false, message: 'Gagal mengubah kategori.' });
  }
});

// DELETE /api/categories/:id — HANYA OWNER (soft delete)
router.delete('/categories/:id', authenticate, requireRole('OWNER'), async (req, res) => {
  try {
    // Cek apakah ada menu aktif di kategori ini
    const menuCheck = await query(
      `SELECT COUNT(*) FROM menus WHERE category_id = $1 AND is_active = TRUE`,
      [req.params.id]
    );
    if (parseInt(menuCheck.rows[0].count) > 0) {
      return res.status(409).json({
        success: false,
        message: 'Tidak bisa menghapus kategori yang masih memiliki menu aktif. Hapus atau pindahkan menu terlebih dahulu.',
      });
    }

    const result = await query(
      `UPDATE categories SET is_active = FALSE, updated_by = $1 WHERE id = $2 RETURNING id`,
      [req.user.id, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Kategori tidak ditemukan.' });
    }
    return res.json({ success: true, message: 'Kategori berhasil dihapus.' });
  } catch (err) {
    console.error('[MENU] delete category error:', err);
    return res.status(500).json({ success: false, message: 'Gagal menghapus kategori.' });
  }
});

// ─────────────────────────────────────────────────────────────
// MENU (ITEM MASAKAN)
// ─────────────────────────────────────────────────────────────

// GET /api/menus — publik
router.get('/menus', async (req, res) => {
  try {
    const { category_id, stock } = req.query;
    const conditions = ['m.is_active = TRUE', 'c.is_active = TRUE'];
    const params = [];

    if (category_id) {
      params.push(category_id);
      conditions.push(`m.category_id = $${params.length}`);
    }
    if (stock) {
      params.push(stock.toUpperCase());
      conditions.push(`m.stock_status = $${params.length}`);
    }

    const result = await query(`
      SELECT m.id, m.name, m.description, m.price, m.image_url,
             m.stock_status, m.display_order, m.category_id, c.name AS category_name
      FROM menus m
      JOIN categories c ON c.id = m.category_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.display_order ASC, m.display_order ASC, m.name ASC
    `, params);
    return res.json({ success: true, menus: result.rows });
  } catch (err) {
    console.error('[MENU] get menus error:', err);
    return res.status(500).json({ success: false, message: 'Gagal memuat menu.' });
  }
});

// POST /api/menus — HANYA OWNER (tambah item masakan baru)
router.post(
  '/menus',
  authenticate,
  requireRole('OWNER'),
  [
    body('category_id').isUUID().withMessage('Kategori tidak valid.'),
    body('name').trim().isLength({ min: 2, max: 150 }).withMessage('Nama menu 2–150 karakter.'),
    body('price').isFloat({ min: 1 }).withMessage('Harga harus lebih dari 0.'),
    body('display_order').optional().isInt({ min: 0 }).withMessage('Urutan tampil harus angka positif.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

    try {
      const { category_id, name, description, price, image_url, display_order } = req.body;
      const result = await query(
        `INSERT INTO menus (category_id, name, description, price, image_url, display_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, price, stock_status, display_order`,
        [category_id, name.trim(), description || null, parseFloat(price), image_url || null, display_order ?? 0]
      );
      return res.status(201).json({ success: true, menu: result.rows[0] });
    } catch (err) {
      console.error('[MENU] create menu error:', err);
      return res.status(500).json({ success: false, message: 'Gagal menambah menu.' });
    }
  }
);

// PUT /api/menus/:id — HANYA OWNER (ubah nama/harga/deskripsi)
router.put('/menus/:id', authenticate, requireRole('OWNER'), async (req, res) => {
  try {
    const { name, description, price, image_url, category_id, display_order } = req.body;

    if (price !== undefined && parseFloat(price) <= 0) {
      return res.status(400).json({ success: false, message: 'Harga harus lebih dari 0.' });
    }

    const result = await query(
      `UPDATE menus
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           price = COALESCE($3, price),
           image_url = COALESCE($4, image_url),
           category_id = COALESCE($5, category_id),
           display_order = COALESCE($6, display_order)
       WHERE id = $7
       RETURNING id, name, price, stock_status, display_order`,
      [name?.trim(), description, price ? parseFloat(price) : null, image_url, category_id, display_order, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Menu tidak ditemukan.' });
    }
    return res.json({ success: true, menu: result.rows[0] });
  } catch (err) {
    console.error('[MENU] update menu error:', err);
    return res.status(500).json({ success: false, message: 'Gagal mengubah menu.' });
  }
});

// DELETE /api/menus/:id — HANYA OWNER (soft delete)
router.delete('/menus/:id', authenticate, requireRole('OWNER'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE menus SET is_active = FALSE WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Menu tidak ditemukan.' });
    }
    return res.json({ success: true, message: 'Menu berhasil dihapus.' });
  } catch (err) {
    console.error('[MENU] delete menu error:', err);
    return res.status(500).json({ success: false, message: 'Gagal menghapus menu.' });
  }
});

// ─────────────────────────────────────────────────────────────
// SAKELAR STOK INSTAN — OWNER & ADMIN boleh akses
// ─────────────────────────────────────────────────────────────

// PATCH /api/menus/:id/stock — toggle Tersedia <-> Habis
router.patch('/menus/:id/stock', authenticate, requireRole('OWNER', 'ADMIN'), async (req, res) => {
  try {
    const { stock_status } = req.body;
    if (!['AVAILABLE', 'OUT_OF_STOCK'].includes(stock_status)) {
      return res.status(400).json({ success: false, message: 'Status stok tidak valid.' });
    }

    const result = await query(
      `UPDATE menus SET stock_status = $1, is_available = ($1 = 'AVAILABLE') WHERE id = $2 AND is_active = TRUE
       RETURNING id, name, stock_status`,
      [stock_status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Menu tidak ditemukan.' });
    }

    // Broadcast real-time supaya halaman menu pelanggan langsung ter-update
    const io = req.app.get('io');
    if (io) {
      io.emit('menu:stock_changed', result.rows[0]);
    }

    return res.json({ success: true, menu: result.rows[0] });
  } catch (err) {
    console.error('[MENU] toggle stock error:', err);
    return res.status(500).json({ success: false, message: 'Gagal mengubah status stok.' });
  }
});

module.exports = router;


module.exports = router;
