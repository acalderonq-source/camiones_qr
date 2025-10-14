// server.js — Camiones QR (MySQL + Express/EJS/Multer)
// - Portada SOLO por subida (no URL) y NO aparece en la galería/lista
// - Permisos con fecha de vencimiento + correo 22 días antes (cron)
// - Galería (subir/renombrar/reemplazar/eliminar/portada)
// - Reportes públicos guardados en MySQL + email opcional
// - QR por placa
// - Health check /healthz y arranque con reintentos a DB
// - Una sola llamada a app.listen (evita EADDRINUSE)

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
import { pool } from './db.js'; // ← requiere db.js (mysql2/promise)

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin-1234';

// ------------ Middlewares
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-session',
  resave: false,
  saveUninitialized: false
}));
app.use(express.static(path.join(__dirname, 'public')));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Subidas en memoria (multer)
const upload = multer({ storage: multer.memoryStorage() });

// ------------ Email (avisos y reportes)
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

// ------------ Helpers de archivos (galería)
function ensureFolder(folderPath) { fs.mkdirSync(folderPath, { recursive: true }); }
const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
function getUploadDir(placa) {
  const dir = path.join(__dirname, 'public', 'uploads', String(placa).toUpperCase());
  ensureFolder(dir);
  return dir;
}
function sanitizeName(name) {
  const ext = (path.extname(name) || '').toLowerCase();
  const base = path.basename(name, ext).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'img';
  return base + ext;
}
function listPhotos(placa) {
  const dir = getUploadDir(placa);
  const relRoot = `/uploads/${String(placa).toUpperCase()}`;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => ALLOWED_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => `${relRoot}/${f}`);
}
// Ocultar portada de la galería/lista
function fotosSinPortada(fotos, portadaUrl){
  if (!portadaUrl) return fotos;
  const cover = (portadaUrl || '').toLowerCase();
  const coverName = cover.split('/').pop();
  return (fotos || []).filter(u => {
    const ul = (u || '').toLowerCase();
    const name = ul.split('/').pop();
    return ul !== cover && name !== coverName;
  });
}

function setToast(req, type, msg) { req.session.toast = { type, msg }; }
function popToast(req) { const t = req.session.toast; req.session.toast = null; return t; }
function requireAdmin(req, res, next) { if (req.session && req.session.admin) return next(); return res.redirect('/admin/login'); }

