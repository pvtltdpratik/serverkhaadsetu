const express = require('express');
const { asyncHandler } = require('../utils/http');
const buildController = require('../controllers/communityController');

module.exports = (db) => {
  const router = express.Router();
  const c = buildController(db);
  const ah = asyncHandler;

  router.post('/posts', ah(c.createPost));
  router.get('/posts', ah(c.listPosts));
  router.get('/mine', ah(c.mine));
  router.get('/posts/:id', ah(c.getPost));
  router.post('/posts/:id/comments', ah(c.addComment));
  router.post('/posts/:id/like', ah(c.toggleLike));
  router.patch('/comments/:id', ah(c.editComment));
  router.patch('/comments/:id/verify', ah(c.verifyComment));

  return router;
};
