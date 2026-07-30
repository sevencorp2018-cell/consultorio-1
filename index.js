require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const { default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const cors = require('cors');
const morgan = require('morgan');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const https = require('https');

const app = express();
app.use(cors());
app.use(morgan('short'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4',
});

// ============================================================
// SILENCIO
// ============================================================
const silenced = new Map();
const SILENCE_DURATION_MS = 60 * 60 * 1000;

function isSilenced(telefono) {
  if (!silenced.has(telefono)) return false;
  const entry = silenced.get(telefono);
  if (Date.now() - entry.silencedAt.getTime() >= SILENCE_DURATION_MS) {
    silenced.delete(telefono);
    return false;
  }
  return true;
}
function silencePatient(tel, by) { silenced.set(tel, { silencedAt: new Date(), silencedBy: by }); }
function releasePatient(tel) { silenced.delete(tel); }
function getTimeUntilRelease(tel) {
  if (!silenced.has(tel)) return 0;
  return Math.max(0, SILENCE_DURATION_MS - (Date.now() - silenced.get(tel).silencedAt.getTime()));
}

// ============================================================
// SESIONES
// ============================================================
const sessions = new Map();

const MENU_PACIENTE = `╔══════════════════════════╗
║  PORTAL DE ESPECIALIDADES  ║
╚══════════════════════════╝

Hola, soy el asistente virtual. Elige una opción:

1  Consultar Mis Citas
2  Mis Tratamientos Activos
3  Agendar Nueva Cita
4  Mis Recetas Electrónicas
5  Mi Historial Clínico
6  Hablar con el Médico
7  Datos del Consultorio

Responde solo el número de la opción deseada.`;

const MENU_DOCTOR = `╔══════════════════════════╗
║     MENÚ DEL MÉDICO       ║
╚══════════════════════════╝

1  Buscar paciente por cédula
2  Mis citas de hoy
3  Recetar medicamento
0  Menú de paciente`;

// ============================================================
// MULTI-DOCTOR MANAGEMENT
// ============================================================
const sockets = new Map();
const doctoresQR = new Map();
const doctoresEstado = new Map();
const numerosDoctores = new Map();
const doctoresInfo = new Map();
const mensajesEnviados = new Set();

// ============================================================
// AUTH STATE PER DOCTOR
// ============================================================
async function useMySQLAuthState(doctorId) {
  const key = `baileys_auth_state_${doctorId}`;
  const [rows] = await pool.query("SELECT valor FROM configuracion WHERE clave = ?", [key]);
  let creds;
  const keyData = {};

  if (rows.length > 0 && rows[0].valor) {
    try {
      const saved = JSON.parse(rows[0].valor, BufferJSON.reviver);
      creds = saved.creds;
      if (saved.keys) Object.assign(keyData, saved.keys);
      console.log(`✅ Sesión doctor ${doctorId} cargada desde MySQL`);
    } catch (e) {
      console.log(`⚠️ Error doctor ${doctorId}:`, e.message);
      creds = initAuthCreds();
    }
  } else {
    console.log(`🆕 Doctor ${doctorId}: no hay sesión. QR pendiente.`);
    creds = initAuthCreds();
  }

  const keysStore = {
    get: async (type, ids) => {
      const data = keyData[type];
      if (!data) return {};
      const r = {};
      for (const id of ids) if (data[id]) r[id] = data[id];
      return r;
    },
    set: async (data) => {
      for (const type in data) {
        if (!keyData[type]) keyData[type] = {};
        Object.assign(keyData[type], data[type]);
      }
    },
  };

  const saveState = async () => {
    try {
      await pool.query("REPLACE INTO configuracion (clave, valor) VALUES (?, ?)",
        [key, JSON.stringify({ creds, keys: keyData }, BufferJSON.replacer)]);
    } catch (e) { console.error(`Error guardando doctor ${doctorId}:`, e.message); }
  };

  return { state: { creds, keys: keysStore }, saveState };
}

// ============================================================
// INICIAR WHATSAPP PARA UN DOCTOR
// ============================================================
async function iniciarWhatsApp(doctorId) {
  const auth = await useMySQLAuthState(doctorId);
  const docInfo = doctoresInfo.get(doctorId);

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: auth.state,
    logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
    browser: [`Dr. ${docInfo?.nombre || doctorId}`, 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', async () => { await auth.saveState(); });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      doctoresQR.set(doctorId, qr);
      qrcode.generate(qr, { small: true });
      console.log(`📱 QR para doctor ${doctorId} (${docInfo?.nombre || '?'})`);
      doctoresEstado.set(doctorId, 'qr_pendiente');
    }

    if (connection === 'open') {
      console.log(`✅ Doctor ${doctorId} (${docInfo?.nombre || '?'}) CONECTADO: ${sock.user?.id?.split(':')[0]}`);
      doctoresQR.delete(doctorId);
      doctoresEstado.set(doctorId, 'conectado');
      await auth.saveState();
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      doctoresEstado.set(doctorId, `desconectado (${reason})`);
      console.log(`❌ Doctor ${doctorId} desconectado: ${DisconnectReason[reason] || reason}`);

      if (reason === DisconnectReason.loggedOut) {
        await pool.query("DELETE FROM configuracion WHERE clave = ?", [`baileys_auth_state_${doctorId}`]);
        console.log(`🗑️ Sesión doctor ${doctorId} eliminada. QR pendiente...`);
        setTimeout(() => iniciarWhatsApp(doctorId), 2000);
      } else {
        setTimeout(() => iniciarWhatsApp(doctorId), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        const remoteJid = msg.key?.remoteJid || '';
        if (!remoteJid.endsWith('@s.whatsapp.net')) continue;
        if (!msg.message) continue;

        // Skip bot echoes (messages it just sent)
        if (msg.key?.fromMe) {
          if (mensajesEnviados.has(msg.key.id)) {
            mensajesEnviados.delete(msg.key.id);
            continue;
          }
          // fromMe true + no trackeado = doctor envió desde su teléfono
        }

        const telefono = remoteJid.replace('@s.whatsapp.net', '');
        const pushName = msg.pushName || '';

        let texto = '';
        const mType = Object.keys(msg.message)[0];
        if (mType === 'conversation') texto = msg.message.conversation || '';
        else if (mType === 'extendedTextMessage') texto = msg.message.extendedTextMessage?.text || '';
        if (!texto) continue;

        console.log(`📩 [Doc ${doctorId}] ${pushName || telefono}: "${texto.substring(0, 80)}"`);

        if (numerosDoctores.get(telefono) === doctorId) {
          await procesarMensajeDoctor(doctorId, telefono, texto);
        } else {
          await procesarMensajePaciente(doctorId, telefono, texto);
        }
      } catch (err) {
        console.error(`Error en doctor ${doctorId}:`, err.message);
      }
    }
  });

  sockets.set(doctorId, sock);
}

// ============================================================
// INICIALIZAR TODOS LOS DOCTORES
// ============================================================
async function inicializarTodosDoctores() {
  try {
    const [rows] = await pool.query(
      'SELECT id, nombre, telefono FROM doctores WHERE activo = 1 AND telefono IS NOT NULL'
    );
    for (const doc of rows) {
      numerosDoctores.set(doc.telefono, doc.id);
      doctoresInfo.set(doc.id, doc);
      iniciarWhatsApp(doc.id);
    }
    console.log(`📋 ${rows.length} doctores cargados para iniciar sockets`);
  } catch (err) {
    console.error('Error cargando doctores:', err.message);
  }
}

