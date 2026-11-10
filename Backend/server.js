

// =====================================================
// Soroti Egg Hub - server.js (PARTS 1 + 2)
// Setup, database, public routes, accounts and role checks.
// =====================================================

// ---------- 1. SETTINGS AND LIBRARIES ----------
require('dotenv').config();              // loads the values in .env
const express = require('express');      // the web server framework
const path = require('path');
const helmet = require('helmet');        // adds safe HTTP headers
const mysql = require('mysql2/promise'); // talks to MySQL
const bcrypt = require('bcryptjs');              // scrambles passwords
const jwt = require('jsonwebtoken');             // login tokens
const rateLimit = require('express-rate-limit'); // blocks password guessing

const PORT = process.env.PORT || 3000;
const LOW_STOCK_THRESHOLD = 20;          // from the business plan
const MAX_TRAYS_PER_ORDER = 200;         // sanity limit for one order
const JWT_SECRET = process.env.JWT_SECRET;

const app = express();
app.use(helmet());
app.use(express.json());                 // lets us read JSON sent by the browser

// ---------- 2. DATABASE CONNECTION POOL ----------
// A pool keeps several connections open and reuses them.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

// ---------- 3. HELPER FUNCTIONS ----------

// Passes errors from async routes to the error handler at the bottom.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// The product we sell (for now, just one: a tray of 30 eggs).
async function getActiveProduct() {
  const [rows] = await pool.query(
    `SELECT id, name, tray_size, price_ugx
       FROM products WHERE is_active = 1 ORDER BY id LIMIT 1`
  );
  return rows[0] || null;
}

// Total trays on the shelf = sum of what remains in every batch.
async function getTraysInStock(productId) {
  const [rows] = await pool.query(
    `SELECT COALESCE(SUM(qty_remaining), 0) AS trays
       FROM inventory WHERE product_id = ?`,
    [productId]
  );
  return Number(rows[0].trays);
}

// Delivery fee depends on the number of trays; pickup is free.
// Returns the fee in UGX, or null if no tier matches.
async function calculateDeliveryFee(trays, fulfilment) {
  if (fulfilment === 'pickup') return 0;
  const [rows] = await pool.query(
    `SELECT fee_ugx FROM delivery_fee_tiers
      WHERE ? >= min_trays AND (max_trays IS NULL OR ? <= max_trays)
      LIMIT 1`,
    [trays, trays]
  );
  return rows.length ? rows[0].fee_ugx : null;
}

// Accepts only whole numbers from 1 to MAX_TRAYS_PER_ORDER.
function parseTrays(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TRAYS_PER_ORDER) return null;
  return n;
}

// ---------- 4. PUBLIC ROUTES (no login needed) ----------

// Quick check that the server and database are alive.
app.get('/api/health', asyncHandler(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: 'connected' });
}));

// Live stock and price, shown on the home page.
app.get('/api/stock', asyncHandler(async (req, res) => {
  const product = await getActiveProduct();
  if (!product) return res.status(404).json({ error: 'No product is available.' });

  const trays = await getTraysInStock(product.id);
  res.json({
    product,
    trays_available: trays,
    low_stock: trays <= LOW_STOCK_THRESHOLD,
    out_of_stock: trays === 0
  });
}));

// Delivery zones for the checkout dropdown.
app.get('/api/zones', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, name FROM delivery_zones WHERE is_active = 1 ORDER BY name'
  );
  res.json(rows);
}));

// The fee table (shown to visitors so prices are clear).
app.get('/api/fee-tiers', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT min_trays, max_trays, fee_ugx FROM delivery_fee_tiers ORDER BY min_trays'
  );
  res.json(rows);
}));

// Price calculator: /api/fees?trays=3&fulfilment=delivery
app.get('/api/fees', asyncHandler(async (req, res) => {
  const trays = parseTrays(req.query.trays);
  if (trays === null) {
    return res.status(400).json({
      error: `Trays must be a whole number from 1 to ${MAX_TRAYS_PER_ORDER}.`
    });
  }
  const fulfilment = req.query.fulfilment === 'pickup' ? 'pickup' : 'delivery';

  const product = await getActiveProduct();
  if (!product) return res.status(404).json({ error: 'No product is available.' });

  const deliveryFee = await calculateDeliveryFee(trays, fulfilment);
  if (deliveryFee === null) {
    return res.status(500).json({ error: 'No delivery fee is set for this size.' });
  }

  const subtotal = trays * product.price_ugx;
  res.json({
    trays,
    fulfilment,
    price_per_tray: product.price_ugx,
    subtotal,
    delivery_fee: deliveryFee,
    total: subtotal + deliveryFee
  });
}));

