

// Soroti Egg Hub - app.js (complete file)
'use strict';

const $ = (selector) => document.querySelector(selector);
const money = (n) => 'UGX ' + Number(n).toLocaleString('en-US');
const MAX_TRAYS = 200; // same limit as the server
const PACKS = [1, 2, 3];

const PAY_METHODS = [
  { id: 'mtn_momo', name: 'MTN Mobile Money', note: 'Send the money, then enter the transaction ID.', advance: true },
  { id: 'airtel_money', name: 'Airtel Money', note: 'Send the money, then enter the transaction ID.', advance: true },
  { id: 'bank_card', name: 'Bank card', note: 'Pay by card, then enter your payment reference.', advance: true },
  { id: 'payment_on_delivery', name: 'Payment on delivery', note: 'Pay by mobile money when you receive your eggs.', advance: false },
  { id: 'cash_on_delivery', name: 'Cash on delivery', note: 'Pay cash when you receive your eggs.', advance: false }
];

// ===== PAYMENT NUMBERS: put your merchant numbers inside the quotes =====
const PAY_TO = { mtn_momo: '', airtel_money: '', bank_card: '' };

const state = { stock: 0, method: 'cash_on_delivery', fulfilment: 'delivery' };
const AUTH = { mode: 'login' };

// ---------- Red banner for problems ----------
function showBanner(text) {
  const b = $('#banner');
  b.textContent = text;
  b.hidden = false;
}
const OFFLINE_MESSAGE = 'The page cannot reach the shop server. In the backend folder run "npm run dev", then open http://localhost:3000 (not Live Server).';
window.addEventListener('error', (e) => showBanner('The page hit an error: ' + e.message));
window.addEventListener('unhandledrejection', (e) =>
  showBanner('The page hit an error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));

// ---------- Talking to the server ----------
async function request(path, options) {
  let res;
  try {
    res = await fetch('https://soroti-egg-hub-1.onrender.com/api' + path, options);
  } catch (err) {
    throw new Error('Cannot reach the shop server.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}
const api = (path) => request(path);
const post = (path, body, token) => request(path, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});

// ---------- Small message at the bottom of the screen ----------
let toastTimer;
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- Pages inside the site ----------
const VIEWS = ['home', 'about', 'stations', 'cart'];
function route() {
  const hash = location.hash.replace('#', '') || 'home';
  const view = VIEWS.includes(hash) ? hash : 'home';
  VIEWS.forEach((v) => { $('#view-' + v).hidden = v !== view; });
  const current = hash === 'product' ? 'product' : view;
  document.querySelectorAll('[data-view]').forEach((a) => {
    if (a.dataset.view === current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (hash !== 'product') window.scrollTo(0, 0);
  if (view === 'cart') openCart();
}
window.addEventListener('hashchange', route);

// ---------- Cart (kept in this browser) ----------
function getCart() {
  try {
    const c = JSON.parse(localStorage.getItem('seh_cart'));
    const t = Number(c && c.trays);
    return { trays: Number.isInteger(t) && t > 0 ? Math.min(t, MAX_TRAYS) : 0 };
  } catch (err) {
    return { trays: 0 };
  }
}
function saveCart(cart) {
  try { localStorage.setItem('seh_cart', JSON.stringify(cart)); } catch (err) { /* ignore */ }
}
function showCartCount() {
  const n = getCart().trays;
  $('#cartBadge').textContent = n;
  $('#cartBadge').hidden = n === 0;
}

// ---------- Stock, prices and delivery areas from the server ----------
function setChip(stateName, text) {
  const chip = $('#stockChip');
  chip.dataset.state = stateName;
  chip.textContent = text;
}

async function refreshStock() {
  const s = await api('/stock');
  state.stock = s.trays_available;
  return s;
}

async function loadProducts() {
  try {
    const [s, ...fees] = await Promise.all([
      refreshStock(),
      ...PACKS.map((n) => api(`/fees?trays=${n}&fulfilment=delivery`))
    ]);
    const stock = s.trays_available;
    if (s.out_of_stock) setChip('out', 'Out of stock for now');
    else if (s.low_stock) setChip('low', `Only ${stock} ${stock === 1 ? 'tray' : 'trays'} left`);
    else setChip('ok', `${stock} trays in stock`);

    PACKS.forEach((n, i) => {
      $('#price' + n).textContent = money(fees[i].subtotal);
      $('#fee' + n).textContent = `+ ${money(fees[i].delivery_fee)} delivery, or free pickup`;
      const short = stock < n;
      document.querySelector(`[data-add="${n}"]`).disabled = short;
      $('#avail' + n).textContent = short ? (stock === 0 ? 'Out of stock' : `Only ${stock} left`) : '';
    });
  } catch (err) {
    setChip('out', 'Stock is not available right now');
    for (const n of PACKS) {
      $('#price' + n).textContent = '-';
      $('#fee' + n).textContent = 'Prices could not be loaded';
    }
    showBanner(OFFLINE_MESSAGE);
  }
}

async function loadZones() {
  const list = $('#zoneList');
  list.replaceChildren();
  try {
    const zones = await api('/zones');
    for (const z of zones) {
      const li = document.createElement('li');
      li.textContent = z.name;
      list.appendChild(li);
      const opt = document.createElement('option');
      opt.value = z.id;
      opt.textContent = z.name;
      $('#cZone').appendChild(opt);
    }
  } catch (err) {
    const li = document.createElement('li');
    li.textContent = 'Delivery areas could not be loaded';
    list.appendChild(li);
  }
}

// ---------- Tray pictures: your photo, or a drawn tray if the photo is missing ----------
function drawArt(n) {
  const stack = document.createElement('div');
  stack.className = 'stack';
  stack.style.setProperty('--n', n);
  for (let k = 0; k < n; k++) {
    const tray = document.createElement('div');
    tray.className = 'mini';
    tray.style.setProperty('--k', k);
    tray.innerHTML = '<i></i>'.repeat(30);
    stack.appendChild(tray);
  }
  return stack;
}
function photoFor(n) {
  const img = new Image();
  img.alt = `${n} ${n === 1 ? 'tray' : 'trays'} of 30 eggs`;
  img.loading = 'lazy';
  img.addEventListener('error', () => img.replaceWith(drawArt(n)));
  img.src = `images/tray-${n}.jpg`;
  return img;
}

// ---------- Product cards ----------
function renderCards() {
  const grid = $('#productGrid');
  grid.replaceChildren();
  for (const n of PACKS) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.innerHTML =
      '<article class="product"><div class="photo"></div><div class="info">' +
      `<h3>${n} ${n === 1 ? 'tray' : 'trays'}</h3>` +
      `<p class="muted">${n * 30} eggs</p>` +
      `<p class="price" id="price${n}">...</p>` +
      `<p class="muted" id="fee${n}"></p>` +
      `<p class="avail" id="avail${n}"></p>` +
      `<button class="btn btn-primary" type="button" data-add="${n}" disabled>Add to cart</button>` +
      '</div></article>';
    slot.querySelector('.photo').appendChild(photoFor(n));
    grid.appendChild(slot);
  }
}

$('#productGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  const n = Number(btn.dataset.add);
  const cart = getCart();
  if (cart.trays + n > state.stock) {
    toast(`Only ${state.stock} ${state.stock === 1 ? 'tray is' : 'trays are'} in stock, and you already have ${cart.trays} in your cart.`);
    return;
  }
  cart.trays += n;
  saveCart(cart);
  showCartCount();
  toast(`${n} ${n === 1 ? 'tray' : 'trays'} added. Open Cart to check out.`);
});

// ---------- Search ----------
$('#search').addEventListener('input', (e) => {
  if ($('#view-home').hidden) location.hash = '#product';
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('.slot').forEach((slot) => {
    const match = !q || slot.textContent.toLowerCase().includes(q);
    slot.hidden = !match;
    if (match) shown++;
  });
  $('#noMatch').hidden = shown !== 0;
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.toLowerCase();
  if (/station|pickup/.test(q)) location.hash = '#stations';
  else if (/deliver|area|zone/.test(q)) $('#areas').scrollIntoView();
});

// ===== Cart page and checkout =====
let totalsRequest = 0;

function selectedMethod() {
  return PAY_METHODS.find((m) => m.id === state.method);
}

function renderPay() {
  const box = $('#payOptions');
  box.replaceChildren();
  for (const m of PAY_METHODS) {
    const label = document.createElement('label');
    label.className = 'pay-opt';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'pay';
    input.value = m.id;
    input.checked = m.id === state.method;
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = m.name;
    const small = document.createElement('small');
    small.textContent = m.note;
    text.append(strong, small);
    label.append(input, text);
    box.appendChild(label);
  }
  showRefBox();
}

function showRefBox() {
  const m = selectedMethod();
  $('#refBox').hidden = !m.advance;
  const to = PAY_TO[m.id];
  $('#refHint').textContent = (to ? `Pay to ${to}, then enter the transaction ID below. ` : 'Pay using the details we give you, then enter the transaction ID below. ') +
    'Your order is released once we confirm the payment.';
}

function setFulfilment(mode) {
  state.fulfilment = mode;
  $('#cDelivery').setAttribute('aria-pressed', String(mode === 'delivery'));
  $('#cPickup').setAttribute('aria-pressed', String(mode === 'pickup'));
  $('#deliveryFields').hidden = mode !== 'delivery';
  $('#pickupNote').hidden = mode !== 'pickup';
  updateTotals();
}

async function updateTotals() {
  const cart = getCart();
  if (!cart.trays) return;
  const mine = ++totalsRequest;
  const error = $('#coError');
  const button = $('#placeOrder');
  try {
    const f = await api(`/fees?trays=${cart.trays}&fulfilment=${state.fulfilment}`);
    if (mine !== totalsRequest) return;
    $('#sEggsLabel').textContent = `Eggs (${f.trays} ${f.trays === 1 ? 'tray' : 'trays'})`;
    $('#sEggs').textContent = money(f.subtotal);
    $('#sFee').textContent = f.delivery_fee === 0 ? 'Free' : money(f.delivery_fee);
    $('#sTotal').textContent = money(f.total);
    const short = cart.trays > state.stock;
    error.textContent = short ? `Only ${state.stock} ${state.stock === 1 ? 'tray is' : 'trays are'} in stock. Please reduce your order.` : '';
    button.disabled = short;
  } catch (err) {
    if (mine === totalsRequest) {
      error.textContent = err.message;
      button.disabled = true;
    }
  }
}

function renderCart() {
  const cart = getCart();
  const empty = cart.trays === 0;
  $('#cartEmpty').hidden = !empty;
  $('#cartBody').hidden = empty;
  if (empty) return;
  $('#cartCount').textContent = cart.trays;
  const session = getSession();
  if (session && !$('#cPhone').value) $('#cPhone').value = session.user.phone;
  updateTotals();
}

async function openCart() {
  $('#orderDone').hidden = true;
  try { await refreshStock(); } catch (err) { showBanner(OFFLINE_MESSAGE); }
  renderCart();
}

function setTrays(n) {
  const trays = Math.min(MAX_TRAYS, Math.max(0, n));
  saveCart({ trays });
  showCartCount();
  renderCart();
}

$('#cartMinus').addEventListener('click', () => setTrays(getCart().trays - 1));
$('#cartPlus').addEventListener('click', () => setTrays(getCart().trays + 1));
$('#cartClear').addEventListener('click', () => setTrays(0));
$('#cDelivery').addEventListener('click', () => setFulfilment('delivery'));
$('#cPickup').addEventListener('click', () => setFulfilment('pickup'));
$('#payOptions').addEventListener('change', (e) => {
  if (e.target.name === 'pay') {
    state.method = e.target.value;
    showRefBox();
  }
});

function showOrderDone(o) {
  $('#cartBody').hidden = true;
  $('#cartEmpty').hidden = true;
  $('#orderDone').hidden = false;
  $('#doneCode').textContent = o.order_code;
  $('#doneTotal').textContent = money(o.total);
  const advance = PAY_METHODS.find((m) => m.id === o.payment_method).advance;
  let note;
  if (advance) {
    note = o.payment_status === 'awaiting_verification'
      ? 'We have your transaction ID and will confirm your payment shortly. Your order is released once it is confirmed.'
      : 'Please send your payment. We confirm it before your order is released.';
  } else {
    note = o.fulfilment === 'pickup' ? 'Pay when you collect your trays.' : 'Pay when your order arrives.';
  }
  $('#doneNote').textContent = note;
  window.scrollTo(0, 0);
}

$('#placeOrder').addEventListener('click', async () => {
  const session = getSession();
  const error = $('#coError');
  if (!session) {
    toast('Please log in or sign up to place your order.');
    openAuth('login');
    return;
  }
  const cart = getCart();
  const method = selectedMethod();
  const body = {
    trays: cart.trays,
    fulfilment: state.fulfilment,
    payment_method: method.id,
    contact_phone: $('#cPhone').value.trim()
  };
  if (state.fulfilment === 'delivery') {
    body.zone_id = Number($('#cZone').value);
    body.delivery_address = $('#cAddress').value.trim();
    if (!body.zone_id) { error.textContent = 'Please choose your delivery area.'; return; }
    if (body.delivery_address.length < 5) { error.textContent = 'Please say where to deliver (street, landmark or shop name).'; return; }
  }
  if (method.advance) {
    const ref = $('#cRef').value.trim();
    if (!ref) { error.textContent = 'Enter the transaction ID of your payment.'; return; }
    body.payment_reference = ref;
  }

  const button = $('#placeOrder');
  button.disabled = true;
  error.textContent = '';
  try {
    const order = await post('/orders', body, session.token);
    saveCart({ trays: 0 });
    showCartCount();
    showOrderDone(order);
    loadProducts();
  } catch (err) {
    error.textContent = err.message;
    if (err.status === 401) {
      setSession(null);
      renderAccount();
      openAuth('login');
    }
  } finally {
    button.disabled = false;
  }
});

// ===== Account: menu, log in, sign up =====
function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem('seh_session'));
    return s && s.token && s.user ? s : null;
  } catch (err) {
    return null;
  }
}
function setSession(s) {
  try {
    if (s) localStorage.setItem('seh_session', JSON.stringify(s));
    else localStorage.removeItem('seh_session');
  } catch (err) { /* ignore */ }
}

function closeMenu() {
  $('#accountMenu').hidden = true;
  $('#accountBtn').setAttribute('aria-expanded', 'false');
}

function renderAccount() {
  const s = getSession();
  const menu = $('#accountMenu');
  menu.replaceChildren();
  $('#accountLabel').textContent = s ? s.user.full_name.split(' ')[0] : 'Account';

  const add = (text, onClick) => {
    const el = document.createElement(onClick ? 'button' : 'p');
    el.textContent = text;
    if (onClick) {
      el.type = 'button';
      el.addEventListener('click', () => { closeMenu(); onClick(); });
    }
    menu.appendChild(el);
  };

  if (!s) {
    add('Log in', () => openAuth('login'));
    add('Sign up', () => openAuth('signup'));
  } else {
    add(`Signed in as ${s.user.full_name}`);
    const page = { customer: 'My orders', rider: 'My deliveries', admin: 'Admin dashboard' }[s.user.role];
    add(page, () => toast('This page is built in a later step.'));
    add('Log out', () => {
      setSession(null);
      renderAccount();
      toast('You are logged out.');
    });
  }
}

// Show / hide the password
function setPasswordVisible(show) {
  $('#fPass').type = show ? 'text' : 'password';
  const btn = $('#passToggle');
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
}

function openAuth(mode) {
  AUTH.mode = mode;
  const signup = mode === 'signup';
  $('#authTitle').textContent = signup ? 'Create your account' : 'Log in';
  $('#authSubmit').textContent = signup ? 'Create account' : 'Log in';
  $('#authSwitchText').textContent = signup ? 'Already have an account?' : 'New here?';
  $('#authSwitch').textContent = signup ? 'Log in' : 'Create an account';
  $('#fPass').autocomplete = signup ? 'new-password' : 'current-password';
  document.querySelectorAll('[data-signup]').forEach((el) => { el.hidden = !signup; });
  $('#authError').textContent = '';
  setPasswordVisible(false);
  if (!$('#authDialog').open) $('#authDialog').showModal();
  (signup ? $('#fName') : $('#fPhone')).focus();
}

$('#accountBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#accountMenu');
  const opening = menu.hidden;
  menu.hidden = !opening;
  $('#accountBtn').setAttribute('aria-expanded', String(opening));
});
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

