-- =====================================================================
-- MIGRASI 001 — Print Agent + Refresh Token + Audit Log
-- =====================================================================
-- AMAN dijalankan di database Railway yang SUDAH ADA DATANYA.
-- TIDAK menyentuh/menghapus tabel lama (users, bookings, menus, dll)
-- sama sekali — hanya MENAMBAH 3 tabel baru + 1 enum baru.
--
-- Semua statement pakai penjagaan "kalau belum ada" (idempotent), jadi
-- aman juga dijalankan berkali-kali kalau tidak sengaja ke-run ulang.
--
-- CARA JALANKAN (pilih salah satu):
--
--   A) Railway CLI (paling gampang):
--      railway run --service <nama-service-backend> \
--        psql "$DATABASE_URL" -f database/migrations/001_print_agent_refresh_audit.sql
--
--   B) psql manual dari komputer kamu (ambil DATABASE_URL dari
--      Railway dashboard -> Postgres plugin -> tab "Connect"):
--      psql "postgresql://user:pass@host:port/db" \
--        -f database/migrations/001_print_agent_refresh_audit.sql
--
--   C) Railway dashboard -> Postgres plugin -> tab "Query" -> paste isi
--      file ini -> Run.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ENUM: print_job_status (dipakai tabel print_jobs)
-- CREATE TYPE tidak punya IF NOT EXISTS, jadi dicek manual dulu.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'print_job_status') THEN
    CREATE TYPE print_job_status AS ENUM ('QUEUED', 'PRINTED', 'FAILED');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- TABLE: print_jobs — antrean cetak untuk Print Agent lokal
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      UUID            NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    triggered_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    is_reprint      BOOLEAN         NOT NULL DEFAULT FALSE,
    payload         JSONB           NOT NULL,
    status          print_job_status NOT NULL DEFAULT 'QUEUED',
    error_message   TEXT,
    claimed_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status, created_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS idx_print_jobs_booking ON print_jobs(booking_id);

-- ---------------------------------------------------------------------
-- TABLE: refresh_tokens
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255)    NOT NULL UNIQUE,
    user_agent      TEXT,
    ip_address      VARCHAR(64),
    expires_at      TIMESTAMPTZ     NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- TABLE: audit_logs
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    user_email      VARCHAR(150),
    action          VARCHAR(80)     NOT NULL,
    entity_type     VARCHAR(50),
    entity_id       UUID,
    ip_address      VARCHAR(64),
    metadata        JSONB,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

COMMIT;

-- ---------------------------------------------------------------------
-- VERIFIKASI — jalankan manual setelah migrasi untuk memastikan berhasil
-- dan data lama tetap utuh:
--
--   SELECT COUNT(*) FROM users;              -- harus SAMA seperti sebelum migrasi
--   SELECT COUNT(*) FROM bookings;            -- harus SAMA seperti sebelum migrasi
--   SELECT table_name FROM information_schema.tables
--     WHERE table_name IN ('print_jobs','refresh_tokens','audit_logs');
--     -- harus muncul 3 baris (tabel baru berhasil dibuat)
-- ---------------------------------------------------------------------