// ---------- 4b. ACCOUNTS: REGISTER, LOGIN, ROLE CHECKS (PART 2) ----------

const CUSTOMER_TYPES = ['rolex_maker', 'food_vendor', 'shop', 'household'];

// Used when a phone number is unknown, so login takes the same time
// whether or not the account exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// Accepts 0771234567, +256771234567 or 256771234567 and returns 0771234567.
// Returns null if it is not a valid Ugandan mobile number.
function normalizePhone(input) {
  let p = String(input || '').replace(/[\s-]/g, '');
  if (p.startsWith('+256')) p = '0' + p.slice(4);
  else if (p.startsWith('256')) p = '0' + p.slice(3);
  return /^07\d{8}$/.test(p) ? p : null;
}

// Only the fields the browser is allowed to see (never the password hash).
function publicUser(u) {
  return {
    id: u.id,
    full_name: u.full_name,
    phone: u.phone,
    role: u.role,
    customer_type: u.customer_type
  };
}

// The login token: it carries the user id and expires after 7 days.
function signToken(user) {
  return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
}

// Allow only 10 register/login attempts per 15 minutes from one address.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' }
});

// --- Middleware: runs BEFORE a route and can stop the request ---

// 1) "Is this person logged in?"
const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in first.' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }

  // Load the user fresh, so a deactivated account or a changed role
  // takes effect immediately.
  const [rows] = await pool.query(
    `SELECT id, full_name, phone, role, customer_type, is_active
       FROM users WHERE id = ?`,
    [payload.id]
  );
  if (!rows.length || !rows[0].is_active) {
    return res.status(401).json({ error: 'This account is not available.' });
  }
  req.user = rows[0];
  next();
});

// 2) "Does this person have the right role?"  Usage: requireRole('admin')
const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have permission to do that.' });
  }
  next();
};

// --- Routes ---

