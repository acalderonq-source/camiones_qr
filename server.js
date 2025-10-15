// server.js — Camiones QR (Express/EJS/Multer/MySQL BLOB)
// - Fotos (galería y portada) guardadas en MySQL (tabla photos) como BLOB
// - Documentos con fecha de vencimiento; imagen del documento también a BLOB
// - QR anti-localhost, admin con sesión, reportes públicos y panel
// - Health/debug y cron de avisos 22 días (opcional)

import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import QRCode from 'qrcode';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import mysql from 'mysql2/promise';
import url from 'url';

dotenv.config();

// ---------- Paths / Express base ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-session',
  resave: false,
  saveUninitialized: false
}));

// estáticos (CSS, logos, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// ---------- DB (Railway) ----------
function fromUrl(dbUrl) {
  const u = new url.URL(dbUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    database: (u.pathname || '').replace(/^\//, '')
  };
}
let cfg;
if (process.env.DATABASE_URL) cfg = fromUrl(process.env.DATABASE_URL);
else cfg = {
  host: process.env.MYSQLHOST,
  port: Number(process.env.MYSQLPORT || 3306),
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE
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

// ---------- Mail (opcional) ----------
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

// ---------- Helpers ----------
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin-1234';
const upload = multer({ storage: multer.memoryStorage() });

function absoluteBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function setToast(req, type, msg) { req.session.toast = { type, msg }; }
function popToast(req) { const t = req.session.toast; req.session.toast = null; return t; }
function requireAdmin(req, res, next) { if (req.session && req.session.admin) return next(); return res.redirect('/admin/login'); }

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
function sanitizeName(name) {
  const ext = (path.extname(name) || '').toLowerCase();
  const base = path.basename(name, ext).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'img';
  return base + ext;
}
function getIdFromUrlOrName(name) {
  const m = String(name || '').match(/\/file\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}
function fotosSinPortada(fotos, portadaUrl){
  if (!portadaUrl) return fotos;
  const cover = (portadaUrl || '').toLowerCase();
  return (fotos || []).filter(u => (u || '').toLowerCase() !== cover);
}

// ---------- Queries / modelos ----------
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trucks (
      placa VARCHAR(32) PRIMARY KEY,
      unidad VARCHAR(64) NULL,
      cedis  VARCHAR(64) NULL,
      marca  VARCHAR(64) NULL,
      modelo VARCHAR(64) NULL,
      anio   VARCHAR(16) NULL,
      vin    VARCHAR(64) NULL,
      telefono_quejas VARCHAR(64) NULL,
      foto   VARCHAR(512) NULL, -- aquí guardamos /file/:id
      notas  TEXT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id VARCHAR(32) PRIMARY KEY,
      placa VARCHAR(32) NOT NULL,
      categoria VARCHAR(64) NOT NULL,
      titulo VARCHAR(128) NOT NULL,
      fecha_vencimiento DATE NULL,
      url VARCHAR(512) NULL,    -- /file/:id si tiene imagen
      alert22Sent TINYINT(1) NOT NULL DEFAULT 0,
      CONSTRAINT fk_documents_truck FOREIGN KEY (placa)
        REFERENCES trucks(placa) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id VARCHAR(32) PRIMARY KEY,
      placa VARCHAR(32) NOT NULL,
      tipo VARCHAR(32) NOT NULL,
      nombre VARCHAR(128) NULL,
      telefono VARCHAR(64) NULL,
      email VARCHAR(128) NULL,
      mensaje TEXT NOT NULL,
      createdAt DATETIME NOT NULL,
      INDEX idx_reports_placa_created (placa, createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS photos (
      id        VARCHAR(32) PRIMARY KEY,
      placa     VARCHAR(32) NOT NULL,
      filename  VARCHAR(255) NOT NULL,
      mime      VARCHAR(100) NOT NULL,
      data      LONGBLOB NOT NULL,
      createdAt DATETIME NOT NULL,
      INDEX idx_photos_placa (placa),
      CONSTRAINT fk_photos_truck FOREIGN KEY (placa)
        REFERENCES trucks(placa) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('Schema OK');
}

async function getTruck(placa) {
  const [rows] = await pool.query('SELECT * FROM trucks WHERE placa = ?', [String(placa).toUpperCase()]);
  const row = rows[0];
  if (!row) return null;
  row.notas = row.notas ? row.notas.split(';').map(s => s.trim()).filter(Boolean) : [];
  return row;
}
async function upsertTruck(data) {
  const notasText = Array.isArray(data.notas) ? data.notas.join(';') : (data.notas || '');
  await pool.query(
    `INSERT INTO trucks (placa, unidad, cedis, marca, modelo, anio, vin, telefono_quejas, foto, notas)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       unidad=VALUES(unidad), cedis=VALUES(cedis), marca=VALUES(marca), modelo=VALUES(modelo),
       anio=VALUES(anio), vin=VALUES(vin), telefono_quejas=VALUES(telefono_quejas),
       foto=VALUES(foto), notas=VALUES(notas)`,
    [
      data.placa, data.unidad || '', data.cedis || '', data.marca || '', data.modelo || '',
      data.anio || '', data.vin || '', data.telefono_quejas || '', data.foto || '', notasText
    ]
  );
}
async function getDocsByPlaca(placa) {
  const [rows] = await pool.query(
    'SELECT * FROM documents WHERE placa = ? ORDER BY fecha_vencimiento IS NULL, fecha_vencimiento',
    [String(placa).toUpperCase()]
  );
  return rows;
}
async function upsertDoc(placa, doc) {
  const fecha = doc.fecha_vencimiento ? new Date(doc.fecha_vencimiento) : null;
  await pool.query(
    `INSERT INTO documents (id, placa, categoria, titulo, fecha_vencimiento, url, alert22Sent)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       categoria=VALUES(categoria), titulo=VALUES(titulo),
       fecha_vencimiento=VALUES(fecha_vencimiento), url=VALUES(url), alert22Sent=VALUES(alert22Sent)`,
    [doc.id, String(placa).toUpperCase(), doc.categoria, doc.titulo, fecha, doc.url || null, doc.alert22Sent ? 1 : 0]
  );
  return true;
}
async function deleteDoc(placa, id) {
  const [res] = await pool.query('DELETE FROM documents WHERE id = ? AND placa = ?', [id, String(placa).toUpperCase()]);
  return res.affectedRows > 0;
}
async function addReport(rep) {
  await pool.query(
    `INSERT INTO reports (id, placa, tipo, nombre, telefono, email, mensaje, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [rep.id, rep.placa, rep.tipo, rep.nombre, rep.telefono, rep.email, rep.mensaje, rep.createdAt]
  );
}
async function listAlerts() {
  const [rows] = await pool.query(
    `SELECT d.*, t.placa, DATEDIFF(d.fecha_vencimiento, CURDATE()) AS dias
     FROM documents d
     JOIN trucks t ON t.placa = d.placa
     WHERE d.fecha_vencimiento IS NOT NULL
       AND DATEDIFF(d.fecha_vencimiento, CURDATE()) <= 30`
  );
  const out = rows.map(r => ({
    placa: r.placa,
    id: r.id,
    categoria: r.categoria,
    titulo: r.titulo,
    fecha_vencimiento: r.fecha_vencimiento ? new Date(r.fecha_vencimiento).toISOString().slice(0,10) : null,
    url: r.url,
    estado: (r.dias < 0) ? 'vencido' : 'por-vencer',
    dias: r.dias
  }));
  out.sort((a,b) => {
    const pr = x => x.estado === 'vencido' ? 0 : 1;
    if (pr(a) !== pr(b)) return pr(a) - pr(b);
    return (a.dias || 0) - (b.dias || 0);
  });
  return out;
}

// ---- Fotos en DB (BLOB) ----
async function savePhotoDb(placa, file) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const mime = file.mimetype || 'application/octet-stream';
  const filename = sanitizeName(file.originalname || 'img');
  await pool.query(
    `INSERT INTO photos (id, placa, filename, mime, data, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, String(placa).toUpperCase(), filename, mime, file.buffer, new Date()]
  );
  return { id, url: `/file/${id}`, filename, mime };
}
async function listPhotosFromDb(placa) {
  const [rows] = await pool.query(
    'SELECT id FROM photos WHERE placa = ? ORDER BY createdAt DESC',
    [String(placa).toUpperCase()]
  );
  return rows.map(r => `/file/${r.id}`);
}
async function deletePhotoDbById(id, placa) {
  const [r] = await pool.query('DELETE FROM photos WHERE id = ? AND placa = ?', [id, String(placa).toUpperCase()]);
  return r.affectedRows > 0;
}
async function replacePhotoDbById(id, placa, file) {
  const mime = file.mimetype || 'application/octet-stream';
  const filename = sanitizeName(file.originalname || 'img');
  const [r] = await pool.query(
    'UPDATE photos SET filename=?, mime=?, data=? WHERE id=? AND placa=?',
    [filename, mime, file.buffer, id, String(placa).toUpperCase()]
  );
  return r.affectedRows > 0;
}

// ---------- Rutas públicas ----------
app.get('/', (req, res) => {
  res.render('index', { toast: popToast(req) });
});

// ficha pública
app.get('/c/:placa', async (req, res) => {
  try {
    const placa = req.params.placa;
    const truck = await getTruck(placa);
    let fotos = truck ? await listPhotosFromDb(truck.placa) : [];
    fotos = fotosSinPortada(fotos, truck?.foto);

    let docs = [];
    let avisos = [];
    if (truck) {
      const dbDocs = await getDocsByPlaca(placa);
      docs = dbDocs.map(d => {
        const v = d.fecha_vencimiento ? new Date(d.fecha_vencimiento) : null;
        const today = new Date(); today.setHours(0,0,0,0);
        let estado = 'sin-fecha', dias = null;
        if (v && !isNaN(v)) {
          dias = Math.floor((v - today)/(1000*60*60*24));
          estado = dias < 0 ? 'vencido' : (dias <= 30 ? 'por-vencer' : 'vigente');
        }
        return { ...d, fecha_vencimiento: v ? v.toISOString().slice(0,10) : null, estado, dias };
      });
      avisos = docs.filter(d => d.estado === 'vencido' || d.estado === 'por-vencer');
    }

    const enviado = req.query.enviado === '1';
    const error = req.query.error === '1';
    res.render('ficha', { truck, fotos, docs, avisos, enviado, error });
  } catch (e) {
    console.error('GET /c/:placa error:', e);
    res.status(500).send('Error interno al cargar la ficha.');
  }
});

// servir imagen desde MySQL
app.get('/file/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await pool.query('SELECT mime, data FROM photos WHERE id=?', [id]);
    if (!rows.length) return res.status(404).send('No encontrado');
    res.setHeader('Content-Type', rows[0].mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(rows[0].data);
  } catch (e) {
    res.status(500).send('Error archivo');
  }
});

// QR anti-localhost
app.get('/qrimg/:placa.png', async (req, res) => {
  try {
    const placa = req.params.placa;
    let base = process.env.BASE_URL || absoluteBase(req);
    if (/localhost|127\.0\.0\.1/i.test(base)) base = process.env.PUBLIC_BASE_URL || 'https://camiones-qr.onrender.com';
    const url = `${base}/c/${encodeURIComponent(placa)}`;
    const buf = await QRCode.toBuffer(url, { type: 'png', width: 320, margin: 1 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(buf);
  } catch {
    res.status(500).send('QR error');
  }
});
app.get('/qr/:placa.png', (req, res) => res.redirect(302, `/qrimg/${encodeURIComponent(req.params.placa)}.png`));

// debug
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/debug/base', (req, res) => {
  const auto = absoluteBase(req);
  res.json({ BASE_URL_env: process.env.BASE_URL || null, absoluteBase: auto, finalBase: process.env.BASE_URL || auto });
});
app.get('/debug/db', async (req, res) => {
  try {
    const [r1] = await pool.query('SELECT 1 AS ok');
    const [tables] = await pool.query('SHOW TABLES');
    res.json({ ok: r1?.[0]?.ok === 1, tables });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Admin: login/logout ----------
app.get('/admin/login', (req, res) => res.render('admin/login', { toast: popToast(req) }));
app.post('/admin/login', (req, res) => {
  const pass = (req.body.pass || '').trim();
  if (pass !== ADMIN_PASS) { setToast(req, 'err', 'Contraseña incorrecta'); return res.redirect('/admin/login'); }
  req.session.admin = true; return res.redirect('/admin/editar');
});
app.get('/admin/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

// ---------- Admin: editor ----------
app.get('/admin/editar', requireAdmin, async (req, res) => {
  const placa = (req.query.placa || '').toString().trim().toUpperCase();
  let truck = null, fotos = [], docs = [], avisos = [];
  try {
    try { avisos = await listAlerts(); } catch (e) { console.error('listAlerts:', e.message); avisos = []; }

    if (placa) {
      try {
        truck = (await getTruck(placa)) || { placa, notas: [], documentos: [] };
      } catch (e) { console.error('getTruck:', e.message); truck = { placa, notas: [], documentos: [] }; }

      try {
        fotos = await listPhotosFromDb(placa);
        fotos = fotosSinPortada(fotos, truck?.foto);
      } catch (e) { console.error('listPhotosFromDb:', e.message); fotos = []; }

      try {
        const dbDocs = await getDocsByPlaca(placa);
        docs = (dbDocs || []).map(d => {
          const v = d.fecha_vencimiento ? new Date(d.fecha_vencimiento) : null;
          const today = new Date(); today.setHours(0,0,0,0);
          let estado = 'sin-fecha', dias = null;
          if (v && !isNaN(v)) {
            dias = Math.floor((v - today)/(1000*60*60*24));
            estado = dias < 0 ? 'vencido' : (dias <= 30 ? 'por-vencer' : 'vigente');
          }
          return { ...d, fecha_vencimiento: v ? v.toISOString().slice(0,10) : null, estado, dias };
        });
      } catch (e) { console.error('getDocsByPlaca:', e.message); docs = []; }
    }
  } catch (e) { console.error('admin/editar fatal:', e); }

  res.render('admin/editar', { placa, truck, fotos, docs, avisos, toast: popToast(req) });
});

app.post('/admin/editar', requireAdmin, async (req, res) => {
  const b = req.body;
  const placa = String(b.placa || '').trim().toUpperCase();
  if (!placa) { setToast(req, 'err', 'La placa es obligatoria'); return res.redirect('/admin/editar'); }
  const existing = (await getTruck(placa)) || {};
  const notas = String(b.notas || '').split(';').map(s => s.trim()).filter(Boolean);

  const truck = {
    placa,
    unidad: b.unidad || '',
    cedis: b.cedis || '',
    marca: b.marca || '',
    modelo: b.modelo || '',
    anio: b.anio || '',
    vin: b.vin || '',
    telefono_quejas: b.telefono_quejas || '',
    foto: existing.foto || '',
    notas
  };
  await upsertTruck(truck);
  setToast(req, 'ok', 'Guardado');
  res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

// ---------- Galería (BLOB en MySQL) ----------
app.post('/admin/upload', requireAdmin, upload.array('archivos', 50), async (req, res) => {
  try {
    const placa = String(req.body.placa || '').trim().toUpperCase();
    if (!placa) { setToast(req, 'err', 'Falta placa'); return res.redirect('/admin/editar'); }
    if (!req.files || !req.files.length) {
      setToast(req, 'err', 'No se seleccionaron imágenes');
      return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
    }
    let ok = 0, fail = 0;
    for (const f of req.files) {
      try {
        const ext = (path.extname(f.originalname) || '.jpg').toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) { fail++; continue; }
        await savePhotoDb(placa, f);
        ok++;
      } catch { fail++; }
    }
    setToast(req, ok ? 'ok' : 'err', `${ok} subida(s)` + (fail ? `, ${fail} fallida(s)` : ''));
    res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
  } catch (e) {
    setToast(req, 'err', 'Error al subir: ' + e.message);
    res.redirect('/admin/editar?placa=' + encodeURIComponent(req.body.placa || ''));
  }
});

app.post('/admin/photo/delete', requireAdmin, async (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const name  = String(req.body.name  || '').trim(); // puede ser /file/:id
  const id = getIdFromUrlOrName(name);
  if (!placa || !id) { setToast(req, 'err', 'Falta placa o id'); return res.redirect('/admin/editar'); }
  const ok = await deletePhotoDbById(id, placa);
  setToast(req, ok ? 'ok' : 'err', ok ? 'Imagen eliminada' : 'No encontrada');
  return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

app.post('/admin/photo/replace', requireAdmin, upload.single('nuevo'), async (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const name  = String(req.body.name  || '').trim();
  const id = getIdFromUrlOrName(name);
  if (!placa || !id) { setToast(req, 'err', 'Falta placa o id'); return res.redirect('/admin/editar'); }
  if (!req.file) { setToast(req, 'err', 'No se adjuntó imagen'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }
  const ok = await replacePhotoDbById(id, placa, req.file);
  setToast(req, ok ? 'ok' : 'err', ok ? 'Imagen reemplazada' : 'No se pudo reemplazar');
  return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

app.post('/admin/photo/cover', requireAdmin, async (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const name  = String(req.body.name  || '').trim();
  const id = getIdFromUrlOrName(name);
  if (!placa || !id) { setToast(req, 'err', 'Falta placa o id'); return res.redirect('/admin/editar'); }
  const truck = (await getTruck(placa));
  if (!truck) { setToast(req, 'err', 'No se encontró la placa'); return res.redirect('/admin/editar'); }
  truck.foto = `/file/${id}`;
  await upsertTruck(truck);
  setToast(req, 'ok', 'Establecida como portada');
  return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

app.post('/admin/cover/upload', requireAdmin, upload.single('portada'), async (req,res)=>{
  const placa = String(req.body.placa||'').trim().toUpperCase();
  if (!placa){ setToast(req,'err','Falta placa'); return res.redirect('/admin/editar'); }
  if (!req.file){ setToast(req,'err','Adjunta una imagen'); return res.redirect('/admin/editar?placa='+encodeURIComponent(placa)); }
  const saved = await savePhotoDb(placa, req.file);
  const truck = (await getTruck(placa)) || { placa, notas: [] };
  truck.foto = saved.url; // /file/:id
  await upsertTruck(truck);
  setToast(req,'ok','Portada actualizada');
  return res.redirect('/admin/editar?placa='+encodeURIComponent(placa));
});

// ---------- Documentos ----------
app.post('/admin/doc/add', requireAdmin, async (req, res) => {
  const b = req.body;
  const placa = String(b.placa || '').trim().toUpperCase();
  if (!placa) { setToast(req, 'err', 'Falta placa'); return res.redirect('/admin/editar'); }
  const categoria = (b.categoria || '').trim();
  const titulo = (b.titulo || '').trim();
  const fecha_vencimiento = (b.fecha_vencimiento || '').trim();
  const urlDoc = (b.url || '').trim(); // opcional si no hay imagen
  if (!categoria || !titulo || !fecha_vencimiento) {
    setToast(req, 'err', 'Completa categoría, título y fecha.');
    return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
  }
  const doc = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), categoria, titulo, fecha_vencimiento, url: urlDoc || null, alert22Sent: false };
  await upsertDoc(placa, doc);
  setToast(req, 'ok', 'Documento agregado');
  res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

// Subir imagen y crear documento (imagen a BLOB)
app.post('/admin/doc/upload', requireAdmin, upload.single('archivo'), async (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const categoria = (req.body.categoria || '').trim() || 'DOC';
  const titulo = (req.body.titulo || '').trim() || 'Documento';
  const fecha_vencimiento = (req.body.fecha_vencimiento || '').trim();
  if (!placa) { setToast(req, 'err', 'Falta placa'); return res.redirect('/admin/editar'); }
  if (!req.file) { setToast(req, 'err', 'Sube una imagen'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }
  if (!fecha_vencimiento) { setToast(req, 'err', 'Ingresá la fecha de vencimiento'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }

  const ext = (path.extname(req.file.originalname) || '.jpg').toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) { setToast(req,'err','Extensión no permitida'); return res.redirect('/admin/editar?placa='+encodeURIComponent(placa)); }

  const saved = await savePhotoDb(placa, req.file); // /file/:id
  const doc = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), categoria, titulo, fecha_vencimiento, url: saved.url, alert22Sent: false };
  await upsertDoc(placa, doc);
  setToast(req, 'ok', 'Documento creado con imagen');
  return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

app.post('/admin/doc/delete', requireAdmin, async (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const id = (req.body.id || '').trim();
  if (!placa || !id) { setToast(req, 'err', 'Falta placa o id'); return res.redirect('/admin/editar'); }
  const ok = await deleteDoc(placa, id);
  setToast(req, ok ? 'ok' : 'err', ok ? 'Documento eliminado' : 'No encontrado');
  res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

// ---------- Reporte público ----------
app.post('/c/:placa/report', async (req, res) => {
  const placa = String(req.params.placa || '').toUpperCase();

  const tipo = (req.body.tipo || 'Otro').trim();
  const nombre = (req.body.nombre || '').trim();
  const telefono = (req.body.telefono || '').trim();
  const email = (req.body.email || '').trim();
  const mensaje = (req.body.mensaje || '').trim();

  const empresa = (req.body.empresa || '').trim(); // honeypot
  if (empresa) return res.redirect(`/c/${encodeURIComponent(placa)}`);

  if (!mensaje || mensaje.length < 3) {
    return res.redirect(`/c/${encodeURIComponent(placa)}?error=1`);
  }

  const rep = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    placa, tipo, nombre, telefono, email, mensaje,
    createdAt: new Date().toISOString()
  };
  await addReport(rep);

  try {
    if (process.env.ALERT_EMAIL_TO && transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: process.env.ALERT_EMAIL_TO,
        subject: `Nuevo reporte (${rep.tipo}) — ${placa}`,
        html: `
          <p><b>Placa:</b> ${placa}</p>
          <p><b>Tipo:</b> ${rep.tipo}</p>
          <p><b>Nombre:</b> ${rep.nombre || '-'}</p>
          <p><b>Teléfono:</b> ${rep.telefono || '-'}</p>
          <p><b>Email:</b> ${rep.email || '-'}</p>
          <p><b>Mensaje:</b><br>${rep.mensaje.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
          <p style="color:#888">Enviado: ${new Date().toLocaleString()}</p>
        `
      });
    }
  } catch (e) { console.error('Email reporte:', e.message); }

  return res.redirect(`/c/${encodeURIComponent(placa)}?enviado=1`);
});

// ---------- API/panel de reportes ----------
app.get('/api/reportes', requireAdmin, async (req, res) => {
  try {
    const placa = (req.query.placa || '').trim().toUpperCase();
    let sql = 'SELECT * FROM reports';
    const params = [];
    if (placa) { sql += ' WHERE placa = ?'; params.push(placa); }
    sql += ' ORDER BY createdAt DESC LIMIT 500';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/reportes', requireAdmin, async (req, res) => {
  try {
    const placa = (req.query.placa || '').trim().toUpperCase();
    let sql = 'SELECT * FROM reports';
    const params = [];
    if (placa) { sql += ' WHERE placa = ?'; params.push(placa); }
    sql += ' ORDER BY createdAt DESC LIMIT 500';
    const [rows] = await pool.query(sql, params);
    res.render('admin/reportes', { placa, reportes: rows, toast: popToast(req) });
  } catch (e) {
    console.error('admin/reportes:', e.message);
    setToast(req, 'err', 'Error cargando reportes');
    res.render('admin/reportes', { placa: '', reportes: [], toast: popToast(req) });
  }
});

// ---------- CRON 22 días (opcional) ----------
if (String(process.env.DISABLE_CRON || 'false') !== 'true') {
  cron.schedule('0 9 * * *', async () => {
    try {
      const [rows] = await pool.query(
        `SELECT d.*, t.placa
         FROM documents d
         JOIN trucks t ON t.placa = d.placa
         WHERE d.fecha_vencimiento IS NOT NULL
           AND DATEDIFF(d.fecha_vencimiento, CURDATE()) = 22
           AND d.alert22Sent = 0`
      );
      if (rows.length && transporter && process.env.ALERT_EMAIL_TO) {
        const listHtml = rows.map(a =>
          `<li><b>${a.placa}</b> — ${a.categoria}: ${a.titulo}<br/>Vence: <b>${new Date(a.fecha_vencimiento).toISOString().slice(0,10)}</b></li>`
        ).join('');
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: process.env.ALERT_EMAIL_TO,
          subject: `Avisos de vencimiento (22 días) — ${new Date().toLocaleDateString()}`,
          html: `<p>Documentos por vencer en 22 días:</p><ul>${listHtml}</ul>`
        });
        const ids = rows.map(r => r.id);
        if (ids.length) {
          await pool.query(`UPDATE documents SET alert22Sent = 1 WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);
        }
      }
    } catch (e) { console.error('Cron error:', e.message); }
  }, { timezone: process.env.TZ || 'America/Costa_Rica' });
}

// ---------- Arranque ----------
async function waitForDb(maxRetries = 10, delayMs = 2000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const [rows] = await pool.query('SELECT 1 AS ok');
      if (rows?.[0]?.ok === 1) { console.log('DB OK'); return; }
    } catch (e) { console.log(`DB retry ${i}/${maxRetries}: ${e.message}`); }
    await new Promise(r => setTimeout(r, delayMs));
  }
  console.warn('DB no disponible, arrancando igual.');
}

let serverStarted = false;
function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  const PORT = process.env.PORT || 3000;
  console.log(`Servidor en ${process.env.BASE_URL || 'http://localhost:'+PORT}`);
  app.listen(PORT, () => {});
}

// Middleware de errores para evitar 502 silenciosos
app.use((err, req, res, next) => {
  console.error('Unhandled error middleware:', err);
  if (res.headersSent) return next(err);
  res.status(500).send('Error interno del servidor.');
});
process.on('unhandledRejection', reason => console.error('unhandledRejection:', reason));
process.on('uncaughtException', err => console.error('uncaughtException:', err));

(async () => {
  try {
    await waitForDb();
    await ensureSchema(); // no daña si ya existen
    startServer();
  } catch (e) {
    console.error('Fallo al iniciar:', e);
  }
})();