// ============================================================
// ENVIAR WHATSAPP (con doctorId)
// ============================================================
async function enviarWhatsApp(doctorId, telefono, mensaje) {
  const sock = sockets.get(doctorId);
  if (!sock) {
    console.error(`Socket doctor ${doctorId} no disponible`);
    return false;
  }
  try {
    const jid = telefono.includes('@s.whatsapp.net') ? telefono : `${telefono}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text: mensaje });
    if (result?.key?.id) {
      mensajesEnviados.add(result.key.id);
      setTimeout(() => mensajesEnviados.delete(result.key.id), 60000);
    }
    return true;
  } catch (err) {
    console.error(`Error enviando WA doctor ${doctorId} a ${telefono}:`, err.message);
    return false;
  }
}

// ============================================================
// PROCESAR MENSAJE DE PACIENTE
// ============================================================
async function procesarMensajePaciente(doctorId, telefono, texto) {
  texto = texto.trim();

  if (isSilenced(telefono)) return;

  let session = sessions.get(telefono);

  if (!session) {
    sessions.set(telefono, { state: 'MENU', data: { doctorId } });
    await enviarWhatsApp(doctorId, telefono, MENU_PACIENTE);
    return;
  }

  session.data.doctorId = doctorId;
  const state = session.state;

  const send = (msg) => enviarWhatsApp(doctorId, telefono, msg);

  switch (state) {

    case 'MENU':
      switch (texto) {
        case '1':
          session.state = 'CITAS_CEDULA'; session.data = { doctorId };
          await send('CONSULTAR CITAS\n\nIngresa tu cédula (solo números, sin letras ni guiones):');
          break;
        case '2':
          session.state = 'TRATAMIENTOS_CEDULA'; session.data = { doctorId };
          await send('MIS TRATAMIENTOS\n\nIngresa tu cédula para consultar tus tratamientos activos:');
          break;
        case '3':
          session.state = 'AGENDAR_PASO1'; session.data = { doctorId };
          await send('AGENDAR NUEVA CITA\n\nVamos a agendar tu cita paso a paso.\n\nPrimero, ingresa tu cédula (solo números):');
          break;
        case '4':
          session.state = 'RECETAS_CEDULA'; session.data = { doctorId };
          await send('MIS RECETAS\n\nIngresa tu cédula para ver tus recetas electrónicas:');
          break;
        case '5':
          session.state = 'HISTORIAL_CEDULA'; session.data = { doctorId };
          await send('HISTORIAL CLÍNICO\n\nIngresa tu cédula para consultar tu historial:');
          break;
        case '6':
          session.state = 'MENSAJE_MEDICO'; session.data = { doctorId };
          await send('HABLAR CON EL MÉDICO\n\nEscribe el mensaje que deseas enviarle al doctor. Incluye tu nombre y el motivo de tu contacto.\n\n(Escribe "cancelar" para volver al menú principal)');
          break;
        case '7':
          const centros = await listarCentros();
          let mc = 'CENTROS MÉDICOS\n\n';
          for (const c of centros) {
            mc += `${c.nombre}\n  ${c.direccion || ''}\n  ${c.telefono || ''}\n  ${c.horario_atencion || ''}\n\n`;
          }
          mc += '0  Volver al menú principal';
          await send(mc);
          session.state = 'MENU';
          break;
        case '0':
          await send(MENU_PACIENTE);
          break;
        default:
          await send(`Opción no válida. Responde solo el número:\n\n1  Consultar Mis Citas\n2  Mis Tratamientos Activos\n3  Agendar Nueva Cita\n4  Mis Recetas Electrónicas\n5  Mi Historial Clínico\n6  Hablar con el Médico\n7  Datos del Consultorio`);
      }
      break;

    case 'CITAS_CEDULA':
      session.data.cedula = texto;
      const citas = await buscarCitasPorCedula(texto, doctorId);
      if (citas.length === 0) {
        await send(`No se encontraron citas para la cédula ${texto}.\n\n1  Intentar de nuevo\n2  Agendar nueva cita\n0  Volver al menú principal`);
        session.state = 'CITAS_OPCIONES';
      } else {
        let msg = `TUS CITAS (${citas.length})\n\n`;
        for (const c of citas) {
          const est = { Pendiente: 'PENDIENTE', Confirmada: 'CONFIRMADA', Completada: 'COMPLETADA', Cancelada: 'CANCELADA' };
          msg += `${new Date(c.fecha).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}\n`;
          msg += `Hora: ${c.hora?.substring(0, 5)}\n`;
          if (c.doctor_nombre) msg += `Dr. ${c.doctor_nombre}\n`;
          msg += `${c.centro_nombre}\n`;
          if (c.motivo) msg += `${c.motivo.substring(0, 80)}\n`;
          msg += `Estado: ${est[c.estado] || c.estado}\n\n`;
        }
        msg += '0  Volver al menú principal';
        await send(msg);
        session.state = 'MENU';
      }
      break;

    case 'CITAS_OPCIONES':
      if (texto === '1') {
        session.state = 'CITAS_CEDULA';
        await send('Ingresa tu cédula nuevamente:');
      } else if (texto === '2') {
        session.state = 'AGENDAR_PASO1'; session.data = { doctorId };
        await send('AGENDAR NUEVA CITA\n\nIngresa tu cédula para comenzar:');
      } else {
        session.state = 'MENU';
        await send(MENU_PACIENTE);
      }
      break;

    case 'TRATAMIENTOS_CEDULA':
      session.data.cedula = texto;
      const tratamientos = await buscarTratamientosPorCedula(texto, doctorId);
      if (tratamientos.length === 0) {
        await send(`No tienes tratamientos activos registrados.\n\n0  Volver al menú principal`);
      } else {
        let msg = `TRATAMIENTOS ACTIVOS (${tratamientos.length})\n\n`;
        for (const t of tratamientos) {
          const prox = new Date(t.proxima_toma);
          const diff = prox - new Date();
          const horas = Math.floor(diff / 3600000);
          const mins = Math.floor((diff % 3600000) / 60000);
          msg += `${t.nombre_tratamiento}\n  Dosis: ${t.dosis}\n  Cada: ${t.frecuencia_horas} horas\n`;
          msg += `  Próxima toma: ${prox.toLocaleDateString('es-VE')} ${prox.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}\n`;
          if (horas >= 0 && horas < 999) msg += `  Faltan: ${horas}h ${mins}m\n`;
          msg += `  ${t.centro_nombre}\n\n`;
        }
        msg += '0  Volver al menú principal';
        await send(msg);
      }
      session.state = 'MENU';
      break;

    case 'AGENDAR_PASO1':
      session.data.cedula = texto;
      const pacExistente = await buscarPacientePorCedula(texto, doctorId);
      if (pacExistente) {
        session.data.paciente_id = pacExistente.id;
        session.data.nombre = pacExistente.nombre;
        session.data.apellido = pacExistente.apellido || '';
        session.data.telefono_paciente = pacExistente.telefono || telefono;
        session.data.email = pacExistente.email || '';
        session.data.direccion = pacExistente.direccion || '';
        session.data.fecha_nacimiento = pacExistente.fecha_nacimiento || '';
        session.data.genero = pacExistente.genero || '';
        session.data.doctorId = doctorId;

        await send(`Bienvenido de nuevo, ${pacExistente.nombre}${pacExistente.apellido ? ' ' + pacExistente.apellido : ''}!`);

        session.data.centros = await listarCentros();
        if (session.data.centros.length === 0) {
          await send('No hay centros médicos disponibles.\n0  Volver al menú');
          session.state = 'MENU'; return;
        }
        let cm = 'SELECCIONA EL CENTRO MÉDICO\n\n';
        session.data.centros.forEach((c, i) => { cm += `${i + 1}  ${c.nombre}\n   ${c.direccion || ''}\n`; });
        cm += '\nResponde el número del centro:';
        await send(cm);
        session.state = 'AGENDAR_CENTRO';
      } else {
        await send(`No te encontramos registrado. Vamos a crear tu perfil.\n\nEscribe tu NOMBRE completo (nombres y apellidos):`);
        session.state = 'AGENDAR_NOMBRE';
      }
      break;

    case 'AGENDAR_NOMBRE':
      session.data.nombre = texto;
      await send('Ahora escribe tu TELÉFONO (ej: +584121234567):');
      session.state = 'AGENDAR_TELEFONO';
      break;

    case 'AGENDAR_TELEFONO':
      session.data.telefono_paciente = texto;
      await send('Escribe tu CORREO ELECTRÓNICO (o escribe "no" si no tienes):');
      session.state = 'AGENDAR_EMAIL';
      break;

    case 'AGENDAR_EMAIL':
      session.data.email = (texto.toLowerCase() === 'no' || texto.toLowerCase() === 'ninguno') ? '' : texto;
      await send('Escribe tu DIRECCIÓN de domicilio:');
      session.state = 'AGENDAR_DIRECCION';
      break;

    case 'AGENDAR_DIRECCION':
      session.data.direccion = texto;
      await send('¿Cuál es tu FECHA DE NACIMIENTO?\n\nFormato: DD/MM/AAAA (ej: 15/03/1990)\n(O escribe "no" si prefieres no decirla)');
      session.state = 'AGENDAR_FECHA_NAC';
      break;

    case 'AGENDAR_FECHA_NAC':
      if (texto.toLowerCase() !== 'no') {
        const partes = texto.split('/');
        session.data.fecha_nacimiento = partes.length === 3 ? `${partes[2]}-${partes[1]}-${partes[0]}` : '';
      } else session.data.fecha_nacimiento = '';
      await send('¿Cuál es tu GÉNERO?\n\n1  Masculino\n2  Femenino\n3  Otro\n0  Prefiero no decirlo');
      session.state = 'AGENDAR_GENERO';
      break;

    case 'AGENDAR_GENERO':
      session.data.genero = ({ '1': 'Masculino', '2': 'Femenino', '3': 'Otro', '0': '' })[texto] || '';
      session.data.centros = await listarCentros();
      if (session.data.centros.length === 0) {
        await send('No hay centros disponibles.\n0  Volver al menú');
        session.state = 'MENU'; return;
      }
      let c2 = 'SELECCIONA EL CENTRO MÉDICO\n\n';
      session.data.centros.forEach((c, i) => { c2 += `${i + 1}  ${c.nombre}\n   ${c.direccion || ''}\n`; });
      c2 += '\nResponde el número del centro:';
      await send(c2);
      session.state = 'AGENDAR_CENTRO';
      break;

    case 'AGENDAR_CENTRO': {
      const idxCentro = parseInt(texto) - 1;
      if (isNaN(idxCentro) || !session.data.centros || !session.data.centros[idxCentro]) {
        await send('Número inválido. Elige un número del listado de centros:'); return;
      }
      session.data.centro_id = session.data.centros[idxCentro].id;
      session.data.centro_nombre = session.data.centros[idxCentro].nombre;
      session.data.especialidades = await listarEspecialidades(session.data.centro_id);
      if (session.data.especialidades.length === 0) {
        await send(`No hay especialidades en ${session.data.centro_nombre}.\n\n1  Elegir otro centro\n0  Volver al menú`);
        session.state = 'AGENDAR_OTRO_CENTRO'; return;
      }
      let em = `ESPECIALIDADES EN ${session.data.centro_nombre.toUpperCase()}\n\n`;
      session.data.especialidades.forEach((e, i) => { em += `${i + 1}  ${e.especialidad}\n`; });
      em += '\nResponde el número de la especialidad:';
      await send(em);
      session.state = 'AGENDAR_ESPECIALIDAD';
      break;
    }

    case 'AGENDAR_OTRO_CENTRO':
      if (texto === '1') {
        session.data.centros = await listarCentros();
        let cm = 'SELECCIONA EL CENTRO MÉDICO\n\n';
        session.data.centros.forEach((c, i) => { cm += `${i + 1}  ${c.nombre}\n`; });
        cm += '\nResponde el número:';
        await send(cm);
        session.state = 'AGENDAR_CENTRO';
      } else { session.state = 'MENU'; await send(MENU_PACIENTE); }
      break;

    case 'AGENDAR_ESPECIALIDAD': {
      const idxEsp = parseInt(texto) - 1;
      if (!session.data.especialidades) session.data.especialidades = await listarEspecialidades(session.data.centro_id);
      if (isNaN(idxEsp) || !session.data.especialidades[idxEsp]) {
        await send('Número inválido. Elige una especialidad del listado:'); return;
      }
      session.data.especialidad = session.data.especialidades[idxEsp].especialidad;
      session.data.doctores = await listarDoctores(session.data.centro_id, session.data.especialidad);
      if (session.data.doctores.length === 0) {
        await send(`No hay doctores para ${session.data.especialidad} en ${session.data.centro_nombre}.\n\n1  Elegir otra especialidad\n0  Volver al menú`);
        session.state = 'AGENDAR_OTRA_ESP'; return;
      }
      let dm = `DOCTORES EN ${session.data.centro_nombre.toUpperCase()}\nEspecialidad: ${session.data.especialidad}\n\n`;
      session.data.doctores.forEach((d, i) => {
        dm += `${i + 1}  Dr. ${d.nombre}\n`;
        if (d.registro_medico) dm += `   MPPS: ${d.registro_medico}\n`;
      });
      dm += '\nResponde el número del doctor:';
      await send(dm);
      session.state = 'AGENDAR_DOCTOR';
      break;
    }

    case 'AGENDAR_OTRA_ESP':
      if (texto === '1') {
        session.data.especialidades = await listarEspecialidades(session.data.centro_id);
        if (session.data.especialidades.length === 0) {
          await send('No hay especialidades.\n0  Volver al menú');
          session.state = 'MENU'; return;
        }
        let em2 = 'ESPECIALIDADES\n\n';
        session.data.especialidades.forEach((e, i) => { em2 += `${i + 1}  ${e.especialidad}\n`; });
        em2 += '\nResponde el número:';
        await send(em2);
        session.state = 'AGENDAR_ESPECIALIDAD';
      } else { session.state = 'MENU'; await send(MENU_PACIENTE); }
      break;

    case 'AGENDAR_DOCTOR': {
      const idxDoc = parseInt(texto) - 1;
      if (isNaN(idxDoc) || !session.data.doctores[idxDoc]) {
        await send('Número inválido. Elige un doctor del listado:'); return;
      }
      session.data.doctor_id = session.data.doctores[idxDoc].id;
      session.data.doctor_nombre = session.data.doctores[idxDoc].nombre;
      await send(`Has seleccionado al Dr. ${session.data.doctor_nombre}.\n\nAhora describe el MOTIVO DE TU CONSULTA (ej: dolor de cabeza, control mensual, etc.):`);
      session.state = 'AGENDAR_MOTIVO';
      break;
    }

    case 'AGENDAR_MOTIVO':
      session.data.motivo = texto;
      await send('TIPO DE CONSULTA\n\n1  Presencial - Asistes al consultorio\n2  Teleconsulta - Videollamada\n3  A Domicilio - El médico va a tu casa\n\nResponde el número:');
      session.state = 'AGENDAR_TIPO';
      break;

    case 'AGENDAR_TIPO':
      if (!({ '1': 1, '2': 1, '3': 1 })[texto]) {
        await send('Opción inválida. 1=Presencial, 2=Teleconsulta, 3=Domicilio:'); return;
      }
      session.data.tipo_consulta = ({ '1': 'Presencial', '2': 'Teleconsulta', '3': 'Domicilio' })[texto];
      await send('FECHA DE LA CITA\n\nFormato: DD/MM/AAAA (ej: 25/12/2025)\n\nHorario: Lun-Vie, 8:00 AM - 5:00 PM.');
      session.state = 'AGENDAR_FECHA';
      break;

    case 'AGENDAR_FECHA': {
      const p = texto.split('/');
      if (p.length !== 3) { await send('Formato inválido. Usa DD/MM/AAAA (ej: 25/12/2025):'); return; }
      const fechaStr = `${p[2]}-${p[1]}-${p[0]}`;
      const fechaDate = new Date(fechaStr + 'T12:00:00');
      if (isNaN(fechaDate.getTime())) { await send('Fecha inválida. Usa DD/MM/AAAA:'); return; }
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      if (fechaDate < hoy) { await send('La fecha ya pasó. Ingresa una FUTURA (DD/MM/AAAA):'); return; }
      const ds = fechaDate.getDay();
      if (ds === 0 || ds === 6) { await send('Solo LUNES A VIERNES. Ingresa un día de semana (DD/MM/AAAA):'); return; }
      session.data.fecha = fechaStr;

      const horas = await obtenerHorasDisponibles(session.data.centro_id, session.data.doctor_id, fechaStr);
      if (horas.length === 0) {
        await send(`No hay horas disponibles para el ${texto}.\n\n1  Elegir otra fecha\n0  Volver al menú`);
        session.state = 'AGENDAR_OTRA_FECHA'; return;
      }
      let hm = `HORAS DISPONIBLES PARA EL ${texto}\n\n`;
      horas.forEach((h, i) => {
        hm += `${i + 1}  ${new Date('2000-01-01T' + h).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}\n`;
      });
      hm += '\nResponde el número de la hora:';
      await send(hm);
      session.state = 'AGENDAR_HORA';
      break;
    }

    case 'AGENDAR_OTRA_FECHA':
      if (texto === '1') { session.state = 'AGENDAR_FECHA'; await send('Ingresa la nueva fecha (DD/MM/AAAA):'); }
      else { session.state = 'MENU'; await send(MENU_PACIENTE); }
      break;

    case 'AGENDAR_HORA': {
      const idxH = parseInt(texto) - 1;
      const hDisp = await obtenerHorasDisponibles(session.data.centro_id, session.data.doctor_id, session.data.fecha);
      if (isNaN(idxH) || !hDisp[idxH]) { await send('Hora inválida. Elige un número del listado:'); return; }
      session.data.hora = hDisp[idxH];
      const h12 = new Date('2000-01-01T' + session.data.hora).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
      const fLeg = new Date(session.data.fecha + 'T12:00:00').toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      let cf = `CONFIRMAR CITA\n\nPaciente: ${session.data.nombre} ${session.data.apellido || ''}\nCédula: ${session.data.cedula}\nCentro: ${session.data.centro_nombre}\nEspecialidad: ${session.data.especialidad}\nDoctor: Dr. ${session.data.doctor_nombre}\nFecha: ${fLeg}\nHora: ${h12}\nMotivo: ${session.data.motivo}\nTipo: ${session.data.tipo_consulta}\n\n1  SÍ, confirmar cita\n2  NO, cancelar`;
      await send(cf);
      session.state = 'AGENDAR_CONFIRMAR';
      break;
    }

    case 'AGENDAR_CONFIRMAR':
      if (texto === '1') {
        try {
          const result = await crearCita(session.data);
          if (result.success) {
            const fOk = new Date(session.data.fecha + 'T12:00:00').toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            const hOk = new Date('2000-01-01T' + session.data.hora).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
            await send(`CITA AGENDADA CON ÉXITO\n\nFecha: ${fOk}\nHora: ${hOk}\nDoctor: Dr. ${session.data.doctor_nombre}\nCentro: ${session.data.centro_nombre}\nTipo: ${session.data.tipo_consulta}\n\nRecibirás un recordatorio 24h antes.\n\nIMPORTANTE: Llega 30 minutos antes.\n\n0  Volver al menú principal`);
            const docInfo = await buscarDoctor(session.data.doctor_id);
            if (docInfo && docInfo.telefono) {
              await enviarWhatsApp(doctorId, docInfo.telefono,
                `NUEVA CITA AGENDADA\n\nPaciente: ${session.data.nombre} ${session.data.apellido || ''}\nCédula: ${session.data.cedula}\nTel: ${session.data.telefono_paciente}\nFecha: ${fOk}\nHora: ${hOk}\nMotivo: ${session.data.motivo}\nTipo: ${session.data.tipo_consulta}\nCentro: ${session.data.centro_nombre}`);
            }
          } else {
            await send(`Error al agendar: ${result.error}\n\n0  Volver al menú principal`);
          }
        } catch (err) {
          await send('Error del sistema. Intenta más tarde.\n\n0  Volver al menú principal');
        }
      } else {
        await send('Cita cancelada.\n\n0  Volver al menú principal');
      }
      session.state = 'MENU';
      break;

    case 'RECETAS_CEDULA':
      session.data.cedula = texto;
      const recetas = await buscarRecetasPorCedula(texto, doctorId);
      if (recetas.length === 0) {
        await send('No tienes recetas electrónicas registradas.\n\n0  Volver al menú principal');
      } else {
        let msg = `MIS RECETAS (${recetas.length})\n\n`;
        for (const r of recetas) {
          msg += `Fecha: ${new Date(r.fecha_emision).toLocaleDateString('es-VE')}\n`;
          msg += `Diagnóstico: ${r.diagnostico}\n`;
          if (r.cie10) msg += `CIE-10: ${r.cie10}\n`;
          if (r.doctor_nombre) msg += `Doctor: Dr. ${r.doctor_nombre}\n`;
          msg += `${r.centro_nombre}\n`;
          try {
            const meds = JSON.parse(r.medicamentos || '[]');
            if (meds.length > 0) {
              msg += 'Medicamentos:\n';
              meds.forEach(m => { msg += `  - ${m.nombre} ${m.dosis} c/${m.frecuencia}h\n`; });
            }
          } catch (e) {}
          msg += '\n';
        }
        msg += '0  Volver al menú principal';
        await send(msg);
      }
      session.state = 'MENU';
      break;

    case 'HISTORIAL_CEDULA':
      session.data.cedula = texto;
      const historial = await buscarHistorialPorCedula(texto, doctorId);
      if (historial.length === 0) {
        await send('No tienes registros en tu historial clínico.\n\n0  Volver al menú principal');
      } else {
        let msg = `HISTORIAL CLÍNICO (${historial.length} registros)\n\n`;
        for (const h of historial) {
          msg += `${new Date(h.fecha).toLocaleDateString('es-VE')} - ${h.tipo}\n  ${h.descripcion?.substring(0, 100)}\n  ${h.centro_nombre}\n\n`;
        }
        msg += '0  Volver al menú principal';
        await send(msg);
      }
      session.state = 'MENU';
      break;

    case 'MENSAJE_MEDICO':
      if (texto.toLowerCase() === 'cancelar') {
        session.state = 'MENU'; await send(MENU_PACIENTE); return;
      }
      session.data.mensaje = texto;
      await send('Para que el médico pueda identificarte, escribe tu CÉDULA (solo números):');
      session.state = 'MENSAJE_CEDULA';
      break;

    case 'MENSAJE_CEDULA':
      session.data.cedula = texto;
      const pac = await buscarPacientePorCedula(texto, doctorId);
      const nomPac = pac ? `${pac.nombre} ${pac.apellido || ''}`.trim() : 'Desconocido';
      const telPac = pac ? pac.telefono : telefono;
      const msgMed = `MENSAJE DE PACIENTE\n\nPaciente: ${nomPac}\nTeléfono: ${telPac}\nCédula: ${texto}\n\nMensaje:\n"${session.data.mensaje}"\n\nFecha: ${new Date().toLocaleString('es-VE')}\n\n🔇 Bot silenciado para este paciente. Responde directamente a ${telPac}. El bot se reactiva en 1 hora.`;
      let notif = false;
      if (pac && pac.doctor_id) {
        const docAsig = await buscarDoctor(pac.doctor_id);
        if (docAsig && docAsig.telefono) {
          await enviarWhatsApp(doctorId, docAsig.telefono, msgMed);
          await enviarWhatsApp(doctorId, docAsig.telefono, `🔇 Bot silenciado para ${nomPac} (${telPac}). Responde directo. 1 hora.`);
          notif = true;
        }
      }
      if (!notif) console.log(`⚠️ Paciente ${nomPac} sin médico asignado`);
      silencePatient(telefono, 'MENSAJE_MEDICO');
      await send('Mensaje enviado al médico. Te responderá a la brevedad.\n\n0  Volver al menú principal');
      session.state = 'MENU';
      break;

    default:
      session.state = 'MENU';
      await send(MENU_PACIENTE);
  }
}

// ============================================================
// PROCESAR MENSAJE DE DOCTOR
// ============================================================
async function procesarMensajeDoctor(doctorId, telefono, texto) {
  texto = texto.trim();
  const doctor = doctoresInfo.get(doctorId);
  const send = (msg) => enviarWhatsApp(doctorId, telefono, msg);

  let session = sessions.get(`doc_${doctorId}`);

  if (!session) {
    sessions.set(`doc_${doctorId}`, { state: 'DOCTOR_MENU', data: { doctorId } });
    await send(MENU_DOCTOR);
    return;
  }

  session.data.doctorId = doctorId;
  const state = session.state;

  switch (state) {

    case 'DOCTOR_MENU':
      switch (texto) {
        case '1':
          session.state = 'DOCTOR_BUSCAR_CEDULA'; session.data = { doctorId };
          await send('BUSCAR PACIENTE\n\nIngresa la cédula del paciente (solo números):');
          break;
        case '2':
          await mostrarCitasHoy(doctorId, telefono);
          break;
        case '3':
          session.state = 'DOCTOR_RECETAR_CEDULA'; session.data = { doctorId };
          await send('RECETAR MEDICAMENTO\n\nIngresa la cédula del paciente:');
          break;
        case '0':
          sessions.delete(`doc_${doctorId}`);
          await send(MENU_PACIENTE);
          break;
        default:
          await send(MENU_DOCTOR);
      }
      break;

    case 'DOCTOR_BUSCAR_CEDULA':
      session.data.cedula = texto;
      const paciente = await buscarPacientePorCedula(texto, doctorId);
      if (!paciente) {
        await send(`No se encontró paciente con cédula ${texto} en tus registros.\n\n1  Intentar de nuevo\n0  Volver`);
        session.state = 'DOCTOR_BUSCAR_OTRO';
      } else {
        session.data.paciente = paciente;
        await send(`PACIENTE ENCONTRADO\n\nNombre: ${paciente.nombre} ${paciente.apellido || ''}\nCédula: ${paciente.cedula}\nTel: ${paciente.telefono || 'N/A'}\n\n1  Ver recetas\n2  Ver tratamientos activos\n3  Ver citas\n0  Volver al menú`);
        session.state = 'DOCTOR_VER_PACIENTE';
      }
      break;

    case 'DOCTOR_BUSCAR_OTRO':
      if (texto === '1') {
        session.state = 'DOCTOR_BUSCAR_CEDULA';
        await send('Ingresa la cédula del paciente:');
      } else {
        session.state = 'DOCTOR_MENU';
        await send(MENU_DOCTOR);
      }
      break;

    case 'DOCTOR_VER_PACIENTE':
      switch (texto) {
        case '1': {
          const recs = await buscarRecetasPorCedula(session.data.paciente.cedula, doctorId);
          if (recs.length === 0) {
            await send(`${session.data.paciente.nombre} no tiene recetas registradas.\n\n0  Volver`);
          } else {
            let msg = `RECETAS DE ${session.data.paciente.nombre.toUpperCase()} (${recs.length})\n\n`;
            for (const r of recs) {
              msg += `Fecha: ${new Date(r.fecha_emision).toLocaleDateString('es-VE')}\nDiagnóstico: ${r.diagnostico}\n`;
              if (r.cie10) msg += `CIE-10: ${r.cie10}\n`;
              try {
                const meds = JSON.parse(r.medicamentos || '[]');
                if (meds.length > 0) {
                  msg += 'Medicamentos:\n';
                  meds.forEach(m => { msg += `  - ${m.nombre} ${m.dosis} c/${m.frecuencia}h\n`; });
                }
              } catch (e) {}
              msg += '\n';
            }
            msg += '0  Volver';
            await send(msg);
          }
          break;
        }
        case '2': {
          const trats = await buscarTratamientosPorCedula(session.data.paciente.cedula, doctorId);
          if (trats.length === 0) {
            await send(`${session.data.paciente.nombre} no tiene tratamientos activos.\n\n0  Volver`);
          } else {
            let msg = `TRATAMIENTOS DE ${session.data.paciente.nombre.toUpperCase()} (${trats.length})\n\n`;
            for (const t of trats) {
              const prox = new Date(t.proxima_toma);
              msg += `${t.nombre_tratamiento}\n  Dosis: ${t.dosis} c/${t.frecuencia_horas}h\n  Próxima: ${prox.toLocaleDateString('es-VE')} ${prox.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}\n\n`;
            }
            msg += '0  Volver';
            await send(msg);
          }
          break;
        }
        case '3': {
          const cts = await buscarCitasPorCedula(session.data.paciente.cedula, doctorId);
          if (cts.length === 0) {
            await send(`${session.data.paciente.nombre} no tiene citas registradas.\n\n0  Volver`);
          } else {
            let msg = `CITAS DE ${session.data.paciente.nombre.toUpperCase()} (${cts.length})\n\n`;
            for (const c of cts) {
              const est = { Pendiente: 'PENDIENTE', Confirmada: 'CONFIRMADA', Completada: 'COMPLETADA', Cancelada: 'CANCELADA' };
              msg += `${new Date(c.fecha).toLocaleDateString('es-VE')} ${c.hora?.substring(0, 5)}\n  ${c.motivo?.substring(0, 60)}\n  Estado: ${est[c.estado] || c.estado}\n\n`;
            }
            msg += '0  Volver';
            await send(msg);
          }
          break;
        }
        default:
          session.state = 'DOCTOR_MENU';
          await send(MENU_DOCTOR);
      }
      break;

    case 'DOCTOR_RECETAR_CEDULA':
      session.data.cedula = texto;
      const pacRec = await buscarPacientePorCedula(texto, doctorId);
      if (!pacRec) {
        await send(`No se encontró paciente con cédula ${texto} en tus registros.\n\n1  Intentar de nuevo\n0  Volver`);
        session.state = 'DOCTOR_RECETAR_OTRO';
      } else {
        session.data.pacienteRec = pacRec;
        await send(`Paciente: ${pacRec.nombre} ${pacRec.apellido || ''}\n\nEscribe el DIAGNÓSTICO (o "cancelar"):`);
        session.state = 'DOCTOR_RECETAR_DIAG';
      }
      break;

    case 'DOCTOR_RECETAR_OTRO':
      if (texto === '1') {
        session.state = 'DOCTOR_RECETAR_CEDULA';
        await send('Ingresa la cédula del paciente:');
      } else {
        session.state = 'DOCTOR_MENU';
        await send(MENU_DOCTOR);
      }
      break;

    case 'DOCTOR_RECETAR_DIAG':
      if (texto.toLowerCase() === 'cancelar') {
        session.state = 'DOCTOR_MENU'; await send(MENU_DOCTOR); return;
      }
      session.data.diagnostico = texto;
      await send('Escribe el CIE-10 del diagnóstico (o "no" si no lo sabes):');
      session.state = 'DOCTOR_RECETAR_CIE';
      break;

    case 'DOCTOR_RECETAR_CIE':
      session.data.cie10 = (texto.toLowerCase() === 'no') ? '' : texto;
      await send('Ahora ingresa los MEDICAMENTOS UNO POR UNO.\n\nFormato: Nombre, Dosis, Frecuencia en horas\nEjemplo: Amoxicilina, 500mg, 8\n\nCuando termines, escribe "listo".');
      session.data.medicamentos = [];
      session.state = 'DOCTOR_RECETAR_MED1';
      break;

    case 'DOCTOR_RECETAR_MED1':
      if (texto.toLowerCase() === 'listo') {
        if (session.data.medicamentos.length === 0) {
          await send('Debes agregar al menos un medicamento. Escribe el primer medicamento:');
          return;
        }
        let resumen = `CONFIRMAR RECETA\n\nPaciente: ${session.data.pacienteRec.nombre} ${session.data.pacienteRec.apellido || ''}\nDiagnóstico: ${session.data.diagnostico}\nCIE-10: ${session.data.cie10 || 'N/A'}\n\nMedicamentos:\n`;
        for (const m of session.data.medicamentos) {
          resumen += `  - ${m.nombre} ${m.dosis} c/${m.frecuencia}h\n`;
          // También crear tratamiento para recordatorios
          await pool.query(
            `INSERT INTO tratamientos (centro_id, paciente_id, doctor_id, nombre_tratamiento, dosis, frecuencia_horas, proxima_toma, recordatorio_whatsapp, activo)
             VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), 'SI', 1)`,
            [session.data.pacienteRec.centro_id || 1, session.data.pacienteRec.id, doctorId,
             m.nombre, m.dosis, parseInt(m.frecuencia), parseInt(m.frecuencia)]
          );
        }
        resumen += '\n1  Guardar receta\n2  Cancelar';
        await send(resumen);
        session.state = 'DOCTOR_RECETAR_CONFIRMAR';
        return;
      }
      // Parse medicamento
      const partes = texto.split(',').map(s => s.trim());
      if (partes.length < 3) {
        await send('Formato inválido. Usa: Nombre, Dosis, Frecuencia\nEj: Amoxicilina, 500mg, 8');
        return;
      }
      session.data.medicamentos.push({
        nombre: partes[0],
        dosis: partes[1],
        frecuencia: partes[2],
      });
      await send(`✓ Agregado: ${partes[0]} ${partes[1]} c/${partes[2]}h\n\nEscribe el siguiente medicamento, o "listo" para terminar.`);
      break;

    case 'DOCTOR_RECETAR_CONFIRMAR':
      if (texto === '1') {
        try {
          await pool.query(
            `INSERT INTO recipes (centro_id, paciente_id, doctor_id, diagnostico, cie10, medicamentos, fecha_emision)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [session.data.pacienteRec.centro_id || 1, session.data.pacienteRec.id, doctorId,
             session.data.diagnostico, session.data.cie10 || '',
             JSON.stringify(session.data.medicamentos)]
          );
          await send(`RECETA GUARDADA CON ÉXITO\n\nPaciente: ${session.data.pacienteRec.nombre}\nDiagnóstico: ${session.data.diagnostico}\nMedicamentos: ${session.data.medicamentos.length}\n\nLos recordatorios de medicación se enviarán automáticamente.\n\n0  Volver al menú`);
        } catch (err) {
          await send(`Error guardando receta: ${err.message}\n\n0  Volver`);
        }
      } else {
        await send('Receta cancelada.\n\n0  Volver al menú');
      }
      session.state = 'DOCTOR_MENU';
      break;

    default:
      session.state = 'DOCTOR_MENU';
      await send(MENU_DOCTOR);
  }
}