// Create a customer account. The role is ALWAYS 'customer' here, so nobody
// can make themselves an admin or rider through the public form.
app.post('/api/auth/register', authLimiter, asyncHandler(async (req, res) => {
  const { full_name, phone, password, customer_type } = req.body || {};

  const name = String(full_name || '').trim();
  const cleanPhone = normalizePhone(phone);
  const type = CUSTOMER_TYPES.includes(customer_type) ? customer_type : 'household';

  if (name.length < 2 || name.length > 100) {
    return res.status(400).json({ error: 'Please enter your full name.' });
  }
  if (!cleanPhone) {
    return res.status(400).json({ error: 'Enter a valid mobile number, e.g. 0771234567.' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be 8 to 72 characters.' });
  }

  const hash = await bcrypt.hash(password, 10);
  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO users (full_name, phone, password_hash, role, customer_type)
       VALUES (?, ?, ?, 'customer', ?)`,
      [name, cleanPhone, hash, type]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That phone number is already registered. Please log in.' });
    }
    throw err;
  }

  const user = { id: result.insertId, full_name: name, phone: cleanPhone,
                 role: 'customer', customer_type: type };
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

// Log in with phone + password.
app.post('/api/auth/login', authLimiter, asyncHandler(async (req, res) => {
  const { phone, password } = req.body || {};
  const cleanPhone = normalizePhone(phone);

  if (!cleanPhone || typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter your phone number and password.' });
  }

  const [rows] = await pool.query(
    `SELECT id, full_name, phone, password_hash, role, customer_type, is_active
       FROM users WHERE phone = ?`,
    [cleanPhone]
  );
  const user = rows[0];

  // Compare even when the user is missing, so timing reveals nothing.
  const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !passwordOk) {
    return res.status(401).json({ error: 'Phone number or password is incorrect.' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'This account has been deactivated.' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// Who am I? (the website calls this to restore a login)
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});


// ---------- 4c. PLACING AND CANCELLING ORDERS (PART 3) ----------

const crypto = require('crypto'); // built into Node, nothing to install

const PAYMENT_METHODS = ['mtn_momo', 'airtel_money', 'bank_card',
                         'payment_on_delivery', 'cash_on_delivery'];
// Advance methods are paid BEFORE handover and must be verified by the admin.
const ADVANCE_PAYMENT_METHODS = ['mtn_momo', 'airtel_money', 'bank_card'];

// Allow 30 new orders per hour from one address.
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many orders from this connection. Please try again later.' }
});

// An error we expect (wrong input, not enough stock) with an HTTP status code.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Sends expected errors to the browser; anything else goes to the central handler.
function replyWithError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  throw err;
}

// Runs several database steps as ONE unit: all succeed, or all are undone.
async function withTransaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Puts an order's trays back into the exact batches they were taken from.
// (Part 4 reuses this when the admin cancels an order.)
async function restoreStock(conn, orderId) {
  const [allocations] = await conn.query(
    `SELECT a.inventory_id, a.quantity
       FROM order_batch_allocations a
       JOIN order_items i ON i.id = a.order_item_id
      WHERE i.order_id = ?`,
    [orderId]
  );
  for (const a of allocations) {
    await conn.query(
      'UPDATE inventory SET qty_remaining = qty_remaining + ? WHERE id = ?',
      [a.quantity, a.inventory_id]
    );
  }
}

// ----- Place an order (customers only) -----
app.post('/api/orders', requireAuth, requireRole('customer'), orderLimiter,
  asyncHandler(async (req, res) => {
    const b = req.body || {};

    // 1) Check everything the customer sent.
    const trays = parseTrays(b.trays);
    if (trays === null) {
      return res.status(400).json({
        error: `Trays must be a whole number from 1 to ${MAX_TRAYS_PER_ORDER}.`
      });
    }
    if (b.fulfilment !== 'delivery' && b.fulfilment !== 'pickup') {
      return res.status(400).json({ error: 'Choose delivery or pickup.' });
    }
    const fulfilment = b.fulfilment;

    if (!PAYMENT_METHODS.includes(b.payment_method)) {
      return res.status(400).json({ error: 'Choose a payment method.' });
    }
    const method = b.payment_method;

    const contactPhone = normalizePhone(b.contact_phone || req.user.phone);
    if (!contactPhone) {
      return res.status(400).json({ error: 'Enter a valid mobile number, e.g. 0771234567.' });
    }

    let zoneId = null;
    let address = null;
    if (fulfilment === 'delivery') {
      const [zones] = await pool.query(
        'SELECT id FROM delivery_zones WHERE id = ? AND is_active = 1',
        [Number(b.zone_id)]
      );
      if (!zones.length) {
        return res.status(400).json({ error: 'Please choose your delivery zone.' });
      }
      zoneId = zones[0].id;

      address = String(b.delivery_address || '').trim();
      if (address.length < 5 || address.length > 255) {
        return res.status(400).json({
          error: 'Please describe where to deliver (street, landmark or shop name).'
        });
      }
    }

    // Mobile-money / card transaction ID (optional now, can be added later).
    let reference = null;
    if (b.payment_reference && ADVANCE_PAYMENT_METHODS.includes(method)) {
      reference = String(b.payment_reference).trim();
      if (!/^[A-Za-z0-9-]{4,60}$/.test(reference)) {
        return res.status(400).json({ error: 'The transaction ID looks wrong. Please check it.' });
      }
    }
    const paymentStatus =
      ADVANCE_PAYMENT_METHODS.includes(method) && reference ? 'awaiting_verification' : 'unpaid';

    // 2) The SERVER decides the price. Totals sent by the browser are ignored.
    const product = await getActiveProduct();
    if (!product) return res.status(404).json({ error: 'No product is available.' });

    const deliveryFee = await calculateDeliveryFee(trays, fulfilment);
    if (deliveryFee === null) {
      return res.status(500).json({ error: 'No delivery fee is set for this size.' });
    }
    const subtotal = trays * product.price_ugx;
    const total = subtotal + deliveryFee;

    // 3) Save the order and take the trays, all in ONE transaction.
    try {
      const order = await withTransaction(async (conn) => {
        // Lock the oldest batches first (FIFO). Two customers ordering at the
        // same moment have to wait their turn, so we can never oversell.
        const [batches] = await conn.query(
          `SELECT id, qty_remaining FROM inventory
            WHERE product_id = ? AND qty_remaining > 0
            ORDER BY received_at ASC, id ASC
            FOR UPDATE`,
          [product.id]
        );
        const available = batches.reduce((sum, bt) => sum + bt.qty_remaining, 0);
        if (available < trays) {
          throw new HttpError(409, available === 0
            ? 'Sorry, we are out of stock right now.'
            : `Sorry, only ${available} tray(s) are available right now.`);
        }

        // Insert with a temporary code, then build the real code from the id.
        const tempCode = 'TMP' + crypto.randomBytes(8).toString('hex');
        const [orderResult] = await conn.query(
          `INSERT INTO orders
             (order_code, customer_id, fulfilment, zone_id, delivery_address,
              contact_phone, subtotal_ugx, delivery_fee_ugx, total_ugx,
              payment_method, payment_reference, payment_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [tempCode, req.user.id, fulfilment, zoneId, address,
           contactPhone, subtotal, deliveryFee, total,
           method, reference, paymentStatus]
        );
        const orderId = orderResult.insertId;

        const day = new Date()
          .toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' })
          .replace(/-/g, '');
        const orderCode = `SEH-${day}-${String(orderId).padStart(4, '0')}`;
        await conn.query('UPDATE orders SET order_code = ? WHERE id = ?', [orderCode, orderId]);

        const [itemResult] = await conn.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price_ugx)
           VALUES (?, ?, ?, ?)`,
          [orderId, product.id, trays, product.price_ugx]
        );
        const itemId = itemResult.insertId;

        // FIFO: take from the oldest batch first, then the next, and so on.
        let remaining = trays;
        for (const batch of batches) {
          if (remaining === 0) break;
          const take = Math.min(batch.qty_remaining, remaining);
          await conn.query(
            'UPDATE inventory SET qty_remaining = qty_remaining - ? WHERE id = ?',
            [take, batch.id]
          );
          await conn.query(
            `INSERT INTO order_batch_allocations (order_item_id, inventory_id, quantity)
             VALUES (?, ?, ?)`,
            [itemId, batch.id, take]
          );
          remaining -= take;
        }

        await conn.query(
          `INSERT INTO status_history (order_id, old_status, new_status, changed_by)
           VALUES (?, NULL, 'pending', ?)`,
          [orderId, req.user.id]
        );

        return {
          order_code: orderCode,
          status: 'pending',
          fulfilment,
          trays,
          price_per_tray: product.price_ugx,
          subtotal,
          delivery_fee: deliveryFee,
          total,
          payment_method: method,
          payment_status: paymentStatus
        };
      });

      res.status(201).json(order);
    } catch (err) {
      return replyWithError(res, err);
    }
  })
);

// ----- Add or correct the mobile-money / card transaction ID later -----
app.post('/api/orders/:code/payment-reference', requireAuth, requireRole('customer'),
  asyncHandler(async (req, res) => {
    const reference = String((req.body || {}).payment_reference || '').trim();
    if (!/^[A-Za-z0-9-]{4,60}$/.test(reference)) {
      return res.status(400).json({ error: 'The transaction ID looks wrong. Please check it.' });
    }

    const [rows] = await pool.query(
      `SELECT id, status, payment_method, payment_status
         FROM orders WHERE order_code = ? AND customer_id = ?`,
      [req.params.code, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });

    const order = rows[0];
    if (!ADVANCE_PAYMENT_METHODS.includes(order.payment_method)) {
      return res.status(400).json({ error: 'This order is paid on delivery, so no ID is needed.' });
    }
    if (order.status === 'cancelled' || order.payment_status === 'paid') {
      return res.status(409).json({ error: 'The payment for this order can no longer be changed.' });
    }

    await pool.query(
      `UPDATE orders SET payment_reference = ?, payment_status = 'awaiting_verification'
        WHERE id = ?`,
      [reference, order.id]
    );
    res.json({ order_code: req.params.code, payment_status: 'awaiting_verification' });
  })
);

// ----- Cancel my order (only while it is still Pending and unpaid) -----
app.post('/api/orders/:code/cancel', requireAuth, requireRole('customer'),
  asyncHandler(async (req, res) => {
    try {
      await withTransaction(async (conn) => {
        const [rows] = await conn.query(
          `SELECT id, status, payment_status FROM orders
            WHERE order_code = ? AND customer_id = ? FOR UPDATE`,
          [req.params.code, req.user.id]
        );
        if (!rows.length) throw new HttpError(404, 'Order not found.');

        const order = rows[0];
        if (order.status !== 'pending') {
          throw new HttpError(409, 'Only pending orders can be cancelled. Please contact us.');
        }
        
        if (order.payment_status !== 'unpaid') {
           throw new HttpError(409, 'A payment has been recorded for this order, so please contact us to cancel it and arrange a refund.');
        }
        

        await restoreStock(conn, order.id);
        await conn.query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [order.id]);
        await conn.query(
          `INSERT INTO status_history (order_id, old_status, new_status, changed_by)
           VALUES (?, 'pending', 'cancelled', ?)`,
          [order.id, req.user.id]
        );
      });
      res.json({ order_code: req.params.code, status: 'cancelled' });
    } catch (err) {
      return replyWithError(res, err);
    }
  })
);

// ----- My orders (the last 50) -----
app.get('/api/orders/mine', requireAuth, requireRole('customer'),
  asyncHandler(async (req, res) => {
    const [orders] = await pool.query(
      `SELECT o.id, o.order_code, o.fulfilment, z.name AS zone, o.delivery_address,
              o.contact_phone, o.subtotal_ugx, o.delivery_fee_ugx, o.total_ugx,
              o.payment_method, o.payment_reference, o.payment_status,
              o.status, o.created_at
         FROM orders o
         LEFT JOIN delivery_zones z ON z.id = o.zone_id
        WHERE o.customer_id = ?
        ORDER BY o.id DESC
        LIMIT 50`,
      [req.user.id]
    );

    if (orders.length) {
      const [items] = await pool.query(
        `SELECT order_id, quantity, unit_price_ugx FROM order_items WHERE order_id IN (?)`,
        [orders.map((o) => o.id)]
      );
      for (const o of orders) {
        o.items = items.filter((i) => i.order_id === o.id);
        delete o.id; // the browser only needs the order code
      }
    }
    res.json(orders);
  })
);


// ---------- 4d. ADMIN AND RIDER ROUTES (PART 4) ----------

const ORDER_STATUSES = ['pending', 'processing', 'dispatched', 'delivered', 'cancelled'];
const PAYMENT_STATUSES = ['unpaid', 'awaiting_verification', 'paid', 'refunded'];

// Which status changes are allowed. Anything else is refused.
const ORDER_TRANSITIONS = {
  pending:    ['processing', 'cancelled'],
  processing: ['dispatched', 'cancelled'],
  dispatched: ['delivered'],
  delivered:  [],
  cancelled:  []
};

// ONE function changes an order's status for both admins and riders,
// so the rules cannot differ between the two.
async function changeOrderStatus(conn, code, newStatus, actor) {
  const [rows] = await conn.query(
    `SELECT id, status, fulfilment, rider_id, payment_method, payment_status
       FROM orders WHERE order_code = ? FOR UPDATE`,
    [code]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found.');
  const order = rows[0];

  if (actor.role === 'rider') {
    // A rider cannot even tell that other riders' orders exist.
    if (order.rider_id !== actor.id) throw new HttpError(404, 'Order not found.');
    if (newStatus !== 'dispatched' && newStatus !== 'delivered') {
      throw new HttpError(403, 'Riders can only mark orders Dispatched or Delivered.');
    }
  }

  if (!ORDER_TRANSITIONS[order.status].includes(newStatus)) {
    throw new HttpError(409, `An order that is ${order.status} cannot be changed to ${newStatus}.`);
  }

  if (newStatus === 'dispatched') {
    // Advance payments (MTN, Airtel, card) must be verified before handover.
    if (ADVANCE_PAYMENT_METHODS.includes(order.payment_method) && order.payment_status !== 'paid') {
      throw new HttpError(409, 'Payment must be verified before this order is dispatched.');
    }
    if (order.fulfilment === 'delivery' && !order.rider_id) {
      throw new HttpError(409, 'Assign a rider before dispatching this order.');
    }
  }

  // Pay-on-delivery and cash orders become paid when the customer receives them.
  let paymentStatus = order.payment_status;
  if (newStatus === 'delivered' && !ADVANCE_PAYMENT_METHODS.includes(order.payment_method)) {
    paymentStatus = 'paid';
  }

  // Cancelling puts the trays back into the batches they came from.
  if (newStatus === 'cancelled') await restoreStock(conn, order.id);

  await conn.query(
    'UPDATE orders SET status = ?, payment_status = ? WHERE id = ?',
    [newStatus, paymentStatus, order.id]
  );
  await conn.query(
    `INSERT INTO status_history (order_id, old_status, new_status, changed_by)
     VALUES (?, ?, ?, ?)`,
    [order.id, order.status, newStatus, actor.id]
  );
  return { order_code: code, status: newStatus, payment_status: paymentStatus };
}

// ===================== ADMIN ROUTES =====================
// Every route on this router needs a login AND the admin role.
const adminRouter = express.Router();
adminRouter.use(requireAuth, requireRole('admin'));

// ----- Dashboard: stock alert, order counts, money waiting -----
adminRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const product = await getActiveProduct();
  const trays = product ? await getTraysInStock(product.id) : 0;

  const [byStatus] = await pool.query('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
  const counts = { pending: 0, processing: 0, dispatched: 0, delivered: 0, cancelled: 0 };
  for (const r of byStatus) counts[r.status] = Number(r.n);

  const [[awaiting]] = await pool.query(
    `SELECT COUNT(*) AS n FROM orders
      WHERE payment_status = 'awaiting_verification' AND status <> 'cancelled'`
  );
  const [[refunds]] = await pool.query(
    `SELECT COUNT(*) AS n FROM orders
      WHERE status = 'cancelled' AND payment_status IN ('paid','awaiting_verification')`
  );
  const [[today]] = await pool.query(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_ugx), 0) AS sales
       FROM orders WHERE DATE(created_at) = CURDATE() AND status <> 'cancelled'`
  );

  res.json({
    stock: {
      trays_available: trays,
      low_stock: trays <= LOW_STOCK_THRESHOLD,
      threshold: LOW_STOCK_THRESHOLD,
      alert: trays <= LOW_STOCK_THRESHOLD
        ? `LOW STOCK: only ${trays} tray(s) left. Reorder now.`
        : null
    },
    orders: counts,
    payments_awaiting_verification: Number(awaiting.n),
    refunds_needed: Number(refunds.n),
    today: { orders: Number(today.orders), sales_ugx: Number(today.sales) }
  });
}));

