-- =====================================================================
-- RM. SEGO ABANG — CONSOLIDATED DATABASE
-- PostgreSQL 14+
-- Satu file untuk fresh deployment: schema.sql
-- Semua perubahan Phase 1–5 + reservasi + remote preorder digabung di sini.
-- Jalankan file ini SEKALI pada database PostgreSQL kosong.
-- Akun OWNER/ADMIN dibuat oleh database/seed.js.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =========================
-- ENUMS
-- =========================
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('OWNER', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE table_status AS ENUM ('AVAILABLE', 'LOCKED', 'RESERVED', 'CONFIRMED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stock_status AS ENUM ('AVAILABLE', 'OUT_OF_STOCK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE printer_status AS ENUM ('SUCCESS', 'FAILED', 'RETRY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =========================
-- USERS
-- =========================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role user_role NOT NULL DEFAULT 'ADMIN',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- =========================
-- CATEGORIES
-- =========================
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_categories_display_order
  ON categories(display_order) WHERE is_active = TRUE;

-- =========================
-- MENUS
-- =========================
CREATE TABLE IF NOT EXISTS menus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  price NUMERIC(12,2) NOT NULL CHECK (price > 0),
  image_url TEXT,
  stock_status stock_status NOT NULL DEFAULT 'AVAILABLE',
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_menus_category ON menus(category_id);
CREATE INDEX IF NOT EXISTS idx_menus_stock_status
  ON menus(stock_status) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_menus_display
  ON menus(category_id, display_order) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_menus_is_available ON menus(is_available);

-- =========================
-- RESTAURANT TABLES
-- =========================
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_number VARCHAR(10) NOT NULL UNIQUE,
  capacity SMALLINT NOT NULL DEFAULT 4 CHECK (capacity > 0),
  zone VARCHAR(50),
  pos_x INTEGER NOT NULL DEFAULT 0,
  pos_y INTEGER NOT NULL DEFAULT 0,
  status table_status NOT NULL DEFAULT 'AVAILABLE',
  locked_until TIMESTAMPTZ,
  current_booking_id UUID,
  qr_token VARCHAR(80),
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tables_status ON restaurant_tables(status);
CREATE INDEX IF NOT EXISTS idx_tables_locked_until
  ON restaurant_tables(locked_until) WHERE status = 'LOCKED';
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_tables_qr_token
  ON restaurant_tables(qr_token) WHERE qr_token IS NOT NULL;
ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- =========================
-- RESERVATIONS
-- =========================
CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_code VARCHAR(24) NOT NULL UNIQUE,
  lookup_token VARCHAR(80),
  table_id UUID REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(30) NOT NULL,
  guest_count SMALLINT NOT NULL DEFAULT 1 CHECK (guest_count BETWEEN 1 AND 50),
  reservation_at TIMESTAMPTZ NOT NULL,
  duration_minutes SMALLINT NOT NULL DEFAULT 120 CHECK (duration_minutes BETWEEN 30 AND 360),
  notes VARCHAR(500),
  pre_order_notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CONFIRMED','ARRIVED','CANCELLED','COMPLETED','NO_SHOW')),
  confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_lookup_token
  ON reservations(lookup_token) WHERE lookup_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_at ON reservations(reservation_at);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
CREATE INDEX IF NOT EXISTS idx_reservations_table_at
  ON reservations(table_id, reservation_at);
CREATE INDEX IF NOT EXISTS idx_reservations_table_id ON reservations(table_id);

-- =========================
-- BOOKINGS / OPERATIONAL ORDERS
-- =========================
CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_code VARCHAR(40) NOT NULL UNIQUE,
  public_token VARCHAR(80),
  reservation_id UUID REFERENCES reservations(id) ON DELETE SET NULL,
  table_id UUID NOT NULL REFERENCES restaurant_tables(id) ON DELETE RESTRICT,
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(30) NOT NULL,
  guest_count SMALLINT NOT NULL DEFAULT 1 CHECK (guest_count BETWEEN 1 AND 50),
  total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
  status booking_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  payment_status VARCHAR(20) NOT NULL DEFAULT 'UNPAID',
  order_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  kitchen_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  qris_reference_note TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  cancelled_reason TEXT,
  served_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_public_token
  ON bookings(public_token) WHERE public_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_reservation_id
  ON bookings(reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_table ON bookings(table_id);
CREATE INDEX IF NOT EXISTS idx_bookings_pending_expires
  ON bookings(expires_at, status) WHERE status = 'PENDING_PAYMENT';
CREATE INDEX IF NOT EXISTS idx_bookings_created_date ON bookings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_order_status ON bookings(order_status);
CREATE INDEX IF NOT EXISTS idx_bookings_payment_status ON bookings(payment_status);
CREATE INDEX IF NOT EXISTS idx_bookings_kitchen_status ON bookings(kitchen_status);

ALTER TABLE restaurant_tables
  DROP CONSTRAINT IF EXISTS fk_tables_current_booking;
ALTER TABLE restaurant_tables
  ADD CONSTRAINT fk_tables_current_booking
  FOREIGN KEY (current_booking_id) REFERENCES bookings(id) ON DELETE SET NULL;

-- =========================
-- BOOKING ITEMS
-- =========================
CREATE TABLE IF NOT EXISTS booking_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  menu_id UUID REFERENCES menus(id) ON DELETE SET NULL,
  menu_name_snapshot VARCHAR(150) NOT NULL,
  price_snapshot NUMERIC(12,2) NOT NULL CHECK (price_snapshot > 0),
  quantity SMALLINT NOT NULL CHECK (quantity > 0),
  subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
  notes VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items(booking_id);

-- =========================
-- PAYMENTS
-- =========================
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  method VARCHAR(30) NOT NULL DEFAULT 'QRIS_STATIC',
  status payment_status NOT NULL DEFAULT 'PENDING',
  bank_reference VARCHAR(100),
  verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- =========================
-- RESERVATION ITEMS / REMOTE PREORDER
-- =========================
CREATE TABLE IF NOT EXISTS reservation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  menu_id UUID NOT NULL REFERENCES menus(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  notes TEXT,
  name_snapshot VARCHAR(150),
  price_snapshot NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reservation_items_reservation_id
  ON reservation_items(reservation_id);

-- =========================
-- NOTIFICATIONS
-- =========================
CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID REFERENCES reservations(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL,
  recipient VARCHAR(120),
  event VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_logs_reservation_id
  ON notification_logs(reservation_id);

-- =========================
-- AUDIT
-- =========================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(50),
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

-- =========================
-- PRINT JOBS (Railway -> local print agent)
-- =========================
CREATE TABLE IF NOT EXISTS print_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  job_type VARCHAR(30) NOT NULL DEFAULT 'KITCHEN',
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','CLAIMED','PRINTED','FAILED')),
  claimed_by VARCHAR(120),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_queue ON print_jobs(status, created_at);

-- =========================
-- PRINT LOGS
-- =========================
CREATE TABLE IF NOT EXISTS print_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status printer_status NOT NULL,
  error_message TEXT,
  raw_payload TEXT,
  printed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_print_logs_booking ON print_logs(booking_id);

-- =========================
-- SETTINGS
-- =========================
CREATE TABLE IF NOT EXISTS restaurant_settings (
  key VARCHAR(80) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  qris_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  qris_image_url TEXT
);

INSERT INTO restaurant_settings (key, value, qris_enabled) VALUES
  ('qris_static_image_url', '', FALSE),
  ('qris_bank_name', 'Belum dikonfigurasi', FALSE),
  ('table_lock_duration_minutes', '10', FALSE),
  ('kitchen_printer_ip', '192.168.1.50', FALSE),
  ('kitchen_printer_port', '9100', FALSE),
  ('restaurant_name', 'RM. Sego Abang Pendopo Wonomarto', FALSE),
  ('restaurant_tagline', 'Cita rasa Jawa, hangat di hati', FALSE),
  ('reservation_duration_minutes', '120', FALSE),
  ('reservation_open_time', '10:00', FALSE),
  ('reservation_close_time', '18:00', FALSE)
ON CONFLICT (key) DO NOTHING;

-- =========================
-- UPDATED_AT TRIGGERS
-- =========================
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at_users ON users;
CREATE TRIGGER set_updated_at_users BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_categories ON categories;
CREATE TRIGGER set_updated_at_categories BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_menus ON menus;
CREATE TRIGGER set_updated_at_menus BEFORE UPDATE ON menus
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_tables ON restaurant_tables;
CREATE TRIGGER set_updated_at_tables BEFORE UPDATE ON restaurant_tables
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_bookings ON bookings;
CREATE TRIGGER set_updated_at_bookings BEFORE UPDATE ON bookings
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_payments ON payments;
CREATE TRIGGER set_updated_at_payments BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_reservations ON reservations;
CREATE TRIGGER set_updated_at_reservations BEFORE UPDATE ON reservations
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- =========================
-- MENU AVAILABILITY COMPATIBILITY
-- stock_status = SOURCE OF TRUTH
-- =========================
CREATE OR REPLACE FUNCTION sync_menu_availability() RETURNS TRIGGER AS $$
BEGIN
  NEW.is_available := (NEW.stock_status = 'AVAILABLE');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_menu_availability ON menus;
CREATE TRIGGER trg_sync_menu_availability
BEFORE INSERT OR UPDATE OF stock_status ON menus
FOR EACH ROW EXECUTE FUNCTION sync_menu_availability();

-- =========================
-- INITIAL TABLES / CATEGORIES
-- =========================
INSERT INTO restaurant_tables (table_number, capacity, zone, pos_x, pos_y, qr_token)
VALUES
  ('A1', 4, 'Lesehan', 10, 20, encode(gen_random_bytes(30), 'hex')),
  ('A2', 4, 'Lesehan', 25, 20, encode(gen_random_bytes(30), 'hex')),
  ('A3', 2, 'Lesehan', 40, 20, encode(gen_random_bytes(30), 'hex')),
  ('B1', 6, 'Kursi', 10, 55, encode(gen_random_bytes(30), 'hex')),
  ('B2', 6, 'Kursi', 25, 55, encode(gen_random_bytes(30), 'hex')),
  ('VIP-1', 8, 'VIP', 72, 35, encode(gen_random_bytes(30), 'hex'))
ON CONFLICT (table_number) DO NOTHING;

INSERT INTO categories (name, description, display_order)
VALUES
  ('Wedangan', 'Minuman tradisional hangat & dingin', 1),
  ('Kudapan', 'Camilan pendamping wedangan', 2),
  ('Sego & Lauk', 'Menu utama nasi dan lauk pauk', 3)
ON CONFLICT (name) DO NOTHING;

-- =========================
-- BACKFILL / HARDENING
-- =========================
UPDATE menus
SET is_available = (stock_status = 'AVAILABLE')
WHERE is_available IS DISTINCT FROM (stock_status = 'AVAILABLE');

UPDATE reservations
SET lookup_token = encode(gen_random_bytes(24), 'hex')
WHERE lookup_token IS NULL;

UPDATE reservations
SET status = 'PENDING'
WHERE status IS NULL;

UPDATE reservation_items ri
SET name_snapshot = m.name,
    price_snapshot = m.price
FROM menus m
WHERE m.id = ri.menu_id
  AND (ri.name_snapshot IS NULL OR ri.price_snapshot IS NULL);

UPDATE bookings
SET public_token = encode(gen_random_bytes(24), 'hex')
WHERE public_token IS NULL;

UPDATE restaurant_tables
SET qr_token = encode(gen_random_bytes(30), 'hex')
WHERE qr_token IS NULL;

-- =========================
-- BASIC CONSISTENCY
-- =========================
UPDATE bookings b
SET payment_status = CASE
  WHEN p.status = 'VERIFIED' THEN 'PAID'
  WHEN p.status IN ('EXPIRED','REJECTED') THEN 'FAILED'
  ELSE 'UNPAID'
END
FROM payments p
WHERE p.booking_id = b.id;


-- =========================
-- PHASE 7: PAYMENT + WHATSAPP HARDENING
-- =========================
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider VARCHAR(40) NOT NULL DEFAULT 'MANUAL';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(120);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS qr_image_url TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS qr_payload TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS locked_amount NUMERIC(12,2);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_reference
  ON payments(provider, provider_reference) WHERE provider_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency
  ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_expires_at
  ON payments(expires_at) WHERE status='PENDING';

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(40) NOT NULL,
  event_id VARCHAR(160) NOT NULL,
  payload_hash VARCHAR(128) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED',
  error_message TEXT,
  UNIQUE(provider, event_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_received
  ON payment_webhook_events(received_at DESC);

ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS provider VARCHAR(40) NOT NULL DEFAULT 'LOG_ONLY';
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(160);
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS error_message TEXT;
CREATE INDEX IF NOT EXISTS idx_notification_logs_status
  ON notification_logs(status, created_at DESC);

-- Payment amount is always the booking snapshot. Keep a database-level invariant.
CREATE OR REPLACE FUNCTION sync_payment_locked_amount() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.locked_amount IS NULL THEN NEW.locked_amount := NEW.amount; END IF;
  IF NEW.locked_amount <> NEW.amount THEN
    RAISE EXCEPTION 'locked_amount tidak boleh berbeda dari amount';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sync_payment_locked_amount ON payments;
CREATE TRIGGER trg_sync_payment_locked_amount
BEFORE INSERT OR UPDATE OF amount, locked_amount ON payments
FOR EACH ROW EXECUTE FUNCTION sync_payment_locked_amount();

-- Ensure every payment row created by old versions also has a locked amount.
UPDATE payments SET locked_amount=amount WHERE locked_amount IS NULL;
UPDATE payments SET expires_at=b.expires_at
FROM bookings b WHERE b.id=payments.booking_id AND payments.expires_at IS NULL;

COMMIT;

-- =====================================================================
-- DEPLOYMENT:
--   1) Buat satu PostgreSQL database kosong.
--   2) Jalankan file ini SEKALI.
--   3) Jalankan: node database/seed.js
--   4) Isi environment variable SEED_OWNER_EMAIL dan SEED_OWNER_PASSWORD.
-- =====================================================================