$('#passToggle').addEventListener('click', () => {
  setPasswordVisible($('#fPass').type === 'password');
  $('#fPass').focus();
});
$('#authDialog').addEventListener('close', () => setPasswordVisible(false));
$('#authSwitch').addEventListener('click', () => openAuth(AUTH.mode === 'login' ? 'signup' : 'login'));
$('#authClose').addEventListener('click', () => $('#authDialog').close());
$('#authDialog').addEventListener('click', (e) => { if (e.target === $('#authDialog')) $('#authDialog').close(); });

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const signup = AUTH.mode === 'signup';
  const error = $('#authError');
  const phone = $('#fPhone').value.trim();
  const password = $('#fPass').value;
  if (!phone || !password) {
    error.textContent = 'Enter your phone number and password.';
    return;
  }
  const button = $('#authSubmit');
  button.disabled = true;
  error.textContent = '';
  try {
    const body = signup
      ? { full_name: $('#fName').value.trim(), phone, password, customer_type: $('#fType').value }
      : { phone, password };
    const data = await post(signup ? '/auth/register' : '/auth/login', body);
    setSession({ token: data.token, user: data.user });
    $('#authForm').reset();
    $('#authDialog').close();
    renderAccount();
    toast(signup ? `Welcome, ${data.user.full_name}. Your account is ready.` : `Welcome back, ${data.user.full_name}.`);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// Check a saved login with the server when the page opens.
async function restoreLogin() {
  const s = getSession();
  if (!s) return;
  try {
    const res = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + s.token } });
    if (res.ok) setSession({ token: s.token, user: (await res.json()).user });
    else if (res.status === 401) setSession(null);
  } catch (err) { /* server offline: keep the saved login for now */ }
  renderAccount();
}