// ----- All orders. Filters: ?status=active|pending|...  ?payment=...  ?refund=1 -----
adminRouter.get('/orders', asyncHandler(async (req, res) => {
  const where = [];
  const params = [];

  const s = req.query.status;
  if (s === 'active') where.push("o.status IN ('pending','processing','dispatched')");
  else if (ORDER_STATUSES.includes(s)) { where.push('o.status = ?'); params.push(s); }

  const p = req.query.payment;
  if (PAYMENT_STATUSES.includes(p)) { where.push('o.payment_status = ?'); params.push(p); }

  if (req.query.refund === '1') {
    where.push("o.status = 'cancelled' AND o.payment_status IN ('paid','awaiting_verification')");
  }

  const [orders] = await pool.query(
    `SELECT o.order_code, o.status, o.fulfilment, z.name AS zone, o.delivery_address,
            o.contact_phone, u.full_name AS customer_name, r.full_name AS rider_name,
            (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS trays,
            o.subtotal_ugx, o.delivery_fee_ugx, o.total_ugx,
            o.payment_method, o.payment_reference, o.payment_status, o.created_at,
            (o.status = 'cancelled' AND o.payment_status IN ('paid','awaiting_verification')) AS refund_needed
       FROM orders o
       JOIN users u ON u.id = o.customer_id
       LEFT JOIN users r ON r.id = o.rider_id
       LEFT JOIN delivery_zones z ON z.id = o.zone_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.id DESC
      LIMIT 100`,
    params
  );
  for (const o of orders) {
    o.trays = Number(o.trays);
    o.refund_needed = Boolean(o.refund_needed);
  }
  res.json(orders);
}));

