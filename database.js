// database.js

const sqlite3 = require('sqlite3').verbose();

// Esto crea el archivo bot.db si no existe
const db = new sqlite3.Database('./bot.db', (err) => {
  if (err) {
    console.error(err.message);
  }
  console.log('Conectado a la base de datos bot.db.');
});

// Creamos la tabla para guardar los mensajes
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chatId TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
  if (err) {
    console.error("Error al crear la tabla:", err.message);
  } else {
    console.log("Tabla 'messages' creada o ya existente.");
  }
});

db.close((err) => {
  if (err) {
    console.error(err.message);
  }
  console.log('Conexión con la base de datos cerrada.');
});