// ------------ MySQL helpers (placas, docs, reportes)
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
  const id = doc.id;
  const fecha = doc.fecha_vencimiento ? new Date(doc.fecha_vencimiento) : null;
  await pool.query(
    `INSERT INTO documents (id, placa, categoria, titulo, fecha_vencimiento, url, alert22Sent)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       categoria=VALUES(categoria), titulo=VALUES(titulo),
       fecha_vencimiento=VALUES(fecha_vencimiento), url=VALUES(url), alert22Sent=VALUES(alert22Sent)`,
    [id, String(placa).toUpperCase(), doc.categoria, doc.titulo, fecha, doc.url || null, doc.alert22Sent ? 1 : 0]
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
function docStatus(dateStr) {
  if (!dateStr) return { estado: 'sin-fecha', dias: null };
  const v = new Date(dateStr);
  if (isNaN(v)) return { estado: 'sin-fecha', dias: null };
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.floor((v - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return { estado: 'vencido', dias: diff };
  if (diff <= 30) return { estado: 'por-vencer', dias: diff };
  return { estado: 'vigente', dias: diff };
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

// ------------ Rutas públicas
app.get('/', (req, res) => {
  res.render('index', { toast: popToast(req) });
});

app.get('/c/:placa', async (req, res) => {
  const placa = req.params.placa;
  const truck = await getTruck(placa);
  let fotos = truck ? listPhotos(truck.placa) : [];
  fotos = fotosSinPortada(fotos, truck?.foto); // ocultar portada en la galería/lista

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
      return {
        ...d,
        fecha_vencimiento: v ? v.toISOString().slice(0,10) : null,
        estado, dias
      };
    });
    avisos = docs.filter(d => d.estado === 'vencido' || d.estado === 'por-vencer');
  }
  const enviado = req.query.enviado === '1';
  const error = req.query.error === '1';
  res.render('ficha', { truck, fotos, docs, avisos, enviado, error });
});

// QR PNG
app.get('/qr/:placa.png', async (req, res) => {
  try {
    const placa = req.params.placa;
    const url = `${BASE_URL}/c/${encodeURIComponent(placa)}`;
    const buf = await QRCode.toBuffer(url, { type: 'png', width: 320, margin: 1 });
    res.setHeader('Content-Type', 'image/png');
    res.send(buf);
  } catch (err) {
    res.status(500).send('QR error');
  }
});

// ------------ Admin
app.get('/admin/login', (req, res) => res.render('admin/login', { toast: popToast(req) }));
app.post('/admin/login', (req, res) => {
  const pass = (req.body.pass || '').trim();
  if (pass !== ADMIN_PASS) { setToast(req, 'err', 'Contraseña incorrecta'); return res.redirect('/admin/login'); }
  req.session.admin = true; return res.redirect('/admin/editar');
});
app.get('/admin/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

app.get('/admin/editar', requireAdmin, async (req, res) => {
  const placa = (req.query.placa || '').toString().trim();
  let truck = null, fotos = [], docs = [];
  const avisos = await listAlerts();
  if (placa) {
    truck = (await getTruck(placa)) || { placa: placa.toUpperCase(), notas: [], documentos: [] };
    fotos = listPhotos(placa);
    fotos = fotosSinPortada(fotos, truck?.foto); // ocultar portada también en admin si querés
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
  }
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
    // portada NO se toma desde texto; se conserva hasta que la suban/cambien
    foto: existing.foto || '',
    notas
  };
  await upsertTruck(truck);
  setToast(req, 'ok', 'Guardado');
  res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

// Subida múltiple de fotos (galería)
app.post('/admin/upload', requireAdmin, upload.array('archivos', 50), async (req, res) => {
  try {
    const placa = String(req.body.placa || '').trim().toUpperCase();
    if (!placa) { setToast(req, 'err', 'Falta placa'); return res.redirect('/admin/editar'); }
    if (!req.files || !req.files.length) { setToast(req, 'err', 'No se seleccionaron imágenes'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }

    const dir = getUploadDir(placa);
    let ok = 0, fail = 0;
    for (const f of req.files) {
      try {
        const ext = (path.extname(f.originalname) || '.jpg').toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) { fail++; continue; }
        const base = path.basename(f.originalname, ext).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'img';
        let name = `${base}${ext}`;
        let dest = path.join(dir, name);
        let i = 1;
        while (fs.existsSync(dest)) { name = `${base}-${i}${ext}`; dest = path.join(dir, name); i++; }
        fs.writeFileSync(dest, f.buffer);
        ok++;
      } catch { fail++; }
    }
    setToast(req, 'ok', `${ok} imagen(es) subida(s)` + (fail ? `, ${fail} fallida(s)` : ''));
    res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
  } catch (e) {
    setToast(req, 'err', 'Error al subir: ' + e.message);
    res.redirect('/admin/editar?placa=' + encodeURIComponent(req.body.placa || ''));
  }
});

// Edición de imágenes (galería)
app.post('/admin/photo/delete', requireAdmin, (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const name = sanitizeName(String(req.body.name || '').trim());
  if (!placa || !name) { setToast(req, 'err', 'Falta placa o nombre'); return res.redirect('/admin/editar'); }
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) { setToast(req, 'err', 'Extensión no permitida'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }
  const filePath = path.join(getUploadDir(placa), name);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); setToast(req, 'ok', 'Imagen eliminada'); }
  catch (e) { setToast(req, 'err', 'No se pudo eliminar: ' + e.message); }
  return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

app.post('/admin/photo/rename', requireAdmin, (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const name = sanitizeName(String(req.body.name || '').trim());
  let newNameRaw = String(req.body.newName || '').trim();
  if (!placa || !name || !newNameRaw) { setToast(req, 'err', 'Completa placa, nombre y nuevo nombre'); return res.redirect('/admin/editar'); }
  const oldExt = path.extname(name).toLowerCase();
  let newExt = path.extname(newNameRaw).toLowerCase();
  if (!newExt) newExt = oldExt;
  if (!ALLOWED_EXTS.has(newExt)) { setToast(req, 'err', 'Extensión no permitida'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }
  const newBase = path.basename(newNameRaw, path.extname(newNameRaw)).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'img';
  const newName = newBase + newExt;
  const dir = getUploadDir(placa);
  const oldPath = path.join(dir, name);
  const newPath = path.join(dir, newName);
  try {
    if (!fs.existsSync(oldPath)) setToast(req, 'err', 'Archivo original no existe');
    else if (fs.existsSync(newPath)) setToast(req, 'err', 'Ya existe un archivo con ese nombre');
    else { fs.renameSync(oldPath, newPath); setToast(req, 'ok', 'Imagen renombrada'); }
  } catch (e) { setToast(req, 'err', 'No se pudo renombrar: ' + e.message); }
  return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

app.post('/admin/photo/replace', requireAdmin, upload.single('nuevo'), (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const name = sanitizeName(String(req.body.name || '').trim());
  if (!placa || !name) { setToast(req, 'err', 'Falta placa o nombre'); return res.redirect('/admin/editar'); }
  if (!req.file) { setToast(req, 'err', 'No se adjuntó imagen'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }
  const target = path.join(getUploadDir(placa), name);
  try { fs.writeFileSync(target, req.file.buffer); setToast(req, 'ok', 'Imagen reemplazada'); }
  catch (e) { setToast(req, 'err', 'No se pudo reemplazar: ' + e.message); }
  return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

app.post('/admin/photo/cover', requireAdmin, async (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const name = sanitizeName(String(req.body.name || '').trim());
  if (!placa || !name) { setToast(req, 'err', 'Falta placa o nombre'); return res.redirect('/admin/editar'); }
  const truck = (await getTruck(placa));
  if (!truck) { setToast(req, 'err', 'No se encontró la placa'); return res.redirect('/admin/editar'); }
  truck.foto = `/uploads/${placa}/${name}`;
  await upsertTruck(truck);
  setToast(req, 'ok', 'Establecida como portada');
  return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

// Subir portada (obligatorio subir, no URL)
app.post('/admin/cover/upload', requireAdmin, upload.single('portada'), async (req,res)=>{
  const placa = String(req.body.placa||'').trim().toUpperCase();
  if (!placa){ setToast(req,'err','Falta placa'); return res.redirect('/admin/editar'); }
  if (!req.file){ setToast(req,'err','Adjunta una imagen'); return res.redirect('/admin/editar?placa='+encodeURIComponent(placa)); }

  const dir = getUploadDir(placa);
  const ext = (path.extname(req.file.originalname) || '.jpg').toLowerCase();
  if (!ALLOWED_EXTS.has(ext)){ setToast(req,'err','Extensión no permitida'); return res.redirect('/admin/editar?placa='+encodeURIComponent(placa)); }
  const base = path.basename(req.file.originalname, ext).replace(/[^a-zA-Z0-9._-]+/g,'_') || 'portada';
  let name = `${base}${ext}`;
  let dest = path.join(dir, name);
  let i=1;
  while (fs.existsSync(dest)){ name = `${base}-${i}${ext}`; dest = path.join(dir, name); i++; }
  fs.writeFileSync(dest, req.file.buffer);

  const truck = (await getTruck(placa)) || { placa, notas: [] };
  truck.foto = `/uploads/${placa}/${name}`;
  await upsertTruck(truck);

  setToast(req,'ok','Portada actualizada');
  return res.redirect('/admin/editar?placa='+encodeURIComponent(placa));
});

// CRUD documentos manual
app.post('/admin/doc/add', requireAdmin, async (req, res) => {
  const b = req.body;
  const placa = String(b.placa || '').trim().toUpperCase();
  if (!placa) { setToast(req, 'err', 'Falta placa'); return res.redirect('/admin/editar'); }
  const categoria = (b.categoria || '').trim();
  const titulo = (b.titulo || '').trim();
  const fecha_vencimiento = (b.fecha_vencimiento || '').trim();
  const url = (b.url || '').trim();
  if (!categoria || !titulo || !fecha_vencimiento) {
    setToast(req, 'err', 'Completa categoría, título y fecha.');
    return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
  }
  const doc = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), categoria, titulo, fecha_vencimiento, url, alert22Sent: false };
  await upsertDoc(placa, doc);
  setToast(req, 'ok', 'Documento agregado');
  res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});
app.post('/admin/doc/delete', requireAdmin, async (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const id = (req.body.id || '').trim();
  if (!placa || !id) { setToast(req, 'err', 'Falta placa o id'); return res.redirect('/admin/editar'); }
  const ok = await deleteDoc(placa, id);
  setToast(req, ok ? 'ok' : 'err', ok ? 'Documento eliminado' : 'No encontrado');
  res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

// Subir imagen de documento y asociarla
app.post('/admin/doc/upload', requireAdmin, upload.single('archivo'), async (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const categoria = (req.body.categoria || '').trim() || 'DOC';
  const titulo = (req.body.titulo || '').trim() || 'Documento';
  const fecha_vencimiento = (req.body.fecha_vencimiento || '').trim();
  if (!placa) { setToast(req, 'err', 'Falta placa'); return res.redirect('/admin/editar'); }
  if (!req.file) { setToast(req, 'err', 'Sube una imagen'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }
  if (!fecha_vencimiento) { setToast(req, 'err', 'Ingresá la fecha de vencimiento'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }

  const dir = getUploadDir(placa);
  const ext = (path.extname(req.file.originalname) || '.jpg').toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) { setToast(req,'err','Extensión no permitida'); return res.redirect('/admin/editar?placa='+encodeURIComponent(placa)); }
  const base = path.basename(req.file.originalname, ext).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'doc';
  let name = `${base}${ext}`;
  let dest = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(dest)) { name = `${base}-${i}${ext}`; dest = path.join(dir, name); i++; }
  fs.writeFileSync(dest, req.file.buffer);
  const urlRel = `/uploads/${placa}/${name}`;

  const doc = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), categoria, titulo, fecha_vencimiento, url: urlRel, alert22Sent: false };
  await upsertDoc(placa, doc);
  setToast(req, 'ok', 'Documento creado con imagen');
  return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

// -------- Reporte público (form al final de la ficha)
app.post('/c/:placa/report', async (req, res) => {
  const placa = String(req.params.placa || '').toUpperCase();

  const tipo = (req.body.tipo || 'Otro').trim();
  const nombre = (req.body.nombre || '').trim();
  const telefono = (req.body.telefono || '').trim();
  const email = (req.body.email || '').trim();
  const mensaje = (req.body.mensaje || '').trim();

  // Honeypot anti-spam
  const empresa = (req.body.empresa || '').trim();
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

// API avisos (json)
app.get('/api/avisos', requireAdmin, async (req, res) => res.json(await listAlerts()));

// ------------ Health check simple para Render (no toca DB)
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// ------------ CRON: mail 22 días antes (desactivable con DISABLE_CRON=true)
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
    } catch (e) {
      console.error('Cron error:', e.message);
    }
  }, { timezone: process.env.TZ || 'America/Costa_Rica' });
}

// ------------ Arranque seguro: espera DB y escucha UNA sola vez
async function waitForDb(maxRetries = 10, delayMs = 2000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const [rows] = await pool.query('SELECT 1 AS ok');
      if (rows?.[0]?.ok === 1) {
        console.log('DB OK');
        return;
      }
    } catch (e) {
      console.log(`DB retry ${i}/${maxRetries}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  console.warn('DB no disponible, arrancando igual.');
}

let serverStarted = false;
function startServer() {
  if (serverStarted) return; // evita doble arranque
  serverStarted = true;
  const PORT = process.env.PORT || 3000; // en Render será 10000
  app.listen(PORT, () => {
    console.log(`Servidor en ${process.env.BASE_URL || 'http://localhost:'+PORT}`);
  });
}

(async () => {
  try {
    await waitForDb();
    startServer();
  } catch (e) {
    console.error('Fallo al iniciar:', e);
    process.exit(1);
  }
})();
