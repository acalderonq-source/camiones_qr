// db.js — pool MySQL con soporte DATABASE_URL o variables sueltas (validación estricta)
import mysql from 'mysql2/promise';
import url from 'url';

function fromUrl(dbUrl) {
  const u = new url.URL(dbUrl);
  const hostname = u.hostname;
  const port = Number(u.port || 3306);
  const database = (u.pathname || '').replace(/^\//, '');
  const user = decodeURIComponent(u.username || '');
  const password = decodeURIComponent(u.password || '');
  return { host: hostname, port, user, password, database };
}

let cfg;
let usingUrl = false;

if (process.env.DATABASE_URL) {
  usingUrl = true;
  cfg = fromUrl(process.env.DATABASE_URL);
} else {
  cfg = {
    host: process.env.MYSQLHOST,
    port: Number(process.env.MYSQLPORT || 3306),
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE
  };
}

function assertNonEmpty(name, val) {
  if (!val) throw new Error(`Falta la variable ${name} (o viene vacía)`);
}

if (usingUrl) {
  assertNonEmpty('DATABASE_URL', process.env.DATABASE_URL);
  assertNonEmpty('host en DATABASE_URL', cfg.host);
  assertNonEmpty('user en DATABASE_URL', cfg.user);
  assertNonEmpty('password en DATABASE_URL', cfg.password);
  assertNonEmpty('database en DATABASE_URL', cfg.database);
} else {
  assertNonEmpty('MYSQLHOST', cfg.host);
  assertNonEmpty('MYSQLUSER', cfg.user);
  assertNonEmpty('MYSQLPASSWORD', cfg.password);
  assertNonEmpty('MYSQLDATABASE', cfg.database);
}

const ssl =
  String(process.env.MYSQL_SSL || 'false') === 'true'
    ? { rejectUnauthorized: false }
    : undefined;

console.log(
  '[DB] using',
  usingUrl ? 'DATABASE_URL' : 'MYSQL* envs',
  'host=', cfg.host,
  'port=', cfg.port,
  'user=', cfg.user ? '(ok)' : '(vacío)',
  'db=', cfg.database,
  'ssl=', !!ssl
);

export const pool = mysql.createPool({
  ...cfg,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl
});
