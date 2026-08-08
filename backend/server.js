// server.js
// Entry point utama backend RM. Sego Abang Pendopo Wonomarto.
//
// Stack: Node.js + Express + PostgreSQL (pg) + Socket.IO (real-time
// live map & stok) + node-cron (background worker seat unlock).

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const bookingRoutes = require('./routes/bookings');
const menuRoutes = require('./routes/menu');
const settingsRoutes = require('./routes/settings');
const printQueueRoutes = require('./routes/printQueue');
const { startTableCleanerCron } = require('./cron/tableCleaner');

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------
// CORS — whitelist domain frontend dari env variable.
// Fallback ke '*' hanya di development untuk kemudahan testing.
// ---------------------------------------------------------------------
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : ['http://localhost:3000', 'http://localhost:4000', 'http://127.0.0.1:5500'];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (file://, mobile apps, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: origin "${origin}" tidak diizinkan.`));
  },
  credentials: true,
};

// ---------------------------------------------------------------------
// Socket.IO setup — real-time siaran:
//  - table:status_changed  (Live Map Monitor dashboard admin + halaman
//    pilih meja pelanggan)
//  - menu:stock_changed    (Sakelar stok -> halaman menu pelanggan)
//  - kitchen:receipt_printed (notifikasi dashboard admin struk tercetak)
// ---------------------------------------------------------------------
const io = new Server(server, {
  cors: corsOptions,
});

io.on('connection', (socket) => {
  console.log(`[SOCKET] client terhubung: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[SOCKET] client terputus: ${socket.id}`);
  });
});

// Lampirkan io ke app supaya bisa diakses dari dalam route handler
app.set('io', io);

// ---------------------------------------------------------------------
// Middleware global
// ---------------------------------------------------------------------
app.use(helmet({
  // Izinkan koneksi socket.io dari browser
  contentSecurityPolicy: false,
}));

app.use(cors(corsOptions));

// HTTP request logging
// Di production: 'combined' (Apache format)
// Di development: 'dev' (berwarna, ringkas)
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use(express.json({ limit: '2mb' }));

// Rate limit umum — perlindungan dasar dari spam request
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

// Rate limit khusus endpoint booking supaya tidak ada spam klik
// mengunci banyak meja sekaligus dari satu sumber.
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: 'Terlalu banyak percobaan pemesanan. Coba lagi sebentar lagi.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/bookings', bookingLimiter);

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api', bookingRoutes); // /api/tables, /api/bookings/*, /api/stats/*
app.use('/api', menuRoutes);    // /api/categories/*, /api/menus/*
app.use('/api', settingsRoutes); // /api/settings
app.use('/api', printQueueRoutes); // /api/print-queue (khusus Print Agent lokal)

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'rm-sego-abang-pendopo-wonomarto-backend',
    status: 'ok',
    version: '2.0.0',
    time: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan.' });
});

// Error handler terakhir (jaring pengaman)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // CORS error
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ success: false, message: err.message });
  }
  console.error('[SERVER] unhandled error:', err);
  res.status(500).json({ success: false, message: 'Terjadi kesalahan tak terduga pada server.' });
});

// ---------------------------------------------------------------------
// Start server + cron job
// ---------------------------------------------------------------------
// Dibungkus `require.main === module` supaya file ini bisa di-`require()`
// oleh test (supertest) tanpa otomatis membuka port asli & menyalakan
// cron job — server hanya benar-benar start kalau dijalankan langsung
// (`node server.js` / `npm start` / `npm run dev`).
const PORT = process.env.PORT || 4000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[SERVER] RM. Sego Abang Pendopo Wonomarto backend v2.0.0 berjalan di port ${PORT}`);
    console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
    startTableCleanerCron(io);
  });
}

module.exports = { app, server, io };
