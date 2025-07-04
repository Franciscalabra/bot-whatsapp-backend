// ================================================================= //
//               SERVIDOR COMPLETO PARA BOT WHATSAPP                 //
//               VERSIÓN CON PANEL INTERACTIVO v2                    //
// ================================================================= //

// --- DEPENDENCIAS ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const OpenAI = require('openai');
const sqlite3 = require('sqlite3').verbose();

// --- INICIALIZACIÓN DE SERVICIOS ---
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Conexión a la Base de Datos SQLite
const db = new sqlite3.Database('./bot.db', (err) => {
  if (err) {
    console.error("Error al conectar con la base de datos:", err.message);
  } else {
    console.log('Conectado a la base de datos bot.db.');
  }
});


// --- CONFIGURACIÓN DE MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));


// --- "MEMORIA" VOLÁTIL DEL BOT Y CONSTANTES ---
const chatStates = {};
const PAUSA_HUMANO_MINUTOS = 30;

// Función para asegurar que un chat tenga un estado inicial
function ensureChatState(chatId) {
  if (!chatStates[chatId]) {
    chatStates[chatId] = { iaActiva: true, ultimoMensajeHumano: null };
  }
}


// ================================================================= //
//                      API PARA EL FRONTEND                         //
// ================================================================= //

// Ruta de verificación del servidor
app.get('/', (req, res) => {
  res.send('El servidor del bot con IA, comandos y API está funcionando.');
});

