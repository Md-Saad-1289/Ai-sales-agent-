import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request } from 'express';
import { closeDatabase, initDatabase } from './server/db/mongo.ts';
import { createApiRouter, type RawBodyRequest } from './server/routes/api.ts';
import { ensureAuthSecret } from './server/services/authService.ts';
import { stopRealtimeHeartbeat } from './server/services/realtimeService.ts';
import { getSettings } from './server/services/settingsService.ts';
import { startWebhookWorker, stopWebhookWorker } from './server/services/webhookService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function bootstrap() {
  await initDatabase();
  await ensureAuthSecret();
  await getSettings();

  const app = express();
  app.set('trust proxy', 1);

  // Capture exact raw request bytes for Meta X-Hub-Signature-256 HMAC verification
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: Request, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );

  app.use('/api', createApiRouter());

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  startWebhookWorker();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] PageFlow AI running at http://0.0.0.0:${PORT} (${isProduction ? 'production' : 'development'})`);
  });

  const shutdown = async () => {
    stopWebhookWorker();
    stopRealtimeHeartbeat();
    server.close();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

bootstrap().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
