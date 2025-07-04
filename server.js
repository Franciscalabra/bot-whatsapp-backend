// server.js - Versión para Render con PostgreSQL

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const OpenAI = require('openai');
const { Pool } = require('pg'); // <-- CAMBIO: Usamos pg en vez de sqlite3

// --- Conexión a la Base de Datos PostgreSQL ---
// Render proveerá la URL a través de una variable de entorno
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Script para crear la tabla si no existe
const createTable = async () => {
  const queryText = `
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chatId TEXT NOT NULL,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );`;
  await pool.query(queryText);
  console.log("Tabla 'messages' verificada/creada en PostgreSQL.");
};
createTable();

// ... (el resto del código es muy similar, solo cambian las consultas a la DB)

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const chatStates = {};
const PAUSA_HUMANO_MINUTOS = 30;

function ensureChatState(chatId) {
  if (!chatStates[chatId]) {
    chatStates[chatId] = { iaActiva: true, ultimoMensajeHumano: null };
  }
}

// --- API PARA EL FRONTEND ---
app.get('/', (req, res) => res.send('Servidor del bot funcionando.'));

app.get('/api/chats', async (req, res) => {
  try {
    const result = await pool.query("SELECT DISTINCT chatId FROM messages ORDER BY chatId DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:chatId/messages', async (req, res) => {
  try {
    const { chatId } = req.params;
    const result = await pool.query("SELECT * FROM messages WHERE chatId = $1 ORDER BY timestamp ASC", [chatId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:chatId/estado', (req, res) => {
    const { chatId } = req.params;
    ensureChatState(chatId);
    res.json(chatStates[chatId]);
});

app.post('/api/chats/:chatId/send', async (req, res) => {
    const { chatId } = req.params;
    const { body } = req.body;
    try {
        await pool.query("INSERT INTO messages (chatId, sender, body) VALUES ($1, $2, $3)", [chatId, 'human', body]);
        await twilioClient.messages.create({ body, from: process.env.TWILIO_SANDBOX_PHONE, to: chatId });
        res.json({ message: 'Mensaje enviado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al enviar el mensaje' });
    }
});

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

// --- WEBHOOK DE TWILIO ---
app.post('/webhook', async (req, res) => {
    const mensajeRecibido = req.body.Body.trim();
    const numeroCliente = req.body.From;

    console.log(`\n--- Mensaje de ${numeroCliente}: "${mensajeRecibido}" ---`);

    await pool.query("INSERT INTO messages (chatId, sender, body) VALUES ($1, $2, $3)", [numeroCliente, 'user', mensajeRecibido]);
    ensureChatState(numeroCliente);

    // ... (Toda la lógica de comandos y de la IA no cambia, solo las llamadas a la DB)
    // La pegaremos aquí para asegurar que esté completa
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
    }

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
                messages: [ { role: 'system', content: 'Eres "Asistente Virtual"...'}, { role: 'user', content: mensajeRecibido }]
            });
            const respuestaIA = chatCompletion.choices[0].message.content;
            await pool.query("INSERT INTO messages (chatId, sender, body) VALUES ($1, $2, $3)", [numeroCliente, 'bot', respuestaIA]);
            await twilioClient.messages.create({ body: respuestaIA, from: process.env.TWILIO_SANDBOX_PHONE, to: numeroCliente });
        } catch (error) {
            console.error('Ha ocurrido un error con OpenAI o Twilio:', error);
        }
    } else {
        console.log(`La IA no responde.`);
    }
    enviarRespuestaVacia(res);
});

function enviarRespuestaVacia(res) {
    const twiml = new twilio.twiml.MessagingResponse();
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});