// ---------- Start ----------
if (location.port === '5500') {
  showBanner('You opened this page with Live Server, which cannot reach the shop server. Close this tab and open http://localhost:3000 instead.');
}
renderCards();
renderPay();
showCartCount();
loadProducts();
loadZones();
renderAccount();
restoreLogin();
route();

// My orders, the admin screens and the rider screen are added below this line in later steps

// ===== PAYMENT STEPS: these versions replace the older ones above =====

// EDIT HERE: put your payment details inside the quotes. Phone numbers only, never a PIN.
function payTo() {
  return {
    mtn_momo: { number: '07XXXXXXXX', name: 'Soroti Egg Hub' },  // for example number: '07XXXXXXXX', name: 'Soroti Egg Hub'
airtel_money: { number: '07XXXXXXXX', name: 'Soroti Egg Hub' },  // for example 'Bank name, account number, account name'
  };
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Number copied.');
  } catch (err) {
    toast('Could not copy. Please type the number: ' + text);
  }
}

function updatePayAmount() {
  const a = $('#payAmount');
  if (a) a.textContent = $('#sTotal').textContent;
}

function selectedMethod() {
  return PAY_METHODS.find((m) => m.id === state.method) || { id: '', name: '', advance: false };
}

function renderPay() {
  if (!renderPay.ran) { renderPay.ran = true; state.method = ''; } // start with nothing chosen
  const box = $('#payOptions');
  box.replaceChildren();
  for (const m of PAY_METHODS) {
    const label = el('label', 'pay-opt');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'pay';
    input.value = m.id;
    input.checked = m.id === state.method;
    const text = el('span');
    text.append(el('strong', '', m.name), el('small', '', m.note));
    label.append(input, text);
    box.appendChild(label);
  }
  showRefBox();
}