async function mostrarCitasHoy(doctorId, telefono) {
  const send = (msg) => enviarWhatsApp(doctorId, telefono, msg);
  const hoy = new Date().toISOString().slice(0, 10);
  const [rows] = await pool.query(`
    SELECT c.hora, c.motivo, c.estado, c.tipo_consulta,
           p.nombre AS paciente_nombre, p.cedula, p.telefono AS tel_paciente,
           cen.nombre AS centro_nombre
    FROM citas c
    JOIN pacientes p ON c.paciente_id = p.id
    JOIN centros_medicos cen ON c.centro_id = cen.id
    WHERE c.doctor_id = ? AND c.fecha = ?
    ORDER BY c.hora ASC
  `, [doctorId, hoy]);

  if (rows.length === 0) {
    await send('No tienes citas programadas para hoy.\n\n0  Volver al menú');
  } else {
    let msg = `TUS CITAS DE HOY (${rows.length})\n\n`;
    for (const c of rows) {
      const est = { Pendiente: '⏳', Confirmada: '✅', Completada: '✔️', Cancelada: '❌' };
      msg += `${est[c.estado] || '📌'} ${c.hora?.substring(0, 5)} - ${c.paciente_nombre}\n`;
      msg += `   ${c.motivo?.substring(0, 50)}\n`;
      msg += `   ${c.centro_nombre}\n\n`;
    }
    msg += '0  Volver al menú';
    await send(msg);
  }
}

