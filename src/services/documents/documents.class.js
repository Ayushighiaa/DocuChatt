// src/services/documents/documents.class.js
import { v4 as uuidv4 } from 'uuid';
import { GeneralError, NotFound } from '@feathersjs/errors';

export class DocumentsService {
  constructor(app) {
    this.app = app;
    this._store = new Map();
  }

  async create(data) {
    const { filePath, originalName, size } = data || {};

    if (!filePath) {
      throw new GeneralError('filePath is missing — was the PDF uploaded correctly?');
    }

    const doc = {
      id:           uuidv4(),
      originalName: originalName || 'unknown.pdf',
      filePath,
      size:         size || 0,
      status:       'processing',
      chunkCount:   0,
      createdAt:    new Date().toISOString(),
      updatedAt:    new Date().toISOString(),
    };

    this._store.set(doc.id, doc);
    console.log(`[Documents] Created document ${doc.id} (${doc.originalName})`);
    return doc;
  }

  async get(id) {
    const doc = this._store.get(id);
    if (!doc) throw new NotFound(`Document "${id}" not found.`);
    return doc;
  }

  async find() {
    return {
      total: this._store.size,
      data:  Array.from(this._store.values()).sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      ),
    };
  }

  async patch(id, changes) {
    const doc = this._store.get(id);
    if (!doc) throw new NotFound(`Document "${id}" not found for patch.`);
    const updated = { ...doc, ...changes, updatedAt: new Date().toISOString() };
    this._store.set(id, updated);
    return updated;
  }
}