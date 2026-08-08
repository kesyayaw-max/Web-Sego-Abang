// tests/health.test.js
// Test paling dasar: pastikan server bisa menyala dan endpoint health
// check merespons 200. Tidak menyentuh database sama sekali.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_untuk_jest_saja';

const request = require('supertest');
const { app } = require('../server');

describe('GET /api/health', () => {
  it('mengembalikan status 200 dan service ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('ok');
  });
});

describe('404 handler', () => {
  it('mengembalikan 404 untuk endpoint yang tidak ada', async () => {
    const res = await request(app).get('/api/tidak-ada-endpoint-seperti-ini');
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
