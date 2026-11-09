// Must be required FIRST by every DB test: points all pools at the isolated test database with offline providers.
require('dotenv').config();
const { testUrls } = require('./urls');

const { testUrl, chatUrl } = testUrls();
if (!process.env.MAIN_DATABASE_URL) process.env.MAIN_DATABASE_URL = process.env.DATABASE_URL || '';
process.env.DATABASE_URL = testUrl;
process.env.CHAT_DATABASE_URL = chatUrl;
process.env.LLM_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.CHAT_ALLOW_COMMENT_LLM = 'true';
process.env.CHAT_MEANING_VERIFY = 'true';
process.env.CHAT_MEANING_FLOOR = '0.05';      // mock (lexical) vectors have a different similarity scale
process.env.CHAT_MEANING_TAG_FLOOR = '0.05';
process.env.CHAT_STATEMENT_TIMEOUT_MS = '3000';
process.env.EMBEDDINGS_WORKER = 'false';

module.exports = { testUrl, chatUrl };