function showRefBox() {
  const m = selectedMethod();
  $('#refBox').hidden = false;
  $('#refHint').hidden = true;

  let panel = $('#payHow');
  if (!panel) {
    panel = el('div', 'payhow');
    panel.id = 'payHow';
    $('#refBox').prepend(panel);
    // keep the amount in the instructions in step with the order total
    new MutationObserver(updatePayAmount).observe($('#sTotal'), { childList: true, characterData: true, subtree: true });
  }
  panel.replaceChildren();
  $('#cRef').closest('.field').hidden = !m.advance;

  if (!m.id) {
    panel.append(el('p', 'muted', 'Choose how you will pay, and the payment steps will appear here.'));
    return;
  }
  if (!m.advance) {
    panel.append(el('h3', '', m.name), el('p', '', 'No payment is needed now. You pay when you receive your eggs.'));
    return;
  }

  const info = payTo()[m.id] || {};
  const mobile = m.id !== 'bank_card';
  panel.append(el('h3', '', mobile ? `Pay with ${m.name}` : 'Pay by bank card or bank transfer'));

  const amount = el('p', 'payline');
  const amountValue = el('strong');
  amountValue.id = 'payAmount';
  amount.append('Amount to pay: ', amountValue);
  panel.append(amount);

  if (mobile) {
    const mtn = m.id === 'mtn_momo';
    const menu = mtn ? '*165#' : '*185#';
    const sendMoney = mtn ? '*165*1#' : '*185*1#';
    if (info.number) {
      const row = el('div', 'paynum');
      const copy = el('button', 'btn btn-primary copy', 'Copy number');
      copy.type = 'button';
      copy.addEventListener('click', () => copyText(info.number));
      row.append(el('span', 'paynum-value', info.number), copy);
      panel.append(el('p', 'payline', 'Send it to:'), row);
      if (info.name) panel.append(el('p', 'muted', 'Name on the account: ' + info.name));
    } else {
      panel.append(el('p', 'paywarn', 'The payment number has not been added yet. Shop owner: add it inside payTo() at the bottom of app.js.'));
    }
    const steps = el('ol');
    steps.append(
      el('li', '', `Dial ${menu} on your phone, choose Send Money, and send the amount above to the number shown.`),
      el('li', '', 'Confirm with your Mobile Money PIN. Never share your PIN with anyone.'),
      el('li', '', 'You will get an SMS with a transaction ID. Type it in the box below.')
    );
    panel.append(steps);
    const dial = el('a', 'btn btn-ghost dial', `On a phone: open ${m.name} Send Money`);
    dial.href = 'tel:' + encodeURIComponent(sendMoney);
    panel.append(dial);
  } else {
    if (info.details) panel.append(el('p', 'payline', info.details));
    else panel.append(el('p', 'paywarn', 'The bank details have not been added yet. Shop owner: add them inside payTo() at the bottom of app.js.'));
    panel.append(el('p', 'muted', 'Make the payment, then type your payment reference in the box below.'));
  }
  updatePayAmount();
}

// ===== MY ORDERS (these versions replace the older route() and renderAccount()) =====

