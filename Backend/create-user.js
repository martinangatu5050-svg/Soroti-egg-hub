

// Usage:  node create-user.js <admin|rider> "<full name>" <phone> <password>
// Example: node create-user.js admin "Angatu Martin" 0780000000 MyStrongPass123
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
  const [role, fullName, phoneInput, password] = process.argv.slice(2);

  if (!['admin', 'rider'].includes(role) || !fullName || !password) {
    console.log('Usage: node create-user.js <admin|rider> "<full name>" <phone> <password>');
    process.exit(1);
  }
  const phone = normalizePhone(phoneInput);
  if (!phone) { console.log('Invalid phone number.'); process.exit(1); }
  if (password.length < 8) { console.log('Password must be at least 8 characters.'); process.exit(1); }

  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query(
      'INSERT INTO users (full_name, phone, password_hash, role) VALUES (?, ?, ?, ?)',
      [fullName, phone, hash, role]
    );
    console.log(`Created ${role}: ${fullName} (${phone})`);
  } catch (err) {
    console.log(err.code === 'ER_DUP_ENTRY'
      ? 'That phone number is already registered.'
      : 'Error: ' + err.message);
  } finally {
    await db.end();
  }
}
main();