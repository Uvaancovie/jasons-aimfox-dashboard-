import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createAimfoxApp } from './server/createAimfoxApp.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  let wssRef: WebSocketServer | null = null;

  const app = createAimfoxApp({
    wsSupported: true,
    getWsClientCount: () => wssRef?.clients.size ?? 0,
    onBroadcast: (type, payload) => {
      if (!wssRef) return;
      const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
      for (const client of wssRef.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    },
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wssRef = wss;

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'ws:connected',
        payload: { connectedClients: wss.clients.size },
        timestamp: new Date().toISOString(),
      }),
    );
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Aurora Pulse Aimfox server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