// ----- Approve / reject a mobile-money or card payment, or mark a refund done -----
adminRouter.patch('/orders/:code/payment', asyncHandler(async (req, res) => {
  const action = (req.body || {}).action;
  if (!['approve', 'reject', 'refunded'].includes(action)) {
    return res.status(400).json({ error: 'Action must be approve, reject or refunded.' });
  }

  try {
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        `SELECT id, status, payment_method, payment_status
           FROM orders WHERE order_code = ? FOR UPDATE`,
        [req.params.code]
      );
      if (!rows.length) throw new HttpError(404, 'Order not found.');
      const o = rows[0];

      let newPaymentStatus;
      if (action === 'refunded') {
        if (o.status !== 'cancelled' || !['paid', 'awaiting_verification'].includes(o.payment_status)) {
          throw new HttpError(409, 'Only a cancelled order that had a payment can be marked refunded.');
        }
        newPaymentStatus = 'refunded';
      } else {
        if (o.status === 'cancelled') throw new HttpError(409, 'This order is cancelled.');
        if (!ADVANCE_PAYMENT_METHODS.includes(o.payment_method)) {
          throw new HttpError(400, 'This order is paid on delivery, so there is no payment to verify.');
        }
        if (o.payment_status !== 'awaiting_verification') {
          throw new HttpError(409, 'There is no payment waiting to be verified for this order.');
        }
        newPaymentStatus = action === 'approve' ? 'paid' : 'unpaid';
      }

      // Rejecting also clears the transaction ID so the customer can send the right one.
      await conn.query(
        `UPDATE orders SET payment_status = ?,
                payment_reference = IF(?, NULL, payment_reference)
          WHERE id = ?`,
        [newPaymentStatus, action === 'reject' ? 1 : 0, o.id]
      );
      return { order_code: req.params.code, payment_status: newPaymentStatus };
    });
    res.json(result);
  } catch (err) {
    return replyWithError(res, err);
  }
}));

