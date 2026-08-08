// routes/printQueue.js
// Endpoint khusus dipanggil oleh Print Agent lokal (backend/print-agent/),
// BUKAN oleh browser staf. Diproteksi API key statis (authenticateAgent),
// bukan JWT staf, karena yang memanggil adalah proses mesin di jaringan
// lokal restoran, bukan manusia yang login.

const express = require('express');
const { authenticateAgent } = require('../middleware/auth');
const { claimQueuedJobs, completePrintJob } = require('../services/printService');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// GET /api/print-queue
// Dipoll agent tiap beberapa detik. Mengembalikan job QUEUED terbaru
// (maks `limit`, default 5) dan langsung menandainya "diklaim" supaya
// tidak diambil dobel oleh polling berikutnya.
// ─────────────────────────────────────────────────────────────
router.get('/print-queue', authenticateAgent, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '5', 10), 20);
    const jobs = await claimQueuedJobs(limit);
    return res.json({ success: true, jobs });
  } catch (err) {
    console.error('[PRINT-QUEUE] gagal mengambil antrean:', err);
    return res.status(500).json({ success: false, message: 'Gagal mengambil antrean cetak.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/print-queue/:jobId/result
// Dipanggil agent setelah mencoba mencetak satu job, melaporkan hasilnya.
// Body: { status: 'PRINTED' | 'FAILED', error_message?, booking_id, triggered_by? }
// ─────────────────────────────────────────────────────────────
router.post('/print-queue/:jobId/result', authenticateAgent, async (req, res) => {
  try {
    const { status, error_message, booking_id, triggered_by } = req.body;

    if (!['PRINTED', 'FAILED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status harus PRINTED atau FAILED.' });
    }
    if (!booking_id) {
      return res.status(400).json({ success: false, message: 'booking_id wajib diisi.' });
    }

    // print_logs pakai enum printer_status ('SUCCESS'/'FAILED'), jadi
    // dipetakan dari status print_job ('PRINTED'/'FAILED') di sini.
    const printLogStatus = status === 'PRINTED' ? 'SUCCESS' : 'FAILED';

    await completePrintJob(req.params.jobId, {
      status,
      errorMessage: error_message,
      triggeredBy: triggered_by || null,
      bookingId: booking_id,
    });

    // Broadcast ke dashboard admin supaya badge "struk tercetak" update real-time.
    const io = req.app.get('io');
    if (io) {
      io.emit('kitchen:receipt_printed', {
        job_id: req.params.jobId,
        booking_id,
        print_status: printLogStatus,
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[PRINT-QUEUE] gagal mencatat hasil cetak:', err);
    return res.status(500).json({ success: false, message: 'Gagal mencatat hasil cetak.' });
  }
});

module.exports = router;