// ============================================================
// CONSULTAS A LA BASE DE DATOS
// ============================================================
async function buscarCitasPorCedula(cedula, doctorId) {
  const [rows] = await pool.query(`
    SELECT c.fecha, c.hora, c.motivo, c.estado, c.tipo_consulta,
           cen.nombre AS centro_nombre, d.nombre AS doctor_nombre, d.especialidad
    FROM citas c
    JOIN pacientes p ON c.paciente_id = p.id
    JOIN centros_medicos cen ON c.centro_id = cen.id
    LEFT JOIN doctores d ON c.doctor_id = d.id
    WHERE p.cedula = ? AND p.activo = 1 AND c.doctor_id = ?
    ORDER BY c.fecha DESC, c.hora DESC LIMIT 10
  `, [cedula, doctorId]);
  return rows;
}

async function buscarTratamientosPorCedula(cedula, doctorId) {
  const [rows] = await pool.query(`
    SELECT t.nombre_tratamiento, t.dosis, t.frecuencia_horas, t.proxima_toma,
           t.indicaciones, t.recordatorio_whatsapp, t.activo, cen.nombre AS centro_nombre
    FROM tratamientos t
    JOIN pacientes p ON t.paciente_id = p.id
    JOIN centros_medicos cen ON t.centro_id = cen.id
    WHERE p.cedula = ? AND t.activo = 1 AND t.doctor_id = ?
    ORDER BY t.proxima_toma ASC
  `, [cedula, doctorId]);
  return rows;
}