// ----- Change an order's status (Pending > Processing > Dispatched > Delivered, or Cancelled) -----
adminRouter.patch('/orders/:code/status', asyncHandler(async (req, res) => {
  const newStatus = (req.body || {}).status;
  if (!ORDER_STATUSES.includes(newStatus)) {
    return res.status(400).json({ error: 'Choose a valid status.' });
  }
  try {
    const result = await withTransaction((conn) =>
      changeOrderStatus(conn, req.params.code, newStatus, req.user)
    );
    res.json(result);
  } catch (err) {
    return replyWithError(res, err);
  }
}));

// ----- Assign a rider to a delivery order -----
adminRouter.patch('/orders/:code/rider', asyncHandler(async (req, res) => {
  const riderId = Number((req.body || {}).rider_id);
  if (!Number.isInteger(riderId) || riderId < 1) {
    return res.status(400).json({ error: 'Choose a rider.' });
  }

  const [riders] = await pool.query(
    "SELECT id, full_name FROM users WHERE id = ? AND role = 'rider' AND is_active = 1",
    [riderId]
  );
  if (!riders.length) return res.status(400).json({ error: 'Choose an active rider.' });

  const [orders] = await pool.query(
    'SELECT id, status, fulfilment FROM orders WHERE order_code = ?',
    [req.params.code]
  );
  if (!orders.length) return res.status(404).json({ error: 'Order not found.' });
  const o = orders[0];

  if (o.fulfilment !== 'delivery') {
    return res.status(409).json({ error: 'Pickup orders do not need a rider.' });
  }
  if (!['pending', 'processing'].includes(o.status)) {
    return res.status(409).json({ error: 'A rider can only be assigned before the order is dispatched.' });
  }

  await pool.query('UPDATE orders SET rider_id = ? WHERE id = ?', [riderId, o.id]);
  res.json({ order_code: req.params.code, rider: riders[0].full_name });
}));

