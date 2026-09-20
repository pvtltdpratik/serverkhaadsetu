const express = require('express');
const crypto = require('crypto');
const { HttpError, str, oneOf, body, deviceId, sendList } = require('../utils/http');

const PROBLEM_TYPES = ['pest', 'disease', 'nutrientDeficiency', 'weather', 'market', 'general'];

module.exports = (store) => {
  const router = express.Router();

  const repliesOf = (postId) => store.data.replies.filter((r) => r.postId === postId);

  const serializePost = (post) => {
    const { likedBy, ...rest } = post;
    return { ...rest, replyCount: repliesOf(post.id).length, likeCount: post.likeCount };
  };

  const findPost = (id) => {
    const post = store.data.posts.find((p) => p.id === id);
    if (!post) throw new HttpError(404, 'Post not found');
    return post;
  };

  router.get('/posts', (req, res) => {
    let posts = store.data.posts;
    const eq = (a, b) => a.toLowerCase() === String(b).toLowerCase();
    if (req.query.crop) posts = posts.filter((p) => eq(p.crop, req.query.crop));
    if (req.query.district) posts = posts.filter((p) => eq(p.district, req.query.district));
    if (req.query.problemType) posts = posts.filter((p) => p.problemType === oneOf(req.query.problemType, 'problemType', PROBLEM_TYPES));
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      posts = posts.filter((p) => `${p.title} ${p.body}`.toLowerCase().includes(q));
    }
    sendList(req, res, [...posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(serializePost));
  });

  router.post('/posts', (req, res) => {
    const input = body(req);
    const post = {
      id: `post-${crypto.randomUUID()}`,
      authorName: str(input.authorName, 'authorName', { max: 60 }),
      title: str(input.title, 'title', { min: 5, max: 150 }),
      body: str(input.body, 'body', { min: 5, max: 3000 }),
      crop: str(input.crop, 'crop', { max: 50 }),
      district: str(input.district, 'district', { max: 60 }),
      problemType: oneOf(input.problemType, 'problemType', PROBLEM_TYPES),
      createdAt: new Date().toISOString(),
      likeCount: 0,
      likedBy: [],
    };
    store.data.posts.push(post);
    store.save();
    res.status(201).json(serializePost(post));
  });

  router.get('/posts/:id', (req, res) => res.json(serializePost(findPost(req.params.id))));

  router.get('/posts/:id/replies', (req, res) => {
    findPost(req.params.id);
    sendList(req, res, [...repliesOf(req.params.id)].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  });

  router.post('/posts/:id/replies', (req, res) => {
    const post = findPost(req.params.id);
    const input = body(req);
    const reply = {
      id: `reply-${crypto.randomUUID()}`,
      postId: post.id,
      authorName: str(input.authorName, 'authorName', { max: 60 }),
      body: str(input.body, 'body', { min: 2, max: 2000 }),
      createdAt: new Date().toISOString(),
    };
    store.data.replies.push(reply);
    store.save();
    res.status(201).json(reply);
  });

  // One like per device, idempotent in both directions.
  router.post('/posts/:id/like', (req, res) => {
    const post = findPost(req.params.id);
    const device = deviceId(req);
    if (!post.likedBy.includes(device)) {
      post.likedBy.push(device);
      post.likeCount += 1;
      store.save();
    }
    res.json(serializePost(post));
  });

  router.delete('/posts/:id/like', (req, res) => {
    const post = findPost(req.params.id);
    const device = deviceId(req);
    if (post.likedBy.includes(device)) {
      post.likedBy = post.likedBy.filter((d) => d !== device);
      post.likeCount = Math.max(0, post.likeCount - 1);
      store.save();
    }
    res.json(serializePost(post));
  });

  return router;
};
