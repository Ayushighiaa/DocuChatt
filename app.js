// src/app.js
import { config } from 'dotenv';
config();

import { feathers } from '@feathersjs/feathers';
import { koa, bodyParser, errorHandler } from '@feathersjs/koa';
import Router from '@koa/router';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import { resolve } from 'path';

import { DocumentsService } from './services/documents/documents.class.js';
import { ChatService } from './services/chat/chat.class.js';
import { processPdfHook } from './hooks/process-pdf.js';
import { ensureIndex } from './middleware/elasticsearch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are accepted'), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

function koaMulter(ctx) {
  return new Promise((resolve, reject) => {
    upload.single('file')(ctx.req, ctx.res, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

const app = koa(feathers());

app.use(errorHandler());
app.use(bodyParser());

app.use('documents', new DocumentsService(app));
app.use('chat', new ChatService(app));

app.service('documents').hooks({
  after: { create: [processPdfHook] },
});

const router = new Router();

// Serve frontend
router.get('/', async (ctx) => {
  ctx.type = 'html';
  ctx.body = createReadStream(resolve(process.cwd(), 'index.html'));
});

// Upload PDF
router.post('/documents', async (ctx) => {
  await koaMulter(ctx);
  if (!ctx.req.file) {
    ctx.status = 400;
    ctx.body = { error: 'No PDF file provided. Use field name "file".' };
    return;
  }
  const result = await app.service('documents').create({
    filePath:     ctx.req.file.path,
    originalName: ctx.req.file.originalname,
    size:         ctx.req.file.size,
  });
  ctx.status = 201;
  ctx.body = result;
});

// Poll status
router.get('/documents/:id', async (ctx) => {
  const doc = await app.service('documents').get(ctx.params.id);
  ctx.body = doc;
});

// List documents
router.get('/documents', async (ctx) => {
  const result = await app.service('documents').find();
  ctx.body = result;
});

// Chat
router.post('/chat', async (ctx) => {
  const result = await app.service('chat').create(ctx.request.body);
  ctx.body = result;
});

app.use(router.routes());
app.use(router.allowedMethods());

const PORT = process.env.PORT || 3030;

app.listen(PORT).then(async () => {
  await ensureIndex();
  console.log(`
╔══════════════════════════════════════════════════╗
║         Chat with Your Docs  —  RAG API          ║
╠══════════════════════════════════════════════════╣
║  Server  →  http://localhost:${PORT}               ║
║  UI      →  http://localhost:${PORT}               ║
║                                                  ║
║  POST   /documents          Upload a PDF         ║
║  GET    /documents/:id      Poll status          ║
║  POST   /chat               Ask a question       ║
╚══════════════════════════════════════════════════╝
  `);
});

export { app };