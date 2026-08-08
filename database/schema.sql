-- =====================================================================
-- RM. SEGO ABANG — SKEMA DATABASE (PostgreSQL 14+)
-- Sistem Reservasi Meja + QRIS Statis Manual + Live Table Locking
-- =====================================================================
-- Catatan desain:
-- 1. Tidak ada payment gateway pihak ketiga. Kolom `method` di tabel
--    payments selalu 'QRIS_STATIC' karena restoran hanya punya satu
--    QRIS statis resmi (BCA/Mandiri/BRI a.n. restoran).
-- 2. Penguncian meja (seat locking) murni berbasis kolom `locked_until`
--    pada tabel `restaurant_tables`, dieksekusi atomik lewat transaksi
--    + row lock (SELECT ... FOR UPDATE) supaya tidak terjadi race
--    condition saat dua pelanggan klik meja yang sama bersamaan.
-- 3. Role hanya dua: OWNER dan ADMIN. Tidak ada role tambahan supaya
--    logic otorisasi tetap sederhana dan mudah diaudit.
-- 4. Seed data akun & password ada di database/seed.js (bukan di sini).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- EXTENSIONS
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- untuk gen_random_uuid()

-- ---------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('OWNER', 'ADMIN');

CREATE TYPE table_status AS ENUM ('AVAILABLE', 'LOCKED', 'CONFIRMED');

CREATE TYPE booking_status AS ENUM (
    'PENDING_PAYMENT',  -- menunggu scan QRIS & verifikasi admin
    'CONFIRMED',        -- admin sudah konfirmasi dana masuk
    'EXPIRED',          -- lewat 10 menit, dibatalkan otomatis oleh cron
    'CANCELLED'         -- dibatalkan manual oleh admin/owner
);

CREATE TYPE stock_status AS ENUM ('AVAILABLE', 'OUT_OF_STOCK');

CREATE TYPE payment_status AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'REJECTED');

CREATE TYPE printer_status AS ENUM ('SUCCESS', 'FAILED', 'RETRY');

-- Status antrean cetak untuk Print Agent lokal (lihat backend/print-agent/).
-- QUEUED   -> baru dibuat, menunggu diambil agent.
-- PRINTED  -> agent berhasil mencetak.
-- FAILED   -> agent gagal mencetak (mis. printer offline/kertas habis).
CREATE TYPE print_job_status AS ENUM ('QUEUED', 'PRINTED', 'FAILED');

-- ---------------------------------------------------------------------
-- TABLE: users
-- Menyimpan akun internal staf: OWNER (pemilik, akses penuh) dan
-- ADMIN (kasir/pelayan, akses operasional harian saja).
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       VARCHAR(120)    NOT NULL,
    email           VARCHAR(150)    NOT NULL UNIQUE,
    password_hash   VARCHAR(255)    NOT NULL,
    role            user_role       NOT NULL DEFAULT 'ADMIN',
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_email ON users(email);

-- ---------------------------------------------------------------------
-- TABLE: categories
-- Kategori menu (mis. "Wedangan", "Kudapan", "Sego & Lauk").
-- Hanya OWNER yang boleh CRUD baris ini (dijaga di layer backend).
-- ---------------------------------------------------------------------
CREATE TABLE categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100)    NOT NULL,
    description     TEXT,
    display_order   INTEGER         NOT NULL DEFAULT 0,
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    UNIQUE (name)
);

CREATE INDEX idx_categories_display_order ON categories(display_order) WHERE is_active = TRUE;

