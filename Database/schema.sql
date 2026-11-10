
-- =====================================================
-- Soroti Egg Hub (SEH) - database schema
-- Run this once in phpMyAdmin (SQL tab).
-- WARNING: the first line deletes and recreates ONLY the
-- soroti_egg_hub database, so re-running it resets our data.
-- =====================================================

DROP DATABASE IF EXISTS soroti_egg_hub;
CREATE DATABASE soroti_egg_hub
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE soroti_egg_hub;

-- -----------------------------------------------------
-- 1. users: customers, riders and admins share one table.
--    The "role" column decides what each person may do (RBAC).
-- -----------------------------------------------------
CREATE TABLE users (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name      VARCHAR(100) NOT NULL,
  phone          VARCHAR(15)  NOT NULL UNIQUE,      -- used to log in
  password_hash  VARCHAR(255) NOT NULL,             -- never the real password
  role           ENUM('customer','rider','admin') NOT NULL DEFAULT 'customer',
  customer_type  ENUM('rolex_maker','food_vendor','shop','household')
                 NOT NULL DEFAULT 'household',
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 2. delivery_zones: the Soroti areas in the checkout dropdown.
-- -----------------------------------------------------
CREATE TABLE delivery_zones (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(60) NOT NULL UNIQUE,
  is_active  TINYINT(1)  NOT NULL DEFAULT 1
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 3. products: what we sell. The price lives here, not in code,
--    so changing it later (Year 2: 16,800) is one UPDATE.
-- -----------------------------------------------------
CREATE TABLE products (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  tray_size   INT UNSIGNED NOT NULL DEFAULT 30,     -- eggs per tray
  price_ugx   INT UNSIGNED NOT NULL,                -- price per tray
  is_active   TINYINT(1)   NOT NULL DEFAULT 1
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 4. delivery_fee_tiers: fee depends on trays in the order.
--    max_trays NULL means "and above" (the 5+ tier).
-- -----------------------------------------------------
CREATE TABLE delivery_fee_tiers (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  min_trays  INT UNSIGNED NOT NULL,
  max_trays  INT UNSIGNED NULL,
  fee_ugx    INT UNSIGNED NOT NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 5. inventory: one row per RECEIVED BATCH of trays.
--    FIFO = we always take from the oldest received_at first.
-- -----------------------------------------------------
CREATE TABLE inventory (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id     INT UNSIGNED NOT NULL,
  supplier       VARCHAR(100) NOT NULL,
  qty_received   INT UNSIGNED NOT NULL,
  qty_remaining  INT UNSIGNED NOT NULL,             -- goes down as orders take trays
  unit_cost_ugx  INT UNSIGNED NOT NULL,             -- what we paid per tray
  received_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_inventory_product
    FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT chk_inventory_qty CHECK (qty_remaining <= qty_received),
  INDEX idx_inventory_fifo (product_id, received_at)
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 6. orders: one row per customer order.
--    Totals are saved at order time so history never changes
--    even if prices change later.
-- -----------------------------------------------------
CREATE TABLE orders (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_code         VARCHAR(20)  NOT NULL UNIQUE,  -- e.g. SEH-20261102-0001
  customer_id        INT UNSIGNED NOT NULL,
  rider_id           INT UNSIGNED NULL,             -- set when admin assigns a rider
  fulfilment         ENUM('delivery','pickup') NOT NULL,
  zone_id            INT UNSIGNED NULL,             -- only for delivery
  delivery_address   VARCHAR(255) NULL,             -- landmark / street, only for delivery
  contact_phone      VARCHAR(15)  NOT NULL,
  subtotal_ugx       INT UNSIGNED NOT NULL,         -- trays x price
  delivery_fee_ugx   INT UNSIGNED NOT NULL DEFAULT 0,
  total_ugx          INT UNSIGNED NOT NULL,
  payment_method     ENUM('mtn_momo','airtel_money','bank_card',
                          'payment_on_delivery','cash_on_delivery') NOT NULL,
  payment_reference  VARCHAR(60)  NULL,             -- transaction ID typed by customer
  payment_status     ENUM('unpaid','awaiting_verification','paid','refunded')
                     NOT NULL DEFAULT 'unpaid',
  status             ENUM('pending','processing','dispatched','delivered','cancelled')
                     NOT NULL DEFAULT 'pending',
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                     ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES users(id),
  CONSTRAINT fk_orders_rider    FOREIGN KEY (rider_id)    REFERENCES users(id),
  CONSTRAINT fk_orders_zone     FOREIGN KEY (zone_id)     REFERENCES delivery_zones(id),
  INDEX idx_orders_status (status),
  INDEX idx_orders_customer (customer_id)
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 7. order_items: what was in each order.
--    unit_price_ugx is copied from the product at order time.
-- -----------------------------------------------------
CREATE TABLE order_items (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id        INT UNSIGNED NOT NULL,
  product_id      INT UNSIGNED NOT NULL,
  quantity        INT UNSIGNED NOT NULL,
  unit_price_ugx  INT UNSIGNED NOT NULL,
  CONSTRAINT fk_items_order   FOREIGN KEY (order_id)   REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 8. order_batch_allocations: records WHICH batches an order took
--    trays from, so a cancelled order can put them back correctly.
-- -----------------------------------------------------
CREATE TABLE order_batch_allocations (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_item_id INT UNSIGNED NOT NULL,
  inventory_id  INT UNSIGNED NOT NULL,
  quantity      INT UNSIGNED NOT NULL,
  CONSTRAINT fk_alloc_item      FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_alloc_inventory FOREIGN KEY (inventory_id)  REFERENCES inventory(id)
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 9. stock_adjustments: breakage log and corrections.
-- -----------------------------------------------------
CREATE TABLE stock_adjustments (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  inventory_id  INT UNSIGNED NOT NULL,
  quantity      INT UNSIGNED NOT NULL,              -- trays removed
  reason        ENUM('breakage','expired','correction') NOT NULL,
  note          VARCHAR(255) NULL,
  created_by    INT UNSIGNED NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_adj_inventory FOREIGN KEY (inventory_id) REFERENCES inventory(id),
  CONSTRAINT fk_adj_user      FOREIGN KEY (created_by)   REFERENCES users(id)
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 10. status_history: who changed an order's status and when.
-- -----------------------------------------------------
CREATE TABLE status_history (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id    INT UNSIGNED NOT NULL,
  old_status  VARCHAR(20) NULL,
  new_status  VARCHAR(20) NOT NULL,
  changed_by  INT UNSIGNED NOT NULL,
  changed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hist_order FOREIGN KEY (order_id)   REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_hist_user  FOREIGN KEY (changed_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- =====================================================
-- SEED DATA (starting values from the business plan)
-- =====================================================

INSERT INTO delivery_zones (name) VALUES
  ('Main Market'), ('Camp Swahili'), ('Pamba'),
  ('Kichinjaji'), ('Madera'), ('Senior Quarters');

INSERT INTO products (name, tray_size, price_ugx)
VALUES ('Fresh Table Eggs (Tray of 30)', 30, 16000);

INSERT INTO delivery_fee_tiers (min_trays, max_trays, fee_ugx) VALUES
  (1, 2,    4000),
  (3, 4,    3000),
  (5, NULL, 2000);

-- Opening stock: 60 trays bought at UGX 13,000 each
INSERT INTO inventory (product_id, supplier, qty_received, qty_remaining, unit_cost_ugx)
VALUES (1, 'Opening stock', 60, 60, 13000);