async function buscarPacientePorCedula(cedula, doctorId) {
  const [rows] = await pool.query(
    'SELECT id, nombre, apellido, telefono, email, direccion, fecha_nacimiento, genero, doctor_id, centro_id FROM pacientes WHERE cedula = ? AND doctor_id = ? AND activo = 1 LIMIT 1',
    [cedula, doctorId]);
  return rows.length > 0 ? rows[0] : null;
}

async function buscarRecetasPorCedula(cedula, doctorId) {
  const [rows] = await pool.query(`
    SELECT r.diagnostico, r.cie10, r.medicamentos, r.fecha_emision,
           cen.nombre AS centro_nombre, d.nombre AS doctor_nombre
    FROM recipes r
    JOIN pacientes p ON r.paciente_id = p.id
    JOIN centros_medicos cen ON r.centro_id = cen.id
    LEFT JOIN doctores d ON r.doctor_id = d.id
    WHERE p.cedula = ? AND p.activo = 1 AND r.doctor_id = ?
    ORDER BY r.fecha_emision DESC LIMIT 5
  `, [cedula, doctorId]);
  return rows;
}

async function buscarHistorialPorCedula(cedula, doctorId) {
  const [rows] = await pool.query(`
    SELECT h.tipo, h.descripcion, h.observaciones, h.fecha, cen.nombre AS centro_nombre
    FROM historial_clinico h
    JOIN pacientes p ON h.paciente_id = p.id
    JOIN centros_medicos cen ON h.centro_id = cen.id
    WHERE p.cedula = ? AND p.activo = 1 AND h.doctor_id = ?
    ORDER BY h.fecha DESC LIMIT 15
  `, [cedula, doctorId]);
  return rows;
}

async function buscarDoctor(doctorId) {
  const [rows] = await pool.query(
    'SELECT id, nombre, email, telefono FROM doctores WHERE id = ? AND activo = 1 LIMIT 1',
    [doctorId]);
  return rows.length > 0 ? rows[0] : null;
}

async function listarCentros() {
  const [rows] = await pool.query(
    'SELECT id, nombre, direccion, telefono, horario_atencion FROM centros_medicos WHERE activo = 1 ORDER BY nombre');
  return rows;
}

async function listarEspecialidades(centroId) {
  const [rows] = await pool.query(`
    SELECT DISTINCT d.especialidad FROM doctores d
    JOIN doctor_centros dc ON d.id = dc.doctor_id
    WHERE dc.centro_id = ? AND d.activo = 1 AND dc.activo = 1 AND d.especialidad IS NOT NULL
    ORDER BY d.especialidad`, [centroId]);
  return rows;
}

async function listarDoctores(centroId, especialidad) {
  const [rows] = await pool.query(`
    SELECT d.id, d.nombre, d.especialidad, d.registro_medico
    FROM doctores d JOIN doctor_centros dc ON d.id = dc.doctor_id
    WHERE dc.centro_id = ? AND d.especialidad = ? AND d.activo = 1 AND dc.activo = 1
    ORDER BY d.nombre`, [centroId, especialidad]);
  return rows;
}

async function obtenerHorasDisponibles(centroId, doctorId, fecha) {
  const diaSemana = new Date(fecha + 'T12:00:00').getDay();
  const [horarios] = await pool.query(`
    SELECT MIN(hora_inicio) as hora_inicio, MAX(hora_fin) as hora_fin,
           MIN(pausa_inicio) as pausa_inicio, MAX(pausa_fin) as pausa_fin,
           MIN(hora_inicio_tarde) as hora_inicio_tarde, MAX(hora_fin_tarde) as hora_fin_tarde
    FROM doctor_horarios
    WHERE centro_id = ? AND doctor_id = ? AND dia_semana = ? AND activo = 1
  `, [centroId, doctorId, diaSemana]);
  let horas = [];
  if (horarios.length > 0 && horarios[0].hora_inicio) {
    const h = horarios[0];
    const hi = parseInt(h.hora_inicio.substring(0, 2));
    const hf = parseInt(h.hora_fin.substring(0, 2));
    const pi = h.pausa_inicio ? parseInt(h.pausa_inicio.substring(0, 2)) : null;
    const pf = h.pausa_fin ? parseInt(h.pausa_fin.substring(0, 2)) : null;
    const hit = h.hora_inicio_tarde ? parseInt(h.hora_inicio_tarde.substring(0, 2)) : null;
    const hft = h.hora_fin_tarde ? parseInt(h.hora_fin_tarde.substring(0, 2)) : null;
    for (let i = hi; i < hf; i++) {
      if (pi !== null && i >= pi && i < pf) continue;
      horas.push(`${String(i).padStart(2, '0')}:00:00`);
    }
    if (hit !== null && hft !== null) {
      for (let i = hit; i < hft; i++) horas.push(`${String(i).padStart(2, '0')}:00:00`);
    }
  } else {
    for (let i = 8; i < 12; i++) horas.push(`${String(i).padStart(2, '0')}:00:00`);
    for (let i = 14; i < 17; i++) horas.push(`${String(i).padStart(2, '0')}:00:00`);
  }
  const [ocupadas] = await pool.query(
    'SELECT hora FROM citas WHERE doctor_id = ? AND centro_id = ? AND fecha = ? AND estado NOT IN ("Completada","Cancelada")',
    [doctorId, centroId, fecha]);
  const horasOcupadas = new Set(ocupadas.map(r => r.hora));
  return [...new Set(horas)].filter(h => !horasOcupadas.has(h)).sort();
}

