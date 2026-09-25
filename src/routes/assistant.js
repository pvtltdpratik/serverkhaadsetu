const express = require('express');
const { asyncHandler, str, body, deviceId } = require('../utils/http');

// The farming assistant (Gemini). The API key stays on the server; the app only sends the
// question and the recent conversation.
module.exports = (db, assistant) => {
  const router = express.Router();

  router.get('/status', asyncHandler(async (req, res) => res.json({ enabled: assistant.enabled })));

  router.post('/chat', asyncHandler(async (req, res) => {
    const input = body(req);
    const message = str(input.message, 'message', { max: 2000 });
    const text = await assistant.reply(db, { owner: deviceId(req), message, history: input.history });
    res.json({ reply: text });
  }));

  return router;
};
