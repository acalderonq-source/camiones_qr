// server.js  — Camiones QR (Express/EJS/Multer)
// - Sin IA
// - Portada solo por subida de imagen (/admin/cover/upload)
// - Permisos con fecha de vencimiento + correo 22 días antes
// - Galería + edición de imágenes (portada / renombrar / reemplazar / eliminar)
// - Reportes públicos (queja/recomendación/otro) guardados en data/reports.json + email opcional

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

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASS = process.env.ADMIN_PASS || 'tomza-1234';

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
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
});

// ------------ Archivos de datos
const DATA_DIR = path.join(__dirname, 'data');
const TRUCKS_PATH = path.join(DATA_DIR, 'trucks.json');
const REPORTS_PATH = path.join(DATA_DIR, 'reports.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TRUCKS_PATH)) fs.writeFileSync(TRUCKS_PATH, '[]', 'utf-8');
if (!fs.existsSync(REPORTS_PATH)) fs.writeFileSync(REPORTS_PATH, '[]', 'utf-8');

function loadTrucks() { try { return JSON.parse(fs.readFileSync(TRUCKS_PATH, 'utf-8')); } catch { return []; } }
function saveTrucks(list) { fs.writeFileSync(TRUCKS_PATH, JSON.stringify(list, null, 2), 'utf-8'); }
function loadReports() { try { return JSON.parse(fs.readFileSync(REPORTS_PATH, 'utf-8')); } catch { return []; } }
function saveReports(list) { fs.writeFileSync(REPORTS_PATH, JSON.stringify(list, null, 2), 'utf-8'); }

function getTruck(placa) {
  const list = loadTrucks();
  return list.find(t => (t.placa || '').toLowerCase() === String(placa || '').toLowerCase());
}
function upsertTruck(data) {
  const list = loadTrucks();
  const i = list.findIndex(t => (t.placa || '').toLowerCase() === String(data.placa || '').toLowerCase());
  if (i >= 0) list[i] = data; else list.push(data);
  saveTrucks(list);
}
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
  return fs.readdirSync(dir)
    .filter(f => ALLOWED_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => `${relRoot}/${f}`);
}

function setToast(req, type, msg) { req.session.toast = { type, msg }; }
function popToast(req) { const t = req.session.toast; req.session.toast = null; return t; }
function requireAdmin(req, res, next) { if (req.session && req.session.admin) return next(); return res.redirect('/admin/login'); }

