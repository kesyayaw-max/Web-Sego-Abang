// tests/auth.test.js
// Test validasi input & middleware proteksi role. Sengaja hanya menguji
// jalur yang gagal SEBELUM menyentuh database (validasi express-validator
// & middleware authenticate/requireRole), supaya test ini bisa jalan di
// CI tanpa perlu PostgreSQL beneran menyala.
//
// Test yang butuh data sungguhan (login berhasil, dsb) sebaiknya jadi
// test integrasi terpisah yang jalan melawan database test (lihat
// catatan di README bagian "Testing").

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_untuk_jest_saja';

const request = require('supertest');
const { app } = require('../server');

describe('POST /api/auth/login — validasi input', () => {
  it('menolak email dengan format tidak valid (400)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bukan-email', password: 'passwordvalid123' });
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('menolak password kurang dari 6 karakter (400)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@segoabang.id', password: '123' });
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('Proteksi endpoint berbasis role', () => {
  it('menolak akses /api/auth/staff tanpa token (401)', async () => {
    const res = await request(app).get('/api/auth/staff');
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('NO_TOKEN');
  });

  it('menolak token yang tidak valid (401)', async () => {
    const res = await request(app)
      .get('/api/auth/staff')
      .set('Authorization', 'Bearer token-ngasal-tidak-valid');
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('menolak role ADMIN mengakses endpoint khusus OWNER (403)', async () => {
    const jwt = require('jsonwebtoken');
    const adminToken = jwt.sign(
      { id: 'fake-admin-id', email: 'admin@segoabang.id', role: 'ADMIN', full_name: 'Admin Test' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    const res = await request(app)
      .get('/api/auth/staff')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });
});

describe('Print Agent endpoint — proteksi API key', () => {
  it('menolak GET /api/print-queue tanpa API key (401)', async () => {
    const res = await request(app).get('/api/print-queue');
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('INVALID_AGENT_KEY');
  });
});