async function crearCita(data) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let [pacientes] = await conn.query(
      'SELECT id FROM pacientes WHERE cedula = ? AND doctor_id = ? AND activo = 1 LIMIT 1',
      [data.cedula, data.doctor_id]);
    let pacienteId;
    if (pacientes.length > 0) {
      pacienteId = pacientes[0].id;
      await conn.query(
        'UPDATE pacientes SET telefono = ?, email = ?, direccion = ?, fecha_nacimiento = ?, genero = ? WHERE id = ?',
        [data.telefono_paciente || '', data.email || '', data.direccion || '',
         data.fecha_nacimiento || null, data.genero || '', pacienteId]);
    } else {
      const hash = '$2y$10$' + require('crypto').randomBytes(22).toString('base64').replace(/\+/g, '.').substring(0, 22);
      const username = (data.nombre || 'paciente').toLowerCase().replace(/\s/g, '') + data.cedula;
      const [result] = await conn.query(
        `INSERT INTO pacientes (centro_id, doctor_id, nombre, apellido, cedula, telefono, email,
         direccion, fecha_nacimiento, genero, password, username, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [data.centro_id, data.doctor_id, data.nombre, data.apellido || '', data.cedula,
         data.telefono_paciente || '', data.email || '', data.direccion || '',
         data.fecha_nacimiento || null, data.genero || '', hash, username]);
      pacienteId = result.insertId;
    }
    await conn.query(
      'INSERT INTO citas (centro_id, doctor_id, paciente_id, fecha, hora, motivo, tipo_consulta, estado) VALUES (?, ?, ?, ?, ?, ?, ?, "Pendiente")',
      [data.centro_id, data.doctor_id, pacienteId, data.fecha, data.hora, data.motivo, data.tipo_consulta]);
    await conn.query(
      'INSERT INTO historial_clinico (centro_id, paciente_id, doctor_id, tipo, descripcion, observaciones) VALUES (?, ?, ?, "Consulta", ?, ?)',
      [data.centro_id, pacienteId, data.doctor_id,
       `Solicitud de cita - ${data.motivo?.substring(0, 200)}`,
       `Agendado por WhatsApp Bot. Tipo: ${data.tipo_consulta}`]);
    await conn.commit();
    return { success: true, citaId: result.insertId, pacienteId };
  } catch (err) {
    await conn.rollback();
    return { success: false, error: err.message };
  } finally { conn.release(); }
}

// ============================================================
// RECORDATORIOS
// ============================================================
async function enviarRecordatoriosTratamientos() {
  try {
    const ahora = new Date();
    const dentroDe1h = new Date(ahora.getTime() + 60 * 60 * 1000);
    const [rows] = await pool.query(`
      SELECT t.*, p.nombre AS paciente_nombre, p.telefono, p.doctor_id, c.nombre AS centro_nombre
      FROM tratamientos t
      JOIN pacientes p ON t.paciente_id = p.id
      JOIN centros_medicos c ON t.centro_id = c.id
      WHERE t.proxima_toma BETWEEN ? AND ? AND t.recordatorio_whatsapp = 'SI' AND t.activo = 1
    `, [ahora.toISOString().slice(0, 19).replace('T', ' '), dentroDe1h.toISOString().slice(0, 19).replace('T', ' ')]);
    for (const t of rows) {
      if (isSilenced(t.telefono)) continue;
      const docId = t.doctor_id;
      await enviarWhatsApp(docId, t.telefono,
        `RECORDATORIO DE MEDICACIÓN\n\nHola ${t.paciente_nombre}, es hora de tu tratamiento:\n\n${t.nombre_tratamiento}\nDosis: ${t.dosis}\n${t.centro_nombre}\nHora: ${new Date(t.proxima_toma).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}\n\nSi ya lo tomaste, ignora este mensaje.`);
      const nuevaToma = new Date(t.proxima_toma);
      nuevaToma.setHours(nuevaToma.getHours() + t.frecuencia_horas);
      await pool.query('UPDATE tratamientos SET proxima_toma = ? WHERE id = ?',
        [nuevaToma.toISOString().slice(0, 19).replace('T', ' '), t.id]);
    }
    return rows.length;
  } catch (err) {
    console.error('Error recordatorios:', err.message);
    return 0;
  }
}

async function enviarRecordatoriosCitas() {
  try {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const fechaStr = manana.toISOString().slice(0, 10);
    const [rows] = await pool.query(`
      SELECT c.*, p.nombre AS paciente_nombre, p.telefono, p.doctor_id,
             cen.nombre AS centro_nombre, d.nombre AS doctor_nombre
      FROM citas c
      JOIN pacientes p ON c.paciente_id = p.id
      JOIN centros_medicos cen ON c.centro_id = cen.id
      LEFT JOIN doctores d ON c.doctor_id = d.id
      WHERE c.fecha = ? AND c.estado IN ('Pendiente', 'Confirmada')
    `, [fechaStr]);
    for (const c of rows) {
      if (isSilenced(c.telefono)) continue;
      await enviarWhatsApp(c.doctor_id, c.telefono,
        `RECORDATORIO DE CITA MÉDICA\n\nHola ${c.paciente_nombre}, MAÑANA tienes una cita:\n\nCentro: ${c.centro_nombre}\nDoctor: Dr. ${c.doctor_nombre || 'Asignado'}\nFecha: ${new Date(c.fecha + 'T12:00:00').toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}\nHora: ${c.hora?.substring(0, 5)}\nMotivo: ${c.motivo}\n\nLlega 30 MINUTOS ANTES.`);
    }
    return rows.length;
  } catch (err) {
    console.error('Error recordatorios citas:', err.message);
    return 0;
  }
}

// ============================================================
// RUTAS EXPRESS
// ============================================================
app.get('/', (req, res) => {
  const totalDocs = sockets.size;
  const conectados = [...doctoresEstado.values()].filter(v => v === 'conectado').length;
  const pendientes = [...doctoresEstado.values()].filter(v => v === 'qr_pendiente').length;
  const docInfoList = [...doctoresInfo.values()].map(d => ({
    id: d.id, nombre: d.nombre, telefono: d.telefono,
    estado: doctoresEstado.get(d.id) || 'desconectado',
    numero: sockets.get(d.id)?.user?.id?.split(':')[0] || ''
  }));

  let cards = '';
  for (const d of docInfoList) {
    const conectado = d.estado === 'conectado';
    cards += `<div class="bg-white rounded-xl p-5 border text-center">
      <div class="w-12 h-12 ${conectado ? 'bg-green-100' : d.estado === 'qr_pendiente' ? 'bg-yellow-100' : 'bg-red-100'} rounded-full flex items-center justify-center mx-auto mb-2">
        <i class="fas fa-user-md ${conectado ? 'text-green-600' : d.estado === 'qr_pendiente' ? 'text-yellow-600' : 'text-red-600'} text-xl"></i>
      </div>
      <p class="font-semibold text-gray-900">Dr. ${d.nombre}</p>
      <p class="text-xs text-gray-500">${d.telefono || 'Sin teléfono'}</p>
      <span class="inline-block mt-2 px-2 py-0.5 rounded-full text-xs font-bold ${conectado ? 'bg-green-100 text-green-800' : d.estado === 'qr_pendiente' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'}">${conectado ? `Conectado ${d.numero}` : d.estado === 'qr_pendiente' ? 'QR pendiente' : d.estado}</span>
      ${d.estado === 'qr_pendiente' ? `<br><a href="/qr/${d.id}" class="text-xs text-blue-600 hover:underline mt-1 inline-block">Ver QR</a>` : ''}
    </div>`;
  }

  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portal de Especialidades - WhatsApp Bot</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');*{font-family:'Inter',sans-serif;}</style>
</head>
<body class="bg-gray-50 min-h-screen">
<nav class="bg-white shadow-sm border-b px-6 py-4">
  <div class="max-w-5xl mx-auto flex items-center justify-between">
    <div class="flex items-center gap-2"><i class="fas fa-star-of-life text-blue-900 text-xl"></i><span class="text-lg font-bold text-blue-900">Portal de Especialidades</span></div>
    <div class="flex items-center gap-3 text-sm">
      <span class="px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800">${conectados}/${totalDocs} conectados</span>
    </div>
  </div>
</nav>
<div class="max-w-5xl mx-auto px-4 py-12">
  <div class="text-center mb-12">
    <div class="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4"><i class="fas fa-robot text-blue-900 text-3xl"></i></div>
    <h1 class="text-3xl font-bold text-gray-900">WhatsApp Bot</h1>
    <p class="text-gray-500 mt-2">Sistema Multi-Doctor (${totalDocs} doctores)</p>
  </div>
  <div class="grid md:grid-cols-${Math.min(totalDocs, 3)} gap-6 max-w-3xl mx-auto mb-8">
    ${cards || '<p class="text-gray-400 text-center col-span-full">No hay doctores configurados</p>'}
  </div>
  <div class="grid md:grid-cols-3 gap-4 max-w-2xl mx-auto">
    <a href="/panel" class="bg-white rounded-xl p-5 border hover:shadow-md transition text-center">
      <i class="fas fa-chart-pie text-blue-900 text-2xl mb-2"></i>
      <p class="font-semibold text-gray-900">Panel</p>
      <p class="text-xs text-gray-500">Estadísticas del consultorio</p>
    </a>
    <a href="/health" class="bg-white rounded-xl p-5 border hover:shadow-md transition text-center">
      <i class="fas fa-heartbeat text-blue-900 text-2xl mb-2"></i>
      <p class="font-semibold text-gray-900">Health</p>
      <p class="text-xs text-gray-500">Estado del servidor</p>
    </a>
  </div>
</div>
<footer class="border-t py-6 text-center text-sm text-gray-400">Portal de Especialidades &copy; ${new Date().getFullYear()}</footer>
<script>setTimeout(function(){ location.reload(); }, 15000);</script>
</body>
</html>`);
});