// ----- Stock: batches that still have trays, oldest first (the FIFO order) -----
adminRouter.get('/inventory', asyncHandler(async (req, res) => {
  const product = await getActiveProduct();
  if (!product) return res.status(404).json({ error: 'No product is available.' });

  const [batches] = await pool.query(
    `SELECT id, supplier, qty_received, qty_remaining, unit_cost_ugx, received_at
       FROM inventory
      WHERE product_id = ? AND qty_remaining > 0
      ORDER BY received_at ASC, id ASC`,
    [product.id]
  );
  const trays = await getTraysInStock(product.id);
  res.json({ trays_available: trays, low_stock: trays <= LOW_STOCK_THRESHOLD, batches });
}));

// ----- Receive a new batch of trays -----
adminRouter.post('/inventory/receive', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const supplier = String(b.supplier || '').trim();
  const trays = Number(b.trays);
  const cost = Number(b.unit_cost_ugx);

  if (supplier.length < 2 || supplier.length > 100) {
    return res.status(400).json({ error: 'Enter the supplier name.' });
  }
  if (!Number.isInteger(trays) || trays < 1 || trays > 5000) {
    return res.status(400).json({ error: 'Trays must be a whole number from 1 to 5000.' });
  }
  if (!Number.isInteger(cost) || cost < 0 || cost > 1000000) {
    return res.status(400).json({ error: 'Enter the cost per tray in UGX.' });
  }

  const product = await getActiveProduct();
  if (!product) return res.status(404).json({ error: 'No product is available.' });

  await pool.query(
    `INSERT INTO inventory (product_id, supplier, qty_received, qty_remaining, unit_cost_ugx)
     VALUES (?, ?, ?, ?, ?)`,
    [product.id, supplier, trays, trays, cost]
  );
  const total = await getTraysInStock(product.id);
  res.status(201).json({ received: trays, trays_available: total });
}));