// Obtiene la lista de chats únicos desde la base de datos
app.get('/api/chats', (req, res) => {
  db.all("SELECT DISTINCT chatId FROM messages ORDER BY timestamp DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Obtiene todos los mensajes de un chat específico
app.get('/api/chats/:chatId/messages', (req, res) => {
  const { chatId } = req.params;
  db.all("SELECT * FROM messages WHERE chatId = ? ORDER BY timestamp ASC", [chatId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Obtiene el estado de la IA para un chat específico
app.get('/api/chats/:chatId/estado', (req, res) => {
  const { chatId } = req.params;
  ensureChatState(chatId); // Asegura que el estado exista antes de enviarlo
  res.json(chatStates[chatId]);
});

// Permite al humano enviar un mensaje desde el frontend
app.post('/api/chats/:chatId/send', async (req, res) => {
  const { chatId } = req.params;
  const { body } = req.body;
  
  try {
    db.run("INSERT INTO messages (chatId, sender, body) VALUES (?, ?, ?)", [chatId, 'human', body]);
    await twilioClient.messages.create({ body, from: process.env.TWILIO_SANDBOX_PHONE, to: chatId });
    res.json({ message: 'Mensaje enviado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al enviar el mensaje' });
  }
});

// Recibe comandos desde los botones del frontend
app.post('/api/chats/:chatId/comando', (req, res) => {
  const { chatId } = req.params;
  const { comando } = req.body;

  ensureChatState(chatId);

  if (comando === 'toggle-ia') {
    chatStates[chatId].iaActiva = !chatStates[chatId].iaActiva;
    if (chatStates[chatId].iaActiva) {
      chatStates[chatId].ultimoMensajeHumano = null;
    }
  }

  res.json({ message: 'Comando ejecutado', newState: chatStates[chatId] });
});


// ================================================================= //
//                    WEBHOOK PRINCIPAL DE TWILIO                    //
// ================================================================= //

app.post('/webhook', async (req, res) => {
  const mensajeRecibido = req.body.Body.trim();
  const numeroCliente = req.body.From;

  console.log(`\n--- Mensaje de ${numeroCliente}: "${mensajeRecibido}" ---`);

  db.run("INSERT INTO messages (chatId, sender, body) VALUES (?, ?, ?)", [numeroCliente, 'user', mensajeRecibido]);
  ensureChatState(numeroCliente);

  // --- MANEJO DE COMANDOS DE WHATSAPP ---
  if (mensajeRecibido.toLowerCase().startsWith('/')) {
    if (mensajeRecibido.toLowerCase() === '/ia off') {
        chatStates[numeroCliente].iaActiva = false;
        await twilioClient.messages.create({ body: '🤖 IA desactivada para este chat.', from: process.env.TWILIO_SANDBOX_PHONE, to: numeroCliente });
        return enviarRespuestaVacia(res);
    }
    if (mensajeRecibido.toLowerCase() === '/ia on') {
        chatStates[numeroCliente].iaActiva = true;
        chatStates[numeroCliente].ultimoMensajeHumano = null;
        await twilioClient.messages.create({ body: '🤖 IA reactivada para este chat.', from: process.env.TWILIO_SANDBOX_PHONE, to: numeroCliente });
        return enviarRespuestaVacia(res);
    }
    if (mensajeRecibido.toLowerCase() === '/ia estado') {
        const estadoIA = chatStates[numeroCliente].iaActiva ? '✅ Activa' : '❌ Desactivada';
        let estadoPausa = '';
        if (chatStates[numeroCliente].ultimoMensajeHumano) {
            const tiempoRestante = (chatStates[numeroCliente].ultimoMensajeHumano + PAUSA_HUMANO_MINUTOS * 60 * 1000 - Date.now()) / (60 * 1000);
            if (tiempoRestante > 0) {
            estadoPausa = `\n⏸️ En pausa por intervención humana. Se reactivará en ${Math.ceil(tiempoRestante)} minutos.`;
            }
        }
        await twilioClient.messages.create({ body: `Estado actual de la IA: ${estadoIA}${estadoPausa}`, from: process.env.TWILIO_SANDBOX_PHONE, to: numeroCliente });
        return enviarRespuestaVacia(res);
    }
    if (mensajeRecibido.toLowerCase() === '/human') {
        chatStates[numeroCliente].ultimoMensajeHumano = Date.now();
        await twilioClient.messages.create({ body: `⏸️ Tomando el control. La IA se pausará por ${PAUSA_HUMANO_MINUTOS} minutos.`, from: process.env.TWILIO_SANDBOX_PHONE, to: numeroCliente });
        return enviarRespuestaVacia(res);
    }
  }

  // --- LÓGICA DE RESPUESTA DE LA IA ---
  const ahora = Date.now();
  const tiempoDesdeIntervencion = chatStates[numeroCliente].ultimoMensajeHumano ? (ahora - chatStates[numeroCliente].ultimoMensajeHumano) : Infinity;

  const iaDebeResponder =
    chatStates[numeroCliente].iaActiva &&
    tiempoDesdeIntervencion > PAUSA_HUMANO_MINUTOS * 60 * 1000;

  if (iaDebeResponder) {
    console.log('La IA está activa. Enviando a OpenAI...');
    try {
      const chatCompletion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Eres "Asistente Virtual" de "El Rincón del Código", una cafetería para programadores. Nuestro horario es de 9 AM a 7 PM, de Lunes a Sábado. La especialidad de la casa es el "Café Binario". Actualmente tenemos una promoción 2x1 en "Muffins Algorítmicos" todos los viernes. Responde amablemente y de forma concisa basándote en esta información.'
          },
          { role: 'user', content: mensajeRecibido }
        ],
      });

      const respuestaIA = chatCompletion.choices[0].message.content;
      db.run("INSERT INTO messages (chatId, sender, body) VALUES (?, ?, ?)", [numeroCliente, 'bot', respuestaIA]);
      await twilioClient.messages.create({ body: respuestaIA, from: process.env.TWILIO_SANDBOX_PHONE, to: numeroCliente });

    } catch (error) {
      console.error('Ha ocurrido un error con OpenAI o Twilio:', error);
    }
  } else {
    console.log(`La IA no responde. Razón: [Activa: ${chatStates[numeroCliente].iaActiva}] [Pausa Humana Activa: ${tiempoDesdeIntervencion <= PAUSA_HUMANO_MINUTOS * 60 * 1000}]`);
  }

  enviarRespuestaVacia(res);
});


// --- FUNCIONES AUXILIARES ---
function enviarRespuestaVacia(res) {
  const twiml = new twilio.twiml.MessagingResponse();
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
}


// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});