const express = require('express');
const crypto = require('crypto');
const { HttpError, asyncHandler, str, oneOf, body, deviceId, sendPaged, likePattern } = require('../utils/http');

const PROBLEM_TYPES = ['pest', 'disease', 'nutrientDeficiency', 'weather', 'market', 'general'];

const POST_COLUMNS = `p.id, p.author_name AS "authorName", p.title, p.body, p.crop, p.district, p.problem_type AS "problemType",
  p.created_at AS "createdAt", (SELECT count(*)::int FROM replies r WHERE r.post_id = p.id) AS "replyCount", p.like_count AS "likeCount"`;
const REPLY_COLUMNS = 'id, post_id AS "postId", author_name AS "authorName", body, created_at AS "createdAt"';

module.exports = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  const findPost = async (id, q = db) => {
    const { rows } = await q.query(`SELECT ${POST_COLUMNS} FROM posts p WHERE p.id = $1`, [id]);
    if (!rows.length) throw new HttpError(404, 'Post not found');
    return rows[0];
  };

  router.get('/posts', ah(async (req, res) => {
    const where = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (req.query.crop) add('lower(p.crop) = lower(?)', String(req.query.crop));
    if (req.query.district) add('lower(p.district) = lower(?)', String(req.query.district));
    if (req.query.problemType) add('p.problem_type = ?', oneOf(req.query.problemType, 'problemType', PROBLEM_TYPES));
    if (req.query.q) add("(p.title || ' ' || p.body) ILIKE ?", likePattern(req.query.q));
    await sendPaged(req, res, db, {
      select: POST_COLUMNS,
      from: `posts p${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'p.created_at DESC, p.id',
    });
  }));

  router.post('/posts', ah(async (req, res) => {
    const input = body(req);
    const post = {
      id: `post-${crypto.randomUUID()}`,
      authorName: str(input.authorName, 'authorName', { max: 60 }),
      title: str(input.title, 'title', { min: 5, max: 150 }),
      body: str(input.body, 'body', { min: 5, max: 3000 }),
      crop: str(input.crop, 'crop', { max: 50 }),
      district: str(input.district, 'district', { max: 60 }),
      problemType: oneOf(input.problemType, 'problemType', PROBLEM_TYPES),
    };
    await db.query(
      'INSERT INTO posts (id, author_name, title, body, crop, district, problem_type) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [post.id, post.authorName, post.title, post.body, post.crop, post.district, post.problemType],
    );
    res.status(201).json(await findPost(post.id));
  }));

  router.get('/posts/:id', ah(async (req, res) => res.json(await findPost(req.params.id))));

  router.get('/posts/:id/replies', ah(async (req, res) => {
    await findPost(req.params.id);
    await sendPaged(req, res, db, {
      select: REPLY_COLUMNS, from: 'replies WHERE post_id = $1', params: [req.params.id], order: 'created_at, id',
    });
  }));

  router.post('/posts/:id/replies', ah(async (req, res) => {
    await findPost(req.params.id);
    const input = body(req);
    const { rows } = await db.query(
      `INSERT INTO replies (id, post_id, author_name, body) VALUES ($1,$2,$3,$4) RETURNING ${REPLY_COLUMNS}`,
      [`reply-${crypto.randomUUID()}`, req.params.id, str(input.authorName, 'authorName', { max: 60 }), str(input.body, 'body', { min: 2, max: 2000 })],
    );
    res.status(201).json(rows[0]);
  }));

  // One like per owner, idempotent in both directions. The counter only moves
  // when a like row was actually added or removed.
  router.post('/posts/:id/like', ah(async (req, res) => {
    const owner = deviceId(req);
    res.json(await db.tx(async (c) => {
      await findPost(req.params.id, c);
      const added = await c.query('INSERT INTO post_likes (post_id, owner_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, owner]);
      if (added.rowCount) await c.query('UPDATE posts SET like_count = like_count + 1 WHERE id = $1', [req.params.id]);
      return findPost(req.params.id, c);
    }));
  }));

  router.delete('/posts/:id/like', ah(async (req, res) => {
    const owner = deviceId(req);
    res.json(await db.tx(async (c) => {
      await findPost(req.params.id, c);
      const removed = await c.query('DELETE FROM post_likes WHERE post_id = $1 AND owner_id = $2', [req.params.id, owner]);
      if (removed.rowCount) await c.query('UPDATE posts SET like_count = GREATEST(0, like_count - 1) WHERE id = $1', [req.params.id]);
      return findPost(req.params.id, c);
    }));
  }));

  return router;
};