// ------------ Documentos (permisos)
function docStatus(dateStr) {
  if (!dateStr) return { estado: 'sin-fecha', dias: null };
  const v = new Date(dateStr);
  if (isNaN(v)) return { estado: 'sin-fecha', dias: null };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.floor((v - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return { estado: 'vencido', dias: diff };
  if (diff <= 30) return { estado: 'por-vencer', dias: diff };
  return { estado: 'vigente', dias: diff };
}
function listAlerts() {
  const out = [];
  const all = loadTrucks();
  for (const t of all) {
    const docs = Array.isArray(t.documentos) ? t.documentos : [];
    for (const d of docs) {
      const st = docStatus(d.fecha_vencimiento);
      if (st.estado === 'vencido' || st.estado === 'por-vencer') {
        out.push({ placa: t.placa, ...d, estado: st.estado, dias: st.dias });
      }
    }
  }
  out.sort((a, b) => {
    const pr = x => x.estado === 'vencido' ? 0 : 1;
    if (pr(a) !== pr(b)) return pr(a) - pr(b);
    return (a.dias || 0) - (b.dias || 0);
  });
  return out;
}
function upsertDoc(placa, doc) {
  const list = loadTrucks();
  const i = list.findIndex(t => (t.placa || '').toLowerCase() === String(placa || '').toLowerCase());
  if (i < 0) return false;
  list[i].documentos = Array.isArray(list[i].documentos) ? list[i].documentos : [];
  const j = list[i].documentos.findIndex(d => d.id === doc.id);
  if (j >= 0) list[i].documentos[j] = doc;
  else list[i].documentos.push(doc);
  saveTrucks(list);
  return true;
}
function deleteDoc(placa, id) {
  const list = loadTrucks();
  const i = list.findIndex(t => (t.placa || '').toLowerCase() === String(placa || '').toLowerCase());
  if (i < 0) return false;
  const before = (list[i].documentos || []).length;
  list[i].documentos = (list[i].documentos || []).filter(d => String(d.id) !== String(id));
  const after = list[i].documentos.length;
  saveTrucks(list);
  return after < before;
}

// ------------ Rutas públicas
app.get('/', (req, res) => {
  res.render('index', { toast: popToast(req) });
});

app.get('/c/:placa', (req, res) => {
  const placa = req.params.placa;
  const truck = getTruck(placa);
  let fotos = truck ? listPhotos(truck.placa) : [];
  fotos = fotosSinPortada(fotos, truck?.foto);
  let docs = [];
  let avisos = [];
  if (truck) {
    docs = (truck.documentos || []).map(d => ({ ...d, ...docStatus(d.fecha_vencimiento) }));
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

app.get('/admin/editar', requireAdmin, (req, res) => {
  const placa = (req.query.placa || '').toString().trim();
  let truck = null, fotos = [], docs = [];
  const avisos = listAlerts();
  if (placa) {
    truck = getTruck(placa) || { placa: placa.toUpperCase(), notas: [], documentos: [] };
    fotos = listPhotos(placa);
    docs = (truck.documentos || []).map(d => ({ ...d, ...docStatus(d.fecha_vencimiento) }));
  }
  res.render('admin/editar', { placa, truck, fotos, docs, avisos, toast: popToast(req) });
});

app.post('/admin/editar', requireAdmin, (req, res) => {
  const b = req.body;
  const placa = String(b.placa || '').trim().toUpperCase();
  if (!placa) { setToast(req, 'err', 'La placa es obligatoria'); return res.redirect('/admin/editar'); }
  const existing = getTruck(placa) || {};
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
    // La portada ya NO se toma por texto; se conserva la que exista hasta que la suban
    foto: existing.foto || '',
    notas,
    documentos: existing.documentos || []
  };
  upsertTruck(truck);
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
        const ext = path.extname(f.originalname) || '.jpg';
        const base = path.basename(f.originalname, ext).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'img';
        let name = `${base}${ext}`;
        let dest = path.join(dir, name);
        let i = 1;
        while (fs.existsSync(dest)) { name = `${base}-${i}${ext}`; dest = path.join(dir, name); i++; }
        fs.writeFileSync(dest, f.buffer);
        ok++;
      } catch (e) { fail++; }
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

app.post('/admin/photo/cover', requireAdmin, (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const name = sanitizeName(String(req.body.name || '').trim());
  if (!placa || !name) { setToast(req, 'err', 'Falta placa o nombre'); return res.redirect('/admin/editar'); }
  const truck = getTruck(placa);
  if (!truck) { setToast(req, 'err', 'No se encontró la placa'); return res.redirect('/admin/editar'); }
  truck.foto = `/uploads/${placa}/${name}`;
  upsertTruck(truck);
  setToast(req, 'ok', 'Establecida como portada');
  return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

// NUEVO: Subir portada (obligatorio subir, no URL)
app.post('/admin/cover/upload', requireAdmin, upload.single('portada'), (req,res)=>{
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

  const truck = getTruck(placa) || { placa, notas: [], documentos: [] };
  truck.foto = `/uploads/${placa}/${name}`;
  upsertTruck(truck);

  setToast(req,'ok','Portada actualizada');
  return res.redirect('/admin/editar?placa='+encodeURIComponent(placa));
});

// CRUD documentos manual
app.post('/admin/doc/add', requireAdmin, (req, res) => {
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
  const ok = upsertDoc(placa, doc);
  setToast(req, ok ? 'ok' : 'err', ok ? 'Documento agregado' : 'No se encontró la placa');
  res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});
app.post('/admin/doc/delete', requireAdmin, (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const id = (req.body.id || '').trim();
  if (!placa || !id) { setToast(req, 'err', 'Falta placa o id'); return res.redirect('/admin/editar'); }
  const ok = deleteDoc(placa, id);
  setToast(req, ok ? 'ok' : 'err', ok ? 'Documento eliminado' : 'No encontrado');
  res.redirect('/admin/editar?placa=' + encodeURIComponent(placa));
});

// Subir imagen de documento (sin IA) y asociarla
app.post('/admin/doc/upload', requireAdmin, upload.single('archivo'), (req, res) => {
  const placa = String(req.body.placa || '').trim().toUpperCase();
  const categoria = (req.body.categoria || '').trim() || 'DOC';
  const titulo = (req.body.titulo || '').trim() || 'Documento';
  const fecha_vencimiento = (req.body.fecha_vencimiento || '').trim();
  if (!placa) { setToast(req, 'err', 'Falta placa'); return res.redirect('/admin/editar'); }
  if (!req.file) { setToast(req, 'err', 'Sube una imagen'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }
  if (!fecha_vencimiento) { setToast(req, 'err', 'Ingresá la fecha de vencimiento'); return res.redirect('/admin/editar?placa=' + encodeURIComponent(placa)); }

  const dir = getUploadDir(placa);
  const ext = path.extname(req.file.originalname) || '.jpg';
  const base = path.basename(req.file.originalname, ext).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'doc';
  let name = `${base}${ext}`;
  let dest = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(dest)) { name = `${base}-${i}${ext}`; dest = path.join(dir, name); i++; }
  fs.writeFileSync(dest, req.file.buffer);
  const urlRel = `/uploads/${placa}/${name}`;

  const doc = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), categoria, titulo, fecha_vencimiento, url: urlRel, alert22Sent: false };
  const ok = upsertDoc(placa, doc);
  setToast(req, ok ? 'ok' : 'err', ok ? 'Documento creado con imagen' : 'No se encontró la placa');
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
  const list = loadReports();
  list.push(rep);
  saveReports(list);

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
app.get('/api/avisos', requireAdmin, (req, res) => res.json(listAlerts()));

// ------------ CRON: mail 22 días antes
cron.schedule('0 9 * * *', async () => {
  try {
    const trucks = loadTrucks();
    const avisos = [];
    for (const t of trucks) {
      const docs = Array.isArray(t.documentos) ? t.documentos : [];
      for (const d of docs) {
        const st = docStatus(d.fecha_vencimiento);
        if (st.estado === 'por-vencer' && st.dias === 22 && !d.alert22Sent) {
          avisos.push({ placa: t.placa, ...d });
          d.alert22Sent = true;
        }
      }
    }
    if (avisos.length && transporter) {
      const listHtml = avisos.map(a => `<li><b>${a.placa}</b> — ${a.categoria}: ${a.titulo}<br/>Vence: <b>${a.fecha_vencimiento || '(sin fecha)'}</b></li>`).join('');
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: process.env.ALERT_EMAIL_TO,
        subject: `Avisos de vencimiento (22 días) — ${new Date().toLocaleDateString()}`,
        html: `<p>Documentos por vencer en 22 días:</p><ul>${listHtml}</ul>`
      });
      saveTrucks(trucks); // persiste alert22Sent
    }
  } catch (e) {
    console.error('Cron error:', e.message);
  }
}, { timezone: process.env.TZ || 'America/Costa_Rica' });

// ------------ Start
app.listen(PORT, () => {
  console.log(`Servidor en ${BASE_URL}`);
});
