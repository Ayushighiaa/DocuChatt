// src/hooks/process-pdf.js
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { OpenAIEmbeddings } from '@langchain/openai';
import { elasticsearchClient, INDEX } from '../middleware/elasticsearch.js';

const CHUNK_SIZE    = 1000;
const CHUNK_OVERLAP = 200;
const BATCH_SIZE    = 100;

export const processPdfHook = (context) => {
  const { result, app } = context;
  runPipeline(result, app).catch((err) => {
    console.error(`[Pipeline] Unhandled error for doc ${result.id}:`, err);
  });
  return context;
};

async function runPipeline(doc, app) {
  console.log(`[Pipeline] Starting ingestion for doc ${doc.id} (${doc.originalName})`);

  try {
    const loader = new PDFLoader(doc.filePath, { splitPages: true });
    const pages  = await loader.load();
    console.log(`[Pipeline] ${doc.id} → parsed ${pages.length} page(s)`);

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize:    CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
      separators:   ['\n\n', '\n', '. ', ' ', ''],
    });
    const chunks = await splitter.splitDocuments(pages);
    console.log(`[Pipeline] ${doc.id} → produced ${chunks.length} chunk(s)`);

    if (chunks.length === 0) {
      await app.service('documents').patch(doc.id, { status: 'error', error: 'No extractable text found.' });
      return;
    }

    const embeddings = new OpenAIEmbeddings({
      modelName:    'text-embedding-3-small',
      batchSize:    512,
      openAIApiKey: process.env.OPENAI_API_KEY,
    });

    let indexed = 0;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch   = chunks.slice(i, i + BATCH_SIZE);
      const texts   = batch.map((c) => c.pageContent);
      const vectors = await embeddings.embedDocuments(texts);

      const operations = batch.flatMap((chunk, j) => [
        { index: { _index: INDEX } },
        {
          text:         chunk.pageContent,
          embedding:    vectors[j],
          documentId:   doc.id,
          originalName: doc.originalName,
          page:         chunk.metadata?.loc?.pageNumber ?? chunk.metadata?.page ?? null,
          chunkIndex:   i + j,
          createdAt:    new Date().toISOString(),
        },
      ]);

      const { errors, items } = await elasticsearchClient.bulk({ operations, refresh: false });
      if (errors) {
        const failed = items.filter((item) => item.index?.error);
        console.error(`[Pipeline] bulk errors:`, failed[0]?.index?.error);
      }

      indexed += batch.length;
      console.log(`[Pipeline] ${doc.id} → indexed ${indexed}/${chunks.length} chunks`);
    }

    await elasticsearchClient.indices.refresh({ index: INDEX });
    await app.service('documents').patch(doc.id, { status: 'ready', chunkCount: chunks.length });
    console.log(`[Pipeline] ✓ doc ${doc.id} ready — ${chunks.length} chunks indexed`);

  } catch (err) {
    console.error(`[Pipeline] ✗ doc ${doc.id} failed:`, err.message);
    await app.service('documents').patch(doc.id, { status: 'error', error: err.message });
  }
}