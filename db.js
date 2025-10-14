// db.js — pool MySQL (Railway/Render) con DATABASE_URL o variables sueltas
import mysql from 'mysql2/promise';
import url from 'url';

function fromUrl(dbUrl) {
  const { hostname, port, pathname, auth } = new url.URL(dbUrl);
  const [user, password] = (auth || '').split(':');
  const database = (pathname || '').replace(/^\//, '');
  return {
    host: hostname,
    port: Number(port || 3306),
    user,
    password,
    database
  };
}

const cfg = process.env.DATABASE_URL
  ? fromUrl(process.env.DATABASE_URL)
  : {
      host: process.env.MYSQLHOST || 'localhost',
      port: Number(process.env.MYSQLPORT || 3306),
      user: process.env.MYSQLUSER || 'root',
      password: process.env.MYSQLPASSWORD || '',
      database: process.env.MYSQLDATABASE || 'railway'
    };

const ssl =
  String(process.env.MYSQL_SSL || 'false') === 'true'
    ? { rejectUnauthorized: false }
    : undefined;

export const pool = mysql.createPool({
  ...cfg,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl
});