app.get('/qr', (req, res) => {
  const pendientes = [...doctoresQR.entries()];
  if (pendientes.length === 0) return res.redirect('/');

  let lista = '<div class="space-y-4">';
  for (const [docId, qr] of pendientes) {
    const doc = doctoresInfo.get(docId);
    lista += `<div class="bg-white rounded-2xl border p-6 text-center">
      <h2 class="text-lg font-bold text-gray-900 mb-1">Dr. ${doc?.nombre || docId}</h2>
      <p class="text-sm text-gray-500 mb-4">${doc?.telefono || ''}</p>
      <a href="/qr/${docId}" class="inline-block bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">Ver QR</a>
    </div>`;
  }
  lista += '</div>';

  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QR - WhatsApp Bot</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');*{font-family:'Inter',sans-serif;}</style>
</head>
<body class="bg-gray-50 min-h-screen p-4">
<div class="max-w-lg mx-auto">
  <div class="bg-white rounded-3xl shadow-xl p-8">
    <div class="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4"><i class="fab fa-whatsapp text-blue-900 text-3xl"></i></div>
    <h1 class="text-2xl font-bold text-gray-900 text-center mb-2">Doctores Pendientes</h1>
    <p class="text-gray-500 text-sm text-center mb-6">Selecciona un doctor para escanear su QR</p>
    ${lista}
    <div class="text-center mt-6">
      <a href="/" class="text-sm text-blue-600 hover:underline">← Volver al inicio</a>
    </div>
  </div>
</div>
</body>
</html>`);
});

app.get('/qr/:doctorId', (req, res) => {
  const docId = parseInt(req.params.doctorId);
  const doc = doctoresInfo.get(docId);
  if (!doc) return res.status(404).send('Doctor no encontrado');

  const estado = doctoresEstado.get(docId);
  if (estado === 'conectado') return res.redirect('/');

  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QR - Dr. ${doc.nombre}</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');*{font-family:'Inter',sans-serif;}</style>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center p-4">
<div class="bg-white rounded-3xl shadow-xl p-8 max-w-md w-full text-center">
  <div class="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4"><i class="fab fa-whatsapp text-blue-900 text-3xl"></i></div>
  <h1 class="text-2xl font-bold text-gray-900 mb-1">Dr. ${doc.nombre}</h1>
  <p class="text-gray-500 text-sm mb-6">Escanea este código con tu WhatsApp</p>
  <div class="bg-gray-50 p-4 rounded-2xl inline-block mb-4">
    <img src="/qr-image/${docId}" alt="QR" class="w-72 h-72" id="qrImg">
  </div>
  <div class="bg-blue-50 rounded-xl p-4 text-left text-sm text-blue-800">
    <p class="font-semibold mb-1">Pasos:</p>
    <p>1. Abre WhatsApp en tu teléfono</p>
    <p>2. Toca los 3 puntos ⋮ → Dispositivos vinculados</p>
    <p>3. Toca "Vincular dispositivo"</p>
    <p>4. Escanea este código</p>
  </div>
  <p class="text-xs text-gray-400 mt-4">La página se actualiza automáticamente</p>
  <a href="/qr" class="inline-block mt-4 text-sm text-blue-600 hover:underline">← Todos los doctores</a>
</div>
<script>
setInterval(function(){
  document.getElementById('qrImg').src = '/qr-image/${docId}?' + new Date().getTime();
  fetch('/health').then(r=>r.json()).then(d=>{
    const doc = d.doctores?.find(x => x.id === ${docId});
    if (doc && doc.estado === 'conectado') location.href = '/';
  });
}, 5000);
</script>
</body>
</html>`);
});

app.get('/qr-image/:doctorId', (req, res) => {
  const docId = parseInt(req.params.doctorId);
  const qr = doctoresQR.get(docId);
  if (!qr) return res.status(200).type('text/html').send('<div style="font-family:sans-serif;text-align:center;padding:40px;color:#666"><h2>Esperando QR...</h2></div>');
  try {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
    https.get(url, (apiRes) => {
      res.setHeader('Content-Type', apiRes.headers['content-type'] || 'image/png');
      apiRes.pipe(res);
    }).on('error', () => res.redirect(url));
  } catch (e) {
    res.status(500).send('Error');
  }
});