// ----- Record breakage (or expired / correction) against one batch -----
adminRouter.post('/inventory/breakage', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const inventoryId = Number(b.inventory_id);
  const trays = Number(b.trays);
  const reason = b.reason || 'breakage';
  const note = String(b.note || '').trim().slice(0, 255) || null;

  if (!Number.isInteger(inventoryId) || inventoryId < 1) {
    return res.status(400).json({ error: 'Choose a batch.' });
  }
  if (!Number.isInteger(trays) || trays < 1) {
    return res.status(400).json({ error: 'Trays must be a whole number of 1 or more.' });
  }
  if (!['breakage', 'expired', 'correction'].includes(reason)) {
    return res.status(400).json({ error: 'Reason must be breakage, expired or correction.' });
  }

  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        'SELECT qty_remaining FROM inventory WHERE id = ? FOR UPDATE',
        [inventoryId]
      );
      if (!rows.length) throw new HttpError(404, 'Batch not found.');
      if (trays > rows[0].qty_remaining) {
        throw new HttpError(409, `That batch only has ${rows[0].qty_remaining} tray(s) left.`);
      }
      await conn.query(
        'UPDATE inventory SET qty_remaining = qty_remaining - ? WHERE id = ?',
        [trays, inventoryId]
      );
      await conn.query(
        `INSERT INTO stock_adjustments (inventory_id, quantity, reason, note, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [inventoryId, trays, reason, note, req.user.id]
      );
    });
    const product = await getActiveProduct();
    res.status(201).json({ removed: trays, trays_available: await getTraysInStock(product.id) });
  } catch (err) {
    return replyWithError(res, err);
  }
}));

// ----- People: list users (?role=customer|rider|admin), switch accounts on/off -----
adminRouter.get('/users', asyncHandler(async (req, res) => {
  const role = ['customer', 'rider', 'admin'].includes(req.query.role) ? req.query.role : null;
  const [users] = await pool.query(
    `SELECT id, full_name, phone, role, customer_type, is_active, created_at
       FROM users ${role ? 'WHERE role = ?' : ''}
      ORDER BY id DESC LIMIT 200`,
    role ? [role] : []
  );
  res.json(users);
}));

adminRouter.patch('/users/:id/active', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const active = (req.body || {}).is_active;
  if (!Number.isInteger(id) || typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Send is_active as true or false.' });
  }
  if (id === req.user.id) {
    return res.status(409).json({ error: 'You cannot deactivate your own account.' });
  }
  const [result] = await pool.query('UPDATE users SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'User not found.' });
  res.json({ id, is_active: active });
}));

// ----- Create a rider account -----
adminRouter.post('/riders', asyncHandler(async (req, res) => {
  const { full_name, phone, password } = req.body || {};
  const name = String(full_name || '').trim();
  const cleanPhone = normalizePhone(phone);

  if (name.length < 2 || name.length > 100) {
    return res.status(400).json({ error: 'Enter the rider\'s full name.' });
  }
  if (!cleanPhone) {
    return res.status(400).json({ error: 'Enter a valid mobile number, e.g. 0771234567.' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be 8 to 72 characters.' });
  }

  const hash = await bcrypt.hash(password, 10);
  try {
    const [result] = await pool.query(
      "INSERT INTO users (full_name, phone, password_hash, role) VALUES (?, ?, ?, 'rider')",
      [name, cleanPhone, hash]
    );
    res.status(201).json({ id: result.insertId, full_name: name, phone: cleanPhone, role: 'rider' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That phone number is already registered.' });
    }
    throw err;
  }
}));

app.use('/api/admin', adminRouter);

// ===================== RIDER ROUTES =====================
// A rider sees ONLY the orders assigned to them.
const riderRouter = express.Router();
riderRouter.use(requireAuth, requireRole('rider'));

riderRouter.get('/orders', asyncHandler(async (req, res) => {
  const [orders] = await pool.query(
    `SELECT o.order_code, o.status, o.fulfilment, z.name AS zone, o.delivery_address,
            o.contact_phone, u.full_name AS customer_name,
            (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS trays,
            o.total_ugx, o.payment_method, o.payment_status,
            CASE WHEN o.payment_status = 'paid' THEN 0 ELSE o.total_ugx END AS amount_to_collect
       FROM orders o
       JOIN users u ON u.id = o.customer_id
       LEFT JOIN delivery_zones z ON z.id = o.zone_id
      WHERE o.rider_id = ? AND o.status IN ('processing', 'dispatched')
      ORDER BY o.id ASC`,
    [req.user.id]
  );
  for (const o of orders) o.trays = Number(o.trays);
  res.json(orders);
}));

riderRouter.patch('/orders/:code/status', asyncHandler(async (req, res) => {
  const newStatus = (req.body || {}).status;
  if (newStatus !== 'dispatched' && newStatus !== 'delivered') {
    return res.status(400).json({ error: 'Status must be dispatched or delivered.' });
  }
  try {
    const result = await withTransaction((conn) =>
      changeOrderStatus(conn, req.params.code, newStatus, req.user)
    );
    res.json(result);
  } catch (err) {
    return replyWithError(res, err);
  }
}));

app.use('/api/rider', riderRouter);

// ---------- 5. FALLBACKS AND ERRORS ----------

// Unknown /api addresses get a JSON 404.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'That API address does not exist.' });
});

// Serve the website files from the frontend folder.
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Any unexpected error ends up here.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ---------- 6. START THE SERVER ----------
async function start() {
  if (!JWT_SECRET || JWT_SECRET.length < 16) {
    console.error('JWT_SECRET in .env is missing or too short (use 16+ characters).');
    process.exit(1);
  }
  try {
    await pool.query('SELECT 1');
    console.log('Database connected.');
  } catch (err) {
    console.error('Could not connect to the database:', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`SEH server running at http://localhost:${PORT}`);
  });
}
start();