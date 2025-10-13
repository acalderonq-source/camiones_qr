// db.js
import mysql from 'mysql2/promise';

function fromUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

const cfg = process.env.DATABASE_URL
  ? fromUrl(process.env.DATABASE_URL)
  : {
      host: process.env.MYSQLHOST,
      port: Number(process.env.MYSQLPORT || 3306),
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
    };

// Railway MySQL a veces requiere SSL; si tu instancia lo pide, deja esta línea.
// Si no, puedes quitar el ssl:
const ssl =
  String(process.env.MYSQL_SSL || 'false') === 'true'
    ? { rejectUnauthorized: false }
    : undefined;

export const pool = mysql.createPool({
  ...cfg,
  ssl,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