function route() {
  const views = ['home', 'about', 'stations', 'cart', 'orders'];
  const hash = location.hash.replace('#', '') || 'home';
  const view = views.includes(hash) ? hash : 'home';
  views.forEach((v) => { $('#view-' + v).hidden = v !== view; });
  const current = hash === 'product' ? 'product' : view;
  document.querySelectorAll('[data-view]').forEach((a) => {
    if (a.dataset.view === current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (hash !== 'product') window.scrollTo(0, 0);
  if (view === 'cart') openCart();
  if (view === 'orders') openOrders();
}

function renderAccount() {
  const s = getSession();
  const menu = $('#accountMenu');
  menu.replaceChildren();
  $('#accountLabel').textContent = s ? s.user.full_name.split(' ')[0] : 'Account';

  const add = (text, onClick) => {
    const item = document.createElement(onClick ? 'button' : 'p');
    item.textContent = text;
    if (onClick) {
      item.type = 'button';
      item.addEventListener('click', () => { closeMenu(); onClick(); });
    }
    menu.appendChild(item);
  };

  if (!s) {
    add('Log in', () => openAuth('login'));
    add('Sign up', () => openAuth('signup'));
  } else {
    add(`Signed in as ${s.user.full_name}`);
    if (s.user.role === 'customer') {
      add('My orders', () => { location.hash = '#orders'; });
    } else {
      add(s.user.role === 'rider' ? 'My deliveries' : 'Admin dashboard', () => toast('This page is built in a later step.'));
    }
    add('Log out', () => {
      setSession(null);
      renderAccount();
      toast('You are logged out.');
    });
  }
  if (!$('#view-orders').hidden) openOrders(); // refresh the orders page after logging in or out
}

function statusText(s) {
  return { pending: 'Order received', processing: 'Being prepared', dispatched: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled' }[s] || s;
}
function paymentText(s) {
  return { unpaid: 'Not paid yet', awaiting_verification: 'Payment being checked', paid: 'Paid', refunded: 'Refunded' }[s] || s;
}
function formatWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function chip(kind, text) {
  return el('span', 'chip ' + kind, text);
}
function detailRow(list, label, value) {
  const row = el('div');
  row.append(el('dt', '', label), el('dd', '', value));
  list.appendChild(row);
}

function orderNote(o) {
  if (o.status === 'cancelled') {
    if (o.payment_status === 'refunded') return 'This order was cancelled and your payment has been refunded.';
    if (o.payment_status === 'paid' || o.payment_status === 'awaiting_verification') return 'This order was cancelled. We will refund your payment.';
    return 'This order was cancelled.';
  }
  if (o.payment_status === 'awaiting_verification') return 'We are checking your payment. Your order is released once it is confirmed.';
  if (o.status === 'dispatched') return 'Your order is on the way.';
  if (o.status === 'delivered') return 'Delivered. Thank you for ordering with us.';
  return '';
}

function timeline(status) {
  const steps = ['pending', 'processing', 'dispatched', 'delivered'];
  const at = steps.indexOf(status);
  const list = el('ol', 'timeline');
  steps.forEach((s, i) => {
    const cls = status === 'delivered' || i < at ? 'done' : i === at ? 'now' : '';
    list.appendChild(el('li', cls, statusText(s)));
  });
  return list;
}

function orderCard(o) {
  const card = el('article', 'ocard');
  const top = el('div', 'otop');
  const title = el('div');
  title.append(el('h3', 'ocode', o.order_code), el('p', 'muted', formatWhen(o.created_at)));
  const chips = el('div', 'ochips');
  chips.append(chip('s-' + o.status, statusText(o.status)), chip('p-' + o.payment_status, paymentText(o.payment_status)));
  top.append(title, chips);
  card.appendChild(top);
  if (o.status !== 'cancelled') card.appendChild(timeline(o.status));

  const trays = (o.items || []).reduce((n, i) => n + i.quantity, 0);
  const method = PAY_METHODS.find((m) => m.id === o.payment_method);
  const list = el('dl', 'odetails');
  detailRow(list, 'Trays', `${trays} (${trays * 30} eggs)`);
  detailRow(list, o.fulfilment === 'pickup' ? 'Collection' : 'Delivery to',
    o.fulfilment === 'pickup' ? 'Pickup station, no delivery fee' : `${o.zone}, ${o.delivery_address}`);
  detailRow(list, 'Phone', o.contact_phone);
  detailRow(list, 'Payment', method ? method.name : o.payment_method);
  if (o.payment_reference) detailRow(list, 'Transaction ID', o.payment_reference);
  detailRow(list, 'Eggs', money(o.subtotal_ugx));
  detailRow(list, 'Delivery fee', o.delivery_fee_ugx ? money(o.delivery_fee_ugx) : 'Free');
  detailRow(list, 'Total', money(o.total_ugx));
  list.lastChild.className = 'grand';
  card.appendChild(list);

  const note = orderNote(o);
  if (note) card.appendChild(el('p', 'onote', note));

  const actions = el('div', 'oactions');
  if (method && method.advance && o.payment_status === 'unpaid' && o.status !== 'cancelled') {
    const form = el('div', 'refform');
    const input = document.createElement('input');
    input.placeholder = 'Transaction ID';
    input.setAttribute('aria-label', 'Transaction ID');
    const send = el('button', 'btn btn-primary', 'Send ID');
    send.type = 'button';
    send.dataset.ref = o.order_code;
    form.append(input, send);
    actions.appendChild(form);
  }
  if (o.status === 'pending' && o.payment_status === 'unpaid') {
    const cancel = el('button', 'btn btn-ghost', 'Cancel order');
    cancel.type = 'button';
    cancel.dataset.cancel = o.order_code;
    actions.appendChild(cancel);
  }
  if (actions.children.length) card.appendChild(actions);
  return card;
}

async function openOrders() {
  const mine = (openOrders.n = (openOrders.n || 0) + 1); // ignore slow answers that arrive late
  const box = $('#ordersList');
  const msg = $('#ordersMsg');
  box.replaceChildren();
  $('#ordersLogin').hidden = true;
  $('#ordersShop').hidden = true;

  const s = getSession();
  if (!s) {
    msg.textContent = 'Log in to see your orders.';
    $('#ordersLogin').hidden = false;
    return;
  }
  if (s.user.role !== 'customer') {
    msg.textContent = 'This page shows customer orders. The admin and rider screens come in the next steps.';
    return;
  }
  msg.textContent = 'Loading your orders...';
  try {
    const list = await request('/orders/mine', { headers: { Authorization: 'Bearer ' + s.token } });
    if (mine !== openOrders.n) return;
    if (!list.length) {
      msg.textContent = 'You have not placed any orders yet.';
      $('#ordersShop').hidden = false;
      return;
    }
    msg.textContent = list.length === 1 ? 'You have 1 order.' : `Your ${list.length} most recent orders.`;
    list.forEach((o) => box.appendChild(orderCard(o)));
  } catch (err) {
    if (mine !== openOrders.n) return;
    if (err.status === 401) {
      setSession(null);
      renderAccount();
      return;
    }
    msg.textContent = err.message;
  }
}

$('#ordersRefresh').addEventListener('click', openOrders);
$('#ordersLogin').addEventListener('click', () => openAuth('login'));
$('#ordersList').addEventListener('click', async (e) => {
  const s = getSession();
  const cancel = e.target.closest('[data-cancel]');
  const send = e.target.closest('[data-ref]');
  if (!s || (!cancel && !send)) return;
  try {
    if (cancel) {
      const code = cancel.dataset.cancel;
      if (!window.confirm('Cancel order ' + code + '?')) return;
      cancel.disabled = true;
      await post(`/orders/${encodeURIComponent(code)}/cancel`, {}, s.token);
      toast('Order cancelled.');
      loadProducts();
    } else {
      const id = send.parentElement.querySelector('input').value.trim();
      if (!id) { toast('Type the transaction ID first.'); return; }
      send.disabled = true;
      await post(`/orders/${encodeURIComponent(send.dataset.ref)}/payment-reference`, { payment_reference: id }, s.token);
      toast('Thank you. We will check your payment.');
    }
  } catch (err) {
    toast(err.message);
  }
  openOrders();
});


// ===== Phone menu =====
const navBar = document.querySelector('.nav-bar');
function setNav(open) {
  navBar.classList.toggle('open', open);
  $('#menuToggle').setAttribute('aria-expanded', String(open));
  $('#menuToggle').setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
$('#menuToggle').addEventListener('click', () => setNav(!navBar.classList.contains('open')));
navBar.addEventListener('click', (e) => { if (e.target.closest('.nav > a')) setNav(false); });
document.addEventListener('click', (e) => { if (e.target.closest('.dropdown button')) setNav(false); });
window.addEventListener('hashchange', () => setNav(false));

// ===== ADMIN SCREENS (these versions replace the older route() and renderAccount()) =====

var ADMIN = { filter: 'active', q: '', orders: [], riders: [], dash: null, timer: null, waiting: null, open: '' };
const FILTERS = {
  active: (o) => ['pending', 'processing', 'dispatched'].includes(o.status),
  pay: (o) => o.payment_status === 'awaiting_verification' && o.status !== 'cancelled',
  refund: (o) => o.refund_needed,
  delivered: (o) => o.status === 'delivered',
  cancelled: (o) => o.status === 'cancelled',
  all: () => true
};

function adminApi(path, method, body) {
  const s = getSession();
  const options = { method: method || 'GET', headers: { Authorization: 'Bearer ' + (s ? s.token : '') } };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return request('/admin' + path, options);
}

function stopAdminTimer() { clearInterval(ADMIN.timer); }

function adminProblem(err) {
  if (err.status === 401 || err.status === 403) { setSession(null); renderAccount(); return; }
  $('#adminMsg').textContent = err.message;
}

function route() {
  const views = ['home', 'about', 'stations', 'cart', 'orders', 'admin'];
  const hash = location.hash.replace('#', '') || 'home';
  const view = views.includes(hash) ? hash : 'home';
  views.forEach((v) => { $('#view-' + v).hidden = v !== view; });
  const current = hash === 'product' ? 'product' : view;
  document.querySelectorAll('[data-view]').forEach((a) => {
    if (a.dataset.view === current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (hash !== 'product') window.scrollTo(0, 0);
  if (view === 'cart') openCart();
  if (view === 'orders') openOrders();
  if (view === 'admin') openAdmin(); else stopAdminTimer();
}

function renderAccount() {
  const s = getSession();
  const menu = $('#accountMenu');
  menu.replaceChildren();
  $('#accountLabel').textContent = s ? s.user.full_name.split(' ')[0] : 'Account';
  const add = (text, onClick) => {
    const item = document.createElement(onClick ? 'button' : 'p');
    item.textContent = text;
    if (onClick) {
      item.type = 'button';
      item.addEventListener('click', () => { closeMenu(); onClick(); });
    }
    menu.appendChild(item);
  };
  if (!s) {
    add('Log in', () => openAuth('login'));
    add('Sign up', () => openAuth('signup'));
  } else {
    add(`Signed in as ${s.user.full_name}`);
    if (s.user.role === 'customer') add('My orders', () => { location.hash = '#orders'; });
    else if (s.user.role === 'admin') add('Admin dashboard', () => { location.hash = '#admin'; });
    else add('My deliveries', () => toast('The rider screen is built in a later step.'));
    add('Log out', () => {
      setSession(null);
      renderAccount();
      toast('You are logged out.');
    });
  }
  if (!$('#view-orders').hidden) openOrders();
  if (!$('#view-admin').hidden) openAdmin();
}

async function openAdmin() {
  stopAdminTimer();
  const s = getSession();
  $('#adminBody').hidden = true;
  $('#adminLogin').hidden = true;
  if (!s) {
    $('#adminMsg').textContent = 'Log in as the shop admin to use this page.';
    $('#adminLogin').hidden = false;
    return;
  }
  if (s.user.role !== 'admin') {
    $('#adminMsg').textContent = 'This page is for the shop admin only.';
    return;
  }
  $('#adminMsg').textContent = '';
  $('#adminBody').hidden = false;
  await loadAdmin();
  if ($('#view-admin').hidden) return;
  ADMIN.timer = setInterval(() => { if (!$('#orderDialog').open) loadAdmin(true); }, 20000);
}

async function loadAdmin(quiet) {
  try {
    const [dash, orders, riders] = await Promise.all([adminApi('/dashboard'), adminApi('/orders'), adminApi('/users?role=rider')]);
    if (quiet && ADMIN.waiting !== null && dash.payments_awaiting_verification > ADMIN.waiting) {
      toast('A new payment is waiting to be checked.');
    }
    ADMIN.waiting = dash.payments_awaiting_verification;
    Object.assign(ADMIN, { dash, orders, riders });
    renderTiles();
    renderAdminOrders();
    if ($('#orderDialog').open) showOrder(ADMIN.open);
  } catch (err) {
    adminProblem(err);
  }
}

function tile(label, value, extra, go) {
  const t = el(go ? 'button' : 'div', 'tile' + (extra ? ' ' + extra : ''));
  if (go) { t.type = 'button'; t.addEventListener('click', go); }
  t.append(el('strong', '', String(value)), el('span', '', label));
  return t;
}

function setFilter(f) {
  ADMIN.filter = f;
  renderAdminOrders();
}

function renderTiles() {
  const d = ADMIN.dash;
  $('#stockAlert').hidden = !d.stock.alert;
  $('#stockAlert').textContent = d.stock.alert || '';
  $('#adminTiles').replaceChildren(
    tile('Trays in stock', d.stock.trays_available, d.stock.low_stock ? 'bad' : ''),
    tile('Pending orders', d.orders.pending, '', () => setFilter('active')),
    tile('Payments to check', d.payments_awaiting_verification, d.payments_awaiting_verification ? 'warn' : '', () => setFilter('pay')),
    tile('Refunds needed', d.refunds_needed, d.refunds_needed ? 'bad' : '', () => setFilter('refund')),
    tile("Today's sales", money(d.today.sales_ugx), '')
  );
}

function renderAdminOrders() {
  document.querySelectorAll('#orderFilters [data-f]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === ADMIN.filter)));
  const q = ADMIN.q.trim().toLowerCase();
  const list = ADMIN.orders
    .filter(FILTERS[ADMIN.filter])
    .filter((o) => !q || [o.order_code, o.customer_name, o.contact_phone, o.payment_reference].join(' ').toLowerCase().includes(q));
  const box = $('#adminOrders');
  box.replaceChildren();
  if (!list.length) {
    box.appendChild(el('p', 'muted', 'No orders here.'));
    return;
  }
  for (const o of list) {
    const row = el('button', 'arow');
    row.type = 'button';
    row.dataset.code = o.order_code;
    const left = el('div');
    left.append(el('strong', '', o.order_code), el('span', 'muted', `${o.customer_name}, ${o.contact_phone}`));
    const mid = el('div', 'amt', `${o.trays} ${o.trays === 1 ? 'tray' : 'trays'}, ${money(o.total_ugx)}`);
    const chips = el('div', 'ochips');
    chips.append(chip('s-' + o.status, statusText(o.status)), chip('p-' + o.payment_status, paymentText(o.payment_status)));
    if (o.refund_needed) chips.append(chip('s-cancelled', 'Refund needed'));
    row.append(left, mid, chips);
    box.appendChild(row);
  }
}

// ----- The order popup -----
function showOrder(code) {
  const o = ADMIN.orders.find((x) => x.order_code === code);
  if (!o) { $('#orderDialog').close(); return; }
  ADMIN.open = code;
  const body = $('#orderBody');
  const method = PAY_METHODS.find((m) => m.id === o.payment_method);
  const advance = Boolean(method && method.advance);
  body.replaceChildren();

  const actBtn = (text, act, cls) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.dataset.act = act;
    return b;
  };

  const head = el('div', 'auth-head');
  const x = el('button', 'x', '\u00d7');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.dataset.act = 'close';
  head.append(el('h2', '', o.order_code), x);
  const chips = el('div', 'ochips');
  chips.append(chip('s-' + o.status, statusText(o.status)), chip('p-' + o.payment_status, paymentText(o.payment_status)));
  body.append(head, chips);

  const list = el('dl', 'odetails');
  detailRow(list, 'Customer', o.customer_name);
  detailRow(list, 'Phone', o.contact_phone);
  detailRow(list, 'Placed', formatWhen(o.created_at));
  detailRow(list, 'Trays', `${o.trays} (${o.trays * 30} eggs)`);
  detailRow(list, o.fulfilment === 'pickup' ? 'Collection' : 'Deliver to',
    o.fulfilment === 'pickup' ? 'Pickup station' : `${o.zone}, ${o.delivery_address}`);
  if (o.rider_name) detailRow(list, 'Rider', o.rider_name);
  detailRow(list, 'Eggs', money(o.subtotal_ugx));
  detailRow(list, 'Delivery fee', o.delivery_fee_ugx ? money(o.delivery_fee_ugx) : 'Free');
  detailRow(list, 'Total', money(o.total_ugx));
  list.lastChild.className = 'grand';
  detailRow(list, 'Payment', method ? method.name : o.payment_method);
  if (o.payment_reference) detailRow(list, 'Transaction ID', o.payment_reference);
  body.append(list);

  // Payment box: this is where the admin approves the payment
  const box = el('div', 'paybox');
  if (o.refund_needed) {
    box.append(el('h3', '', 'Refund needed'),
      el('p', '', `This order was cancelled after a payment. Send ${money(o.total_ugx)} back to ${o.contact_phone}, then mark it refunded.`),
      actBtn('Mark as refunded', 'refunded', 'btn btn-primary'));
  } else if (advance && o.status !== 'cancelled') {
    if (o.payment_status === 'awaiting_verification') {
      box.append(el('h3', '', 'Payment waiting for you'),
        el('p', '', `Open your ${method.name} account and look for ${money(o.total_ugx)} from ${o.contact_phone} with transaction ID ${o.payment_reference}.`));
      const row = el('div', 'oactions');
      row.append(actBtn('Approve payment', 'approve', 'btn btn-primary'), actBtn('Reject payment', 'reject', 'btn btn-ghost'));
      box.append(row);
    } else if (o.payment_status === 'paid') {
      box.append(el('p', '', 'Payment approved.'));
    } else {
      box.append(el('p', '', 'The customer has not sent a transaction ID yet.'));
    }
  } else if (!advance && o.status !== 'cancelled') {
    box.append(el('p', '', o.payment_status === 'paid' ? 'Paid.' : 'Paid on delivery or collection. It is marked paid when the order is delivered.'));
  }
  if (box.children.length) body.append(box);

  // Rider
  if (o.fulfilment === 'delivery' && ['pending', 'processing'].includes(o.status)) {
    const active = ADMIN.riders.filter((r) => r.is_active);
    const row = el('div', 'assign');
    const sel = document.createElement('select');
    sel.id = 'riderSelect';
    sel.setAttribute('aria-label', 'Choose a rider');
    sel.append(new Option(active.length ? 'Choose a rider' : 'No active riders yet', ''));
    active.forEach((r) => sel.append(new Option(r.full_name, r.id)));
    row.append(sel, actBtn('Assign rider', 'assign', 'btn btn-ghost'));
    body.append(el('h3', 'sect', 'Rider'), row);
  }

  // Status buttons
  const pickup = o.fulfilment === 'pickup';
  const next = { pending: 'processing', processing: 'dispatched', dispatched: 'delivered' }[o.status];
  const label = { pending: 'Start preparing', processing: pickup ? 'Mark ready for pickup' : 'Mark as dispatched', dispatched: pickup ? 'Mark as collected' : 'Mark as delivered' }[o.status];
  const actions = el('div', 'oactions');
  if (next) {
    const b = actBtn(label, 'status', 'btn btn-primary');
    b.dataset.value = next;
    actions.append(b);
  }
  if (['pending', 'processing'].includes(o.status)) {
    const c = actBtn('Cancel order', 'status', 'btn btn-ghost');
    c.dataset.value = 'cancelled';
    actions.append(c);
  }
  if (actions.children.length) body.append(el('h3', 'sect', 'Order status'), actions);

  const err = el('p', 'error');
  err.id = 'orderErr';
  err.setAttribute('role', 'alert');
  body.append(err);
}

// ----- Clicks and typing -----
$('#adminOrders').addEventListener('click', (e) => {
  const row = e.target.closest('[data-code]');
  if (!row) return;
  showOrder(row.dataset.code);
  if (!$('#orderDialog').open) $('#orderDialog').showModal();
});

$('#orderDialog').addEventListener('click', async (e) => {
  if (e.target === $('#orderDialog')) { $('#orderDialog').close(); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'close') { $('#orderDialog').close(); return; }
  const code = encodeURIComponent(ADMIN.open);
  const err = $('#orderErr');
  err.textContent = '';
  btn.disabled = true;
  try {
    if (['approve', 'reject', 'refunded'].includes(act)) {
      await adminApi(`/orders/${code}/payment`, 'PATCH', { action: act });
    } else if (act === 'status') {
      if (btn.dataset.value === 'cancelled' && !window.confirm('Cancel order ' + ADMIN.open + '? The trays go back into stock.')) {
        btn.disabled = false;
        return;
      }
      await adminApi(`/orders/${code}/status`, 'PATCH', { status: btn.dataset.value });
    } else if (act === 'assign') {
      const id = Number($('#riderSelect').value);
      if (!id) { err.textContent = 'Choose a rider first.'; btn.disabled = false; return; }
      await adminApi(`/orders/${code}/rider`, 'PATCH', { rider_id: id });
    }
    toast('Done.');
    await loadAdmin();
  } catch (ex) {
    err.textContent = ex.message;
    btn.disabled = false;
  }
});

$('#orderFilters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (b) setFilter(b.dataset.f);
});
$('#adminSearch').addEventListener('input', (e) => { ADMIN.q = e.target.value; renderAdminOrders(); });
$('#adminRefresh').addEventListener('click', () => loadAdmin());
$('#adminLogin').addEventListener('click', () => openAuth('login'));


// ===== Admin start-up fix =====
function stopAdminTimer() {
  if (ADMIN) clearInterval(ADMIN.timer);
}

async function openAdmin() {
  if (!ADMIN) return; // too early: the final route() call at the bottom runs this again
  stopAdminTimer();
  const s = getSession();
  $('#adminBody').hidden = true;
  $('#adminLogin').hidden = true;
  if (!s) {
    $('#adminMsg').textContent = 'Log in as the shop admin to use this page.';
    $('#adminLogin').hidden = false;
    return;
  }
  if (s.user.role !== 'admin') {
    $('#adminMsg').textContent = 'This page is for the shop admin only.';
    return;
  }
  $('#adminMsg').textContent = '';
  $('#adminBody').hidden = false;
  await loadAdmin();
  if ($('#view-admin').hidden) return;
  ADMIN.timer = setInterval(() => { if (!$('#orderDialog').open) loadAdmin(true); }, 20000);
}

route();