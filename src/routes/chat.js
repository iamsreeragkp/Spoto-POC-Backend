const express = require('express');
const { ask, ChatError } = require('../chat/service');
const { getConversation } = require('../chat/memory');
const { wrap, HttpError } = require('../utils/crud');

const router = express.Router();
const toHttp = (e) => (e instanceof ChatError ? new HttpError(e.status, e.message) : e);

// POST /api/chat   { "message": "...", "conversation_id": "optional" }
router.post('/', wrap(async (req, res) => {
  const { message, conversation_id: conversationId } = req.body || {};
  try {
    res.json(await ask(message, { conversationId }));
  } catch (e) { throw toHttp(e); }
}));

// GET /api/chat/stream?message=...&conversation_id=...   (Server-Sent Events)
// events: status {text} | token {text} | result {...same as POST...} | error {status,error}
router.get('/stream', async (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const result = await ask(req.query.message, {
      conversationId: req.query.conversation_id,
      onStatus: (text) => send('status', { text }),
      onToken: (text) => send('token', { text }),
    });
    send('result', result);
  } catch (e) {
    const status = e instanceof ChatError ? e.status : 500;
    if (status === 500) console.error(e);
    send('error', { status, error: status === 500 ? 'Internal server error' : e.message });
  }
  res.end();
});

// GET /api/chat/conversations/:id   -> stored turns of a conversation
router.get('/conversations/:id', wrap(async (req, res) => {
  const conv = await getConversation(req.params.id);
  if (!conv) throw new HttpError(404, 'Conversation not found');
  res.json(conv);
}));

module.exports = router;
