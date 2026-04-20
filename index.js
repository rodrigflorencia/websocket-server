const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const { google } = require('googleapis');

const app = express();

// ── Logging ──
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── CORS para que Unity WebGL pueda hacer fetch ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ── Auth con Service Account ──
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8')),
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});

// ── Endpoint HEAD (Unity verifica antes de descargar) ──
app.head('/drive/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const response = await fetch(driveUrl, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${token.token}` }
    });

    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.status(response.ok ? 200 : response.status).end();

  } catch (e) {
    console.error('Error en HEAD /audio:', e);
    res.status(500).end();
  }
});

// ── Endpoint GET audio ──
app.get('/drive/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    console.log('Request de audio para:', fileId);

    const client = await auth.getClient();
    console.log('Auth OK');
    const token = await client.getAccessToken();
    console.log('Token OK:', token.token ? 'tiene token' : 'token null');

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const response = await fetch(driveUrl, {
      headers: { Authorization: `Bearer ${token.token}` }
    });

    if (!response.ok) {
      console.error('Drive respondió:', response.status, response.statusText);
      return res.status(response.status).send('Error al obtener audio de Drive');
    }

    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const { Readable } = require('stream');
    Readable.fromWeb(response.body).pipe(res);

  } catch (e) {
    console.error('Error en /audio:', e);
    res.status(500).send('Error interno');
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

let lastMessage = null;

// ── Manejar upgrade a WebSocket ──
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  console.log('Nuevo cliente conectado');
  const serverAddress = server.address();
  const serverIP = serverAddress.address === '::' ? '127.0.0.1' : serverAddress.address;

  ws.send(JSON.stringify({
    type: 'connection',
    status: 'connected',
    message: 'Bienvenido al servidor WebSocket',
    serverIP: serverIP,
    serverPort: serverAddress.port,
  }));

  ws.on('message', async (message) => {
    console.log('Mensaje recibido:', message.toString());
    try {
      const data = JSON.parse(message);
      console.log('Datos JSON recibidos:', data);

      if (data.action === 'load' && data.fileName) {
        console.log('Enviado:', lastMessage.toString());
        return ws.send(JSON.stringify(lastMessage));
      }

      if (typeof data === 'object' && data !== null) {
        lastMessage = { ...data, timestamp: new Date().toISOString() };
        console.log('Mensaje guardado:', lastMessage);
      }

      // Si es scene_data, desenvuelve data para que Unity pueda parsearlo directamente
      const broadcastMessage = JSON.stringify(
        (data.type === 'scene_data' && data.data)
          ? { ...data.data, timestamp: new Date().toISOString() }
          : { ...data, type: data.type || 'message', timestamp: new Date().toISOString() }
      );

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(broadcastMessage);
        }
      });

    } catch (e) {
      console.error('Error al procesar el mensaje:', e);
      ws.send(JSON.stringify({
        status: 'error',
        message: 'Error al procesar el mensaje',
        error: e.message
      }));
    }
  });

  ws.on('close', () => console.log('Cliente desconectado'));
});

// ── Un solo listen ──
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Servidor HTTP + WebSocket iniciado en puerto ${PORT}`);

  console.log('Rutas registradas:');
  app._router.stack
    .filter(r => r.route)
    .forEach(r => console.log(Object.keys(r.route.methods)[0].toUpperCase(), r.route.path));
});