app.get('/panel', async (req, res) => {
  try {
    const [pacientes] = await pool.query('SELECT COUNT(*) as total FROM pacientes WHERE activo = 1');
    const [doctores] = await pool.query('SELECT COUNT(*) as total FROM doctores WHERE activo = 1');
    const [centros] = await pool.query('SELECT COUNT(*) as total FROM centros_medicos WHERE activo = 1');
    const [citasHoy] = await pool.query("SELECT COUNT(*) as total FROM citas WHERE fecha = CURDATE()");
    const [citasPend] = await pool.query("SELECT COUNT(*) as total FROM citas WHERE estado = 'Pendiente'");
    const [citasConf] = await pool.query("SELECT COUNT(*) as total FROM citas WHERE estado = 'Confirmada'");
    const [citasHoyLista] = await pool.query(`
      SELECT c.fecha, c.hora, c.motivo, c.estado, c.tipo_consulta,
             p.nombre as paciente, d.nombre as doctor, cen.nombre as centro
      FROM citas c JOIN pacientes p ON c.paciente_id = p.id
      JOIN centros_medicos cen ON c.centro_id = cen.id
      LEFT JOIN doctores d ON c.doctor_id = d.id
      WHERE c.fecha = CURDATE() ORDER BY c.hora ASC LIMIT 15`);
    const [tratamientos] = await pool.query("SELECT COUNT(*) as total FROM tratamientos WHERE activo = 1 AND recordatorio_whatsapp = 'SI'");
    const [ultimasCitas] = await pool.query(`
      SELECT c.fecha, c.hora, p.nombre as paciente, d.nombre as doctor, c.estado, c.doctor_id
      FROM citas c JOIN pacientes p ON c.paciente_id = p.id
      LEFT JOIN doctores d ON c.doctor_id = d.id
      ORDER BY c.fecha DESC, c.hora DESC LIMIT 10`);

    const docStatus = [...doctoresInfo.values()].map(d => ({
      nombre: d.nombre, telefono: d.telefono,
      estado: doctoresEstado.get(d.id) || 'desconectado',
      numero: sockets.get(d.id)?.user?.id?.split(':')[0] || ''
    }));

    const conectados = docStatus.filter(d => d.estado === 'conectado').length;

    let docCards = '';
    for (const d of docStatus) {
      const ok = d.estado === 'conectado';
      docCards += `<div class="flex items-center justify-between p-2 hover:bg-gray-50 rounded-lg text-sm">
        <div><span class="font-medium">Dr. ${d.nombre}</span><br><span class="text-xs text-gray-400">${d.numero || d.telefono || ''}</span></div>
        <span class="text-xs px-2 py-0.5 rounded-full font-bold ${ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${ok ? 'Conectado' : d.estado}</span>
      </div>`;
    }

    res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Panel - Portal de Especialidades</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');*{font-family:'Inter',sans-serif;}</style>
</head>
<body class="bg-gray-50">
<nav class="bg-white shadow-sm border-b px-6 py-4 sticky top-0 z-40">
  <div class="max-w-6xl mx-auto flex items-center justify-between">
    <div class="flex items-center gap-2"><i class="fas fa-star-of-life text-blue-900 text-xl"></i><span class="text-lg font-bold text-blue-900">Panel Médico</span></div>
    <div class="flex items-center gap-3 text-sm">
      <span class="px-3 py-1 rounded-full text-xs font-bold bg-green-100 text-green-800">${conectados}/${doctores[0].total} conectados</span>
      <a href="/" class="text-blue-900 hover:underline"><i class="fas fa-home"></i></a>
    </div>
  </div>
</nav>
<div class="max-w-6xl mx-auto px-4 py-8">
  <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
    <div class="bg-white rounded-2xl p-5 border"><div class="text-3xl font-bold text-blue-900">${pacientes[0].total}</div><p class="text-sm text-gray-500">Pacientes</p></div>
    <div class="bg-white rounded-2xl p-5 border"><div class="text-3xl font-bold text-green-700">${doctores[0].total}</div><p class="text-sm text-gray-500">Médicos</p></div>
    <div class="bg-white rounded-2xl p-5 border"><div class="text-3xl font-bold text-purple-700">${centros[0].total}</div><p class="text-sm text-gray-500">Centros</p></div>
    <div class="bg-white rounded-2xl p-5 border"><div class="text-3xl font-bold text-amber-600">${citasHoy[0].total}</div><p class="text-sm text-gray-500">Citas Hoy</p></div>
    <div class="bg-white rounded-2xl p-5 border"><div class="text-3xl font-bold text-red-600">${citasPend[0].total}</div><p class="text-sm text-gray-500">Pendientes</p></div>
  </div>

  <div class="grid md:grid-cols-2 gap-6 mb-8">
    <div class="bg-white rounded-2xl border p-6">
      <h2 class="text-lg font-bold text-gray-900 mb-4"><i class="fas fa-calendar-day text-blue-900 mr-2"></i>Citas de Hoy</h2>
      ${citasHoyLista.length === 0 ? '<p class="text-gray-400 text-sm">No hay citas para hoy.</p>' : ''}
      <div class="space-y-3">
        ${citasHoyLista.map(c => `
        <div class="flex items-start gap-3 p-2 hover:bg-gray-50 rounded-lg">
          <div class="text-center min-w-[50px]"><div class="text-sm font-bold text-blue-900">${c.hora?.substring(0,5)}</div></div>
          <div class="flex-1 min-w-0">
            <p class="font-semibold text-gray-900 text-sm">${c.paciente}</p>
            <p class="text-xs text-gray-500">${c.doctor || 'Sin asignar'} · ${c.centro}</p>
            <p class="text-xs text-gray-400 truncate">${c.motivo || ''}</p>
          </div>
          <span class="text-xs px-2 py-1 rounded-full font-bold ${c.estado === 'Confirmada' ? 'bg-green-100 text-green-800' : c.estado === 'Pendiente' ? 'bg-yellow-100 text-yellow-800' : c.estado === 'Completada' ? 'bg-blue-100 text-blue-800' : 'bg-red-100 text-red-800'}">${c.estado}</span>
        </div>`).join('')}
      </div>
    </div>

    <div class="bg-white rounded-2xl border p-6">
      <h2 class="text-lg font-bold text-gray-900 mb-4"><i class="fas fa-history text-blue-900 mr-2"></i>Últimas Citas</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-xs text-gray-500 uppercase"><th class="pb-2">Fecha</th><th class="pb-2">Paciente</th><th class="pb-2">Doctor</th><th class="pb-2">Estado</th></tr></thead>
          <tbody class="divide-y divide-gray-100">
            ${ultimasCitas.map(c => `<tr class="hover:bg-gray-50"><td class="py-2">${new Date(c.fecha+'T12:00:00').toLocaleDateString('es-VE')} ${c.hora?.substring(0,5)}</td><td class="py-2 font-medium">${c.paciente}</td><td class="py-2 text-gray-500">${c.doctor || '-'}</td><td class="py-2"><span class="text-xs px-2 py-0.5 rounded-full font-bold ${c.estado === 'Confirmada' ? 'bg-green-100 text-green-800' : c.estado === 'Pendiente' ? 'bg-yellow-100 text-yellow-800' : c.estado === 'Completada' ? 'bg-blue-100 text-blue-800' : 'bg-red-100 text-red-800'}">${c.estado}</span></td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="grid md:grid-cols-2 gap-6">
    <div class="bg-white rounded-2xl border p-6">
      <h2 class="text-lg font-bold text-gray-900 mb-4"><i class="fas fa-user-md text-green-700 mr-2"></i>Estado de Doctores</h2>
      <div class="space-y-2">
        ${docCards || '<p class="text-gray-400 text-sm">No hay doctores registrados.</p>'}
      </div>
    </div>

    <div class="bg-white rounded-2xl border p-6">
      <h2 class="text-lg font-bold text-gray-900 mb-4"><i class="fas fa-bell text-amber-600 mr-2"></i>Pacientes Silenciados</h2>
      ${silenced.size === 0 ? '<p class="text-gray-400 text-sm">No hay pacientes silenciados.</p>' : ''}
      <div class="space-y-2">
        ${[...silenced.entries()].map(([tel, entry]) => {
          const remaining = Math.ceil(Math.max(0, SILENCE_DURATION_MS - (Date.now() - entry.silencedAt.getTime())) / 60000);
          return `<div class="flex items-center justify-between p-2 bg-amber-50 rounded-lg text-sm">
            <div><span class="font-medium">${tel}</span><br><span class="text-xs text-gray-400">${entry.silencedBy} · ${remaining} min restantes</span></div>
            <form action="/release" method="POST" style="display:inline">
              <input type="hidden" name="key" value="${process.env.BOT_API_KEY}">
              <input type="hidden" name="telefono" value="${tel}">
              <button type="submit" class="text-xs bg-blue-900 text-white px-3 py-1 rounded-full hover:bg-blue-800">Reactivar</button>
            </form>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>
</div>
<footer class="border-t py-6 text-center text-sm text-gray-400">Portal de Especialidades &copy; ${new Date().getFullYear()} · <a href="/" class="text-blue-900 hover:underline">Inicio</a></footer>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// API endpoints
app.post('/silence', async (req, res) => {
  const apiKey = req.query.key || req.headers['x-api-key'] || req.body?.key;
  if (apiKey !== process.env.BOT_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  const { telefono, motivo } = req.body || {};
  if (!telefono) return res.status(400).json({ error: 'Missing telefono' });
  silencePatient(telefono, motivo || 'API');
  res.json({ ok: true, telefono, action: 'silenced' });
});

app.post('/release', async (req, res) => {
  const apiKey = req.query.key || req.headers['x-api-key'] || req.body?.key;
  if (apiKey !== process.env.BOT_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  const { telefono } = req.body || {};
  const bodyKey = req.body?.key;
  const bodyTel = req.body?.telefono;
  if (bodyKey === process.env.BOT_API_KEY && bodyTel) {
    releasePatient(bodyTel);
    return res.redirect('/panel');
  }
  if (!telefono) return res.status(400).json({ error: 'Missing telefono' });
  releasePatient(telefono);
  if (req.body?.mensaje) {
    // Find which doctor to use (any connected one)
    const firstDoc = [...sockets.keys()][0];
    if (firstDoc) await enviarWhatsApp(firstDoc, telefono, req.body.mensaje);
  }
  res.json({ ok: true, telefono, action: 'released' });
});

app.get('/silence-status', async (req, res) => {
  const apiKey = req.query.key || req.headers['x-api-key'];
  if (apiKey !== process.env.BOT_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  const status = {};
  for (const [tel, entry] of silenced) {
    const remaining = SILENCE_DURATION_MS - (Date.now() - entry.silencedAt.getTime());
    status[tel] = { silencedAt: entry.silencedAt.toISOString(), silencedBy: entry.silencedBy, remainingMin: Math.ceil(Math.max(0, remaining) / 60000) };
  }
  res.json({ ok: true, count: silenced.size, silenced: status });
});

app.get('/remind', async (req, res) => {
  try {
    const apiKey = req.query.key || req.headers['x-api-key'];
    if (apiKey !== process.env.BOT_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
    const t = await enviarRecordatoriosTratamientos();
    const c = await enviarRecordatoriosCitas();
    res.json({ ok: true, recordatorios_tratamientos: t, recordatorios_citas: c, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/notify', async (req, res) => {
  try {
    const apiKey = req.query.key || req.headers['x-api-key'] || req.body?.key;
    if (apiKey !== process.env.BOT_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
    const { telefono, mensaje } = req.body || {};
    if (telefono && mensaje) {
      const firstDoc = [...sockets.keys()][0];
      if (firstDoc) await enviarWhatsApp(firstDoc, telefono, mensaje);
      res.json({ ok: true, sent: true });
    } else {
      res.json({ ok: false, msg: 'Missing telefono or mensaje' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/test', (req, res) => {
  const msg = req.query.msg || '';
  const tel = req.query.tel || '584000000000';
  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Simulador</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen p-4">
<div class="max-w-lg mx-auto">
  <div class="bg-white rounded-2xl shadow-sm border p-6 mb-4">
    <h1 class="text-xl font-bold text-gray-900 mb-4">Simular Mensaje</h1>
    <form method="get" class="space-y-3">
      <div><label class="block text-sm font-medium text-gray-700 mb-1">Número</label>
        <input type="text" name="tel" value="${tel}" class="w-full px-3 py-2 border rounded-lg text-sm"></div>
      <div><label class="block text-sm font-medium text-gray-700 mb-1">Mensaje</label>
        <input type="text" name="msg" value="${msg.replace(/"/g, '&quot;')}" class="w-full px-3 py-2 border rounded-lg text-sm" autofocus></div>
      <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">Enviar al bot</button>
    </form>
    <hr class="my-4">
    <p class="text-xs text-gray-400">Estado WhatsApp: ${[...doctoresEstado.entries()].map(([id, e]) => `Doc ${id}: ${e}`).join(', ')}</p>
  </div>
  ${msg ? `
  <div class="bg-white rounded-2xl shadow-sm border p-6">
    <h2 class="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Resultado</h2>
    <pre id="result" class="bg-gray-50 p-4 rounded-xl text-sm whitespace-pre-wrap font-mono">Procesando...</pre>
  </div>
  <script>
    fetch('/test-process?tel=${encodeURIComponent(tel)}&msg=${encodeURIComponent(msg)}')
      .then(r => r.json()).then(d => {
        document.getElementById('result').textContent = d.respuesta || '(sin respuesta)';
        if (d.error) document.getElementById('result').textContent = 'ERROR: ' + d.error;
      }).catch(e => document.getElementById('result').textContent = 'Error: ' + e.message);
  </script>` : ''}
</div>
</body>
</html>`);
});

app.get('/test-process', async (req, res) => {
  try {
    const tel = req.query.tel || '584000000000';
    const msg = req.query.msg || '';
    if (!msg) return res.json({ error: 'Mensaje vacío' });
    let respuestaBot = '';
    // Buscar un doctor conectado para simular
    let doctorId = null;
    for (const [id, estado] of doctoresEstado) {
      if (estado === 'conectado') { doctorId = id; break; }
    }
    if (!doctorId) doctorId = [...sockets.keys()][0] || 1;
    const originalSend = enviarWhatsApp;
    enviarWhatsApp = async (docId, num, texto) => {
      if (docId === doctorId) respuestaBot = texto;
      return true;
    };
    await procesarMensajePaciente(doctorId, tel, msg);
    enviarWhatsApp = originalSend;
    res.json({ procesado: true, numero: tel, mensaje: msg, respuesta: respuestaBot || '(sin respuesta)' });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  const docs = [...doctoresInfo.values()].map(d => ({
    id: d.id, nombre: d.nombre, telefono: d.telefono,
    estado: doctoresEstado.get(d.id) || 'desconocido',
    numero: sockets.get(d.id)?.user?.id?.split(':')[0] || null,
    qr_pendiente: doctoresQR.has(d.id)
  }));
  res.json({
    status: 'ok',
    doctores: docs,
    conectados: docs.filter(d => d.estado === 'conectado').length,
    total: docs.length,
    sesiones_activas: sessions.size,
    silenciados: silenced.size,
    uptime: process.uptime(),
  });
});

// ============================================================
// INICIO
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════╗');
  console.log('║   WHATSAPP BOT MULTI-DOCTOR     ║');
  console.log('╚══════════════════════════════════╝');
  console.log(` Puerto: ${PORT}`);
  console.log('');
  console.log(' Iniciando sockets para cada doctor...');
  inicializarTodosDoctores();
});

// Recordatorios cada 30 minutos
setInterval(async () => {
  await enviarRecordatoriosTratamientos();
  await enviarRecordatoriosCitas();
}, 30 * 60 * 1000);
