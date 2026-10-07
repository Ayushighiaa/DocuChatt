# Chat with Your Docs — RAG System

A production-ready "Chat with Your PDFs" app built with **Feathers.js**, **LangChain**, **OpenAI**, and **Elasticsearch**.

---

## Architecture

```
┌─────────────┐     POST /documents      ┌──────────────────────────────────────────┐
│   Client    │ ──── PDF upload ────────► │  Upload Service (Feathers + Koa/Multer)  │
└─────────────┘                           │  • Stores file to disk                   │
                                          │  • Returns doc record (status=processing)│
                                          └──────────────┬───────────────────────────┘
                                                         │ after:create hook (async)
                                                         ▼
                                          ┌──────────────────────────────────────────┐
                                          │       Chunking & Embedding Pipeline       │
                                          │  1. PDFLoader      → raw text per page   │
                                          │  2. RecursiveTextSplitter → chunks        │
                                          │  3. OpenAI text-embedding-3-small         │
                                          │  4. Bulk index → Elasticsearch            │
                                          └──────────────────────────────────────────┘

┌─────────────┐     POST /chat           ┌──────────────────────────────────────────┐
│   Client    │ ── { question, docId } ► │      Query & Generation Service          │
└─────────────┘                          │  1. Embed question (text-embedding-3-sm) │
       ▲                                 │  2. kNN search → top-5 chunks (ES)       │
       │  { answer, sources }            │  3. Stuff context into prompt            │
       └─────────────────────────────── │  4. GPT-4o → grounded answer             │
                                         └──────────────────────────────────────────┘
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 18** | Uses ES modules |
| **Elasticsearch 8.x** | Local Docker or Elastic Cloud |
| **OpenAI API key** | Needs access to `text-embedding-3-small` + `gpt-4o` |

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Then edit .env and fill in OPENAI_API_KEY and ELASTICSEARCH_URL
```

### 3. Start Elasticsearch (Docker)
```bash
docker run -d --name elasticsearch \
  -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  docker.elastic.co/elasticsearch/elasticsearch:8.14.0
```

### 4. Start the server
```bash
npm run dev
```

The server starts at **http://localhost:3030** and automatically creates the Elasticsearch index on first run.

---

## API Reference

### Upload a PDF
```bash
POST /documents
Content-Type: multipart/form-data

curl -X POST http://localhost:3030/documents \
  -F "file=@/path/to/your.pdf"
```

**Response:**
```json
{
  "id": "a1b2c3d4-...",
  "originalName": "your.pdf",
  "status": "processing",
  "chunkCount": 0,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

---

### Poll processing status
```bash
GET /documents/:id

curl http://localhost:3030/documents/a1b2c3d4-...
```

**Response (when ready):**
```json
{
  "id": "a1b2c3d4-...",
  "status": "ready",
  "chunkCount": 47
}
```

---

### Ask a question
```bash
POST /chat
Content-Type: application/json

curl -X POST http://localhost:3030/chat \
  -H "Content-Type: application/json" \
  -d '{"question": "What are the main findings?", "documentId": "a1b2c3d4-..."}'
```

`documentId` is **optional** — omit it to search across all uploaded documents.

**Response:**
```json
{
  "question": "What are the main findings?",
  "answer": "According to page 3, the main findings are...",
  "sources": [
    {
      "text": "The study found that...",
      "page": 3,
      "score": 0.91,
      "documentId": "a1b2c3d4-..."
    }
  ]
}
```

---

## Design Decisions

### Why Elasticsearch for vectors?
ES 8.x ships with native `dense_vector` + `knn` support — no separate vector DB needed. This reduces operational complexity while still delivering fast approximate nearest-neighbour search via HNSW. A team already running ES for logs/search gets vector search for free.

### Why `text-embedding-3-small`?
- Best price/performance ratio in the OpenAI embedding lineup
- 1536-dim output — high enough for good semantic precision
- Can be swapped to `text-embedding-3-large` (3072-dim) by changing one env var and re-indexing

### Why `RecursiveCharacterTextSplitter`?
It tries to break on paragraphs, then sentences, then words. This preserves semantic units better than a naive fixed-width slice, which is important because the LLM sees only a few chunks — bad chunk boundaries degrade answer quality.

### Why fire-and-forget in the hook?
Large PDFs can take tens of seconds to process. Returning immediately (status=`processing`) and letting the client poll `GET /documents/:id` is friendlier than holding the HTTP connection open. In production, replace the in-process async with a proper job queue (BullMQ, etc.).

---

## Production Checklist

- [ ] Replace in-memory document store with a real database (PostgreSQL via `@feathersjs/knex`, MongoDB, etc.)
- [ ] Add authentication (`@feathersjs/authentication` + JWT)
- [ ] Replace fire-and-forget with a job queue (BullMQ + Redis) for reliability and retries
- [ ] Add rate limiting on `/chat`
- [ ] Store uploaded PDFs in object storage (S3 / GCS) instead of local disk
- [ ] Add conversation history to `/chat` for multi-turn support
- [ ] Tune `CHUNK_SIZE`, `CHUNK_OVERLAP`, and `TOP_K` for your document types
