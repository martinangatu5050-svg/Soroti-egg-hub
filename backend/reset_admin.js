
// Usage:  node reset-admin.js <current phone> <new phone> <new password>
// Example: node reset-admin.js 0780000000 0791234567 MyNewStrongPass1
// Changes the phone number AND password of an existing admin or rider account.
require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

function normalizePhone(input) {
  let p = String(input || '').replace(/[\s-]/g, '');
  if (p.startsWith('+256')) p = '0' + p.slice(4);
  else if (p.startsWith('256')) p = '0' + p.slice(3);
  return /^07\d{8}$/.test(p) ? p : null;
}

async function main() {
  const [currentInput, newInput, password] = process.argv.slice(2);
  const currentPhone = normalizePhone(currentInput);
  const newPhone = normalizePhone(newInput);

  if (!currentPhone || !newPhone || !password) {
    console.log('Usage: node reset-admin.js <current phone> <new phone> <new password>');
    process.exit(1);
  }
  if (password.length < 8 || password.length > 72) {
    console.log('Password must be 8 to 72 characters.');
    process.exit(1);
  }

  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    const [rows] = await db.query(
      "SELECT id, role FROM users WHERE phone = ? AND role IN ('admin','rider')",
      [currentPhone]
    );
    if (!rows.length) {
      console.log(`No admin or rider account found with phone ${currentPhone}.`);
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    await db.query(
      'UPDATE users SET phone = ?, password_hash = ? WHERE id = ?',
      [newPhone, hash, rows[0].id]
    );
    console.log(`Done. The ${rows[0].role} account now logs in with phone ${newPhone} and the new password.`);
  } catch (err) {
    console.log(err.code === 'ER_DUP_ENTRY'
      ? 'That new phone number is already used by another account. Choose a different one.'
      : 'Error: ' + err.message);
  } finally {
    await db.end();
  }
}
main();