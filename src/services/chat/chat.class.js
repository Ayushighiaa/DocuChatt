// src/services/chat/chat.class.js
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  SystemMessagePromptTemplate,
} from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { BadRequest, GeneralError } from '@feathersjs/errors';
import { elasticsearchClient, INDEX } from '../../middleware/elasticsearch.js';

const TOP_K       = 5;
const MAX_CONTEXT = 6000;

const SYSTEM_TEMPLATE = `You are a helpful assistant that answers questions strictly \
based on the provided document excerpts.

Rules:
- Only use information from the <context> block below.
- If the answer cannot be found in the context, say exactly: \
"I cannot find the answer in the provided documents."
- Cite the page number (if available) when referencing specific facts.
- Be concise and precise.

<context>
{context}
</context>`;

export class ChatService {
  constructor(app) {
    this.app = app;
    const apiKey = process.env.OPENAI_API_KEY;
    this.embeddings = new OpenAIEmbeddings({ modelName: 'text-embedding-3-small', openAIApiKey: apiKey });
    this.llm = new ChatOpenAI({ modelName: 'gpt-4o', temperature: 0, maxTokens: 1024, openAIApiKey: apiKey });

    const chatPrompt = ChatPromptTemplate.fromMessages([
      SystemMessagePromptTemplate.fromTemplate(SYSTEM_TEMPLATE),
      HumanMessagePromptTemplate.fromTemplate('{question}'),
    ]);

    this.chain = chatPrompt.pipe(this.llm).pipe(new StringOutputParser());
  }

  async create(data) {
    const { question, documentId } = data;

    if (!question || typeof question !== 'string' || question.trim() === '') {
      throw new BadRequest('A non-empty "question" string is required.');
    }

    let queryVector;
    try {
      queryVector = await this.embeddings.embedQuery(question.trim());
    } catch (err) {
      throw new GeneralError(`Failed to embed query: ${err.message}`);
    }

    const chunks = await retrieveChunks(queryVector, documentId);

    if (chunks.length === 0) {
      return {
        question,
        answer:     'I cannot find the answer in the provided documents.',
        sources:    [],
        documentId: documentId || null,
      };
    }

    const { context, sourcesUsed } = buildContext(chunks);

    let answer;
    try {
      answer = await this.chain.invoke({ context, question: question.trim() });
    } catch (err) {
      throw new GeneralError(`LLM generation failed: ${err.message}`);
    }

    return {
      question,
      answer,
      sources: sourcesUsed.map((c) => ({
        text:       c.text,
        page:       c.page,
        chunkIndex: c.chunkIndex,
        documentId: c.documentId,
        score:      c.score,
      })),
      documentId: documentId || null,
    };
  }
}

async function retrieveChunks(queryVector, documentId) {
  const query = {
    index: INDEX,
    knn: {
      field:          'embedding',
      query_vector:   queryVector,
      k:              TOP_K,
      num_candidates: TOP_K * 10,
      ...(documentId && { filter: { term: { documentId } } }),
    },
    _source: ['text', 'page', 'chunkIndex', 'documentId', 'originalName'],
    size: TOP_K,
  };

  let response;
  try {
    response = await elasticsearchClient.search(query);
  } catch (err) {
    throw new GeneralError(`Elasticsearch kNN search failed: ${err.message}`);
  }

  return response.hits.hits.map((hit) => ({ ...hit._source, score: hit._score }));
}

function buildContext(chunks) {
  const sourcesUsed = [];
  let context = '';

  for (const chunk of chunks) {
    const header  = chunk.page != null ? `[Page ${chunk.page}]\n` : '';
    const snippet = `${header}${chunk.text}\n\n---\n\n`;
    if (context.length + snippet.length > MAX_CONTEXT) break;
    context += snippet;
    sourcesUsed.push(chunk);
  }

  return { context: context.trim(), sourcesUsed };
}