-- ---------------------------------------------------------------------
-- TABLE: menus
-- Item menu individual. `stock_status` inilah yang dikontrol lewat
-- toggle switch instan di dashboard admin (ADMIN & OWNER boleh ubah).
-- ---------------------------------------------------------------------
CREATE TABLE menus (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id     UUID            NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    name            VARCHAR(150)    NOT NULL,
    description     TEXT,
    price           NUMERIC(12,2)   NOT NULL CHECK (price > 0),
    image_url       TEXT,
    stock_status    stock_status    NOT NULL DEFAULT 'AVAILABLE',
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    display_order   INTEGER         NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_menus_category ON menus(category_id);
CREATE INDEX idx_menus_stock_status ON menus(stock_status) WHERE is_active = TRUE;
CREATE INDEX idx_menus_display ON menus(category_id, display_order) WHERE is_active = TRUE;

-- ---------------------------------------------------------------------
-- TABLE: restaurant_tables
-- Denah meja fisik restoran. `status` + `locked_until` adalah jantung
-- dari fitur seat-locking real-time.
-- ---------------------------------------------------------------------
CREATE TABLE restaurant_tables (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_number        VARCHAR(10)     NOT NULL UNIQUE,
    capacity            SMALLINT        NOT NULL DEFAULT 4,
    zone                VARCHAR(50),
    pos_x               INTEGER         NOT NULL DEFAULT 0,
    pos_y               INTEGER         NOT NULL DEFAULT 0,
    status              table_status    NOT NULL DEFAULT 'AVAILABLE',
    locked_until        TIMESTAMPTZ,
    current_booking_id  UUID,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_tables_status ON restaurant_tables(status);
-- Composite index: cron cleaner & dashboard query paling sering
CREATE INDEX idx_tables_locked_until ON restaurant_tables(locked_until)
    WHERE status = 'LOCKED';

-- ---------------------------------------------------------------------
-- TABLE: bookings
-- Satu baris = satu transaksi pemesanan meja + makanan.
-- `expires_at` = waktu_pesan + 10 menit, dipakai cron job pembersih.
-- ---------------------------------------------------------------------
CREATE TABLE bookings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_code        VARCHAR(20)     NOT NULL UNIQUE,
    table_id            UUID            NOT NULL REFERENCES restaurant_tables(id) ON DELETE RESTRICT,
    customer_name       VARCHAR(120)    NOT NULL,
    customer_phone      VARCHAR(30)     NOT NULL,
    guest_count         SMALLINT        NOT NULL DEFAULT 1,
    total_amount        NUMERIC(12,2)   NOT NULL CHECK (total_amount >= 0),
    status              booking_status  NOT NULL DEFAULT 'PENDING_PAYMENT',
    qris_reference_note TEXT,
    expires_at          TIMESTAMPTZ     NOT NULL,
    confirmed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at        TIMESTAMPTZ,
    cancelled_reason    TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_table ON bookings(table_id);
-- Composite index untuk cron cleaner (query paling sering dipakai)
CREATE INDEX idx_bookings_pending_expires ON bookings(expires_at, status)
    WHERE status = 'PENDING_PAYMENT';
-- Index untuk filter dashboard riwayat transaksi (tanggal + status)
CREATE INDEX idx_bookings_created_date ON bookings(created_at DESC);

-- Tambahkan FK dari restaurant_tables ke bookings (circular reference)
ALTER TABLE restaurant_tables
    ADD CONSTRAINT fk_tables_current_booking
    FOREIGN KEY (current_booking_id) REFERENCES bookings(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- TABLE: booking_items
-- Rincian menu yang dipesan per booking. Harga & nama di-snapshot
-- supaya riwayat pesanan tidak berubah walau menu master diedit.
-- ---------------------------------------------------------------------
CREATE TABLE booking_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id          UUID            NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    menu_id             UUID            REFERENCES menus(id) ON DELETE SET NULL,
    menu_name_snapshot  VARCHAR(150)    NOT NULL,
    price_snapshot      NUMERIC(12,2)   NOT NULL CHECK (price_snapshot > 0),
    quantity            SMALLINT        NOT NULL CHECK (quantity > 0),
    subtotal            NUMERIC(12,2)   NOT NULL CHECK (subtotal >= 0),
    notes               VARCHAR(255),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_booking_items_booking ON booking_items(booking_id);

-- ---------------------------------------------------------------------
-- TABLE: payments
-- Rekaman verifikasi pembayaran QRIS statis.
-- ---------------------------------------------------------------------
CREATE TABLE payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      UUID            NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    amount          NUMERIC(12,2)   NOT NULL CHECK (amount >= 0),
    method          VARCHAR(30)     NOT NULL DEFAULT 'QRIS_STATIC',
    status          payment_status  NOT NULL DEFAULT 'PENDING',
    bank_reference  VARCHAR(100),
    verified_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    verified_at     TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_booking ON payments(booking_id);
CREATE INDEX idx_payments_status ON payments(status);

-- ---------------------------------------------------------------------
-- TABLE: print_logs
-- Audit trail setiap kali struk dapur dicetak.
-- ---------------------------------------------------------------------
CREATE TABLE print_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      UUID            NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    triggered_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    status          printer_status  NOT NULL,
    error_message   TEXT,
    raw_payload     TEXT,
    printed_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_print_logs_booking ON print_logs(booking_id);

-- ---------------------------------------------------------------------
-- TABLE: print_jobs
-- Antrean cetak yang dipoll oleh Print Agent lokal (proses kecil yang
-- jalan di komputer kasir/dapur restoran, di jaringan yang sama dengan
-- printer). Backend cloud TIDAK pernah konek langsung ke printer lagi
-- -- backend hanya menulis baris QUEUED di sini, lalu agent yang
-- mengambil, mencetak ke printer lokalnya, dan melaporkan hasilnya balik.
-- Lihat backend/print-agent/agent.js.
-- ---------------------------------------------------------------------
CREATE TABLE print_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      UUID            NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    triggered_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    is_reprint      BOOLEAN         NOT NULL DEFAULT FALSE,
    payload         JSONB           NOT NULL, -- snapshot struk: kode booking, meja, item, dll
    status          print_job_status NOT NULL DEFAULT 'QUEUED',
    error_message   TEXT,
    claimed_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_print_jobs_status ON print_jobs(status, created_at) WHERE status = 'QUEUED';
CREATE INDEX idx_print_jobs_booking ON print_jobs(booking_id);

-- ---------------------------------------------------------------------
-- TABLE: refresh_tokens
-- Menyimpan HASH (bukan token mentah) dari refresh token yang aktif,
-- supaya access token JWT bisa berumur pendek (2 jam) tanpa memaksa
-- staf login ulang terus-menerus, dan supaya sesi bisa dicabut
-- (logout / reset password) dari sisi server.
-- ---------------------------------------------------------------------
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255)    NOT NULL UNIQUE,
    user_agent      TEXT,
    ip_address      VARCHAR(64),
    expires_at      TIMESTAMPTZ     NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- TABLE: audit_logs
-- Jejak audit aktivitas staf: login (sukses/gagal), konfirmasi
-- pembayaran, pembatalan booking, perubahan menu/kategori, manajemen
-- akun staf. Terpisah dari print_logs (yang khusus struk dapur).
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    user_email      VARCHAR(150), -- disimpan juga sebagai snapshot (jaga-jaga user dihapus)
    action          VARCHAR(80)     NOT NULL, -- mis. 'LOGIN_SUCCESS', 'BOOKING_CONFIRMED'
    entity_type     VARCHAR(50),               -- mis. 'booking', 'menu', 'user'
    entity_id       UUID,
    ip_address      VARCHAR(64),
    metadata        JSONB,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);

-- ---------------------------------------------------------------------
-- TABLE: restaurant_settings
-- Konfigurasi umum: gambar QRIS statis, nama bank, durasi lock, dll.
-- ---------------------------------------------------------------------
CREATE TABLE restaurant_settings (
    key             VARCHAR(80)     PRIMARY KEY,
    value           TEXT            NOT NULL,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- Seed default settings
INSERT INTO restaurant_settings (key, value) VALUES
    ('qris_static_image_url', '/assets/qris/qris-sego-abang.png'),
    ('qris_bank_name', 'BCA - RM. Sego Abang Pendopo Wonomarto'),
    ('table_lock_duration_minutes', '10'),
    ('kitchen_printer_ip', '192.168.1.50'),
    ('kitchen_printer_port', '9100'),
    ('restaurant_name', 'RM. Sego Abang Pendopo Wonomarto'),
    ('restaurant_tagline', 'Cita rasa Jawa, hangat di hati');

-- ---------------------------------------------------------------------
-- TRIGGER: auto-update kolom updated_at
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_users BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at_categories BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at_menus BEFORE UPDATE ON menus
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at_tables BEFORE UPDATE ON restaurant_tables
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at_bookings BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at_payments BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------------------------------------------------------------------
-- SEED DATA TABEL (tanpa akun user — akun dibuat via database/seed.js)
-- ---------------------------------------------------------------------
INSERT INTO restaurant_tables (table_number, capacity, zone, pos_x, pos_y) VALUES
    ('A1', 4, 'Lesehan', 10, 20),
    ('A2', 4, 'Lesehan', 25, 20),
    ('A3', 2, 'Lesehan', 40, 20),
    ('B1', 6, 'Kursi', 10, 55),
    ('B2', 6, 'Kursi', 25, 55),
    ('VIP-1', 8, 'VIP', 72, 35);

INSERT INTO categories (name, description, display_order) VALUES
    ('Wedangan', 'Minuman tradisional hangat & dingin', 1),
    ('Kudapan', 'Camilan pendamping wedangan', 2),
    ('Sego & Lauk', 'Menu utama nasi dan lauk pauk', 3);

COMMIT;
