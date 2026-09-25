const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const { generateDraftAnswer } = require('./aiAnswerService');

const PROBLEM_TYPES = ['pest', 'disease', 'nutrientDeficiency', 'weather', 'market', 'general'];

const POST_COLUMNS = `p.post_id AS "postId", p.farmer_id AS "farmerId", COALESCE(pr.name, 'Farmer') AS "farmerName",
  p.title, p.content, p.crop_tag AS "cropTag", p.district_tag AS "districtTag", p.problem_type_tag AS "problemTypeTag",
  p.created_at AS "createdAt", p.updated_at AS "updatedAt",
  (SELECT count(*)::int FROM post_comment c WHERE c.post_id = p.post_id) AS "commentCount",
  (SELECT count(*)::int FROM post_like l WHERE l.post_id = p.post_id) AS "likeCount"`;
const POST_FROM = 'community_post p LEFT JOIN profiles pr ON pr.owner_id = p.farmer_id';

const COMMENT_COLUMNS = `c.comment_id AS "commentId", c.post_id AS "postId", c.farmer_id AS "farmerId",
  COALESCE(a.name, pr.name, 'Farmer') AS "farmerName", c.content, c.is_ai_generated AS "isAiGenerated",
  c.is_agronomist_verified AS "isAgronomistVerified", c.agronomist_id AS "agronomistId", a.name AS "agronomistName",
  c.created_at AS "createdAt"`;
const COMMENT_FROM = 'post_comment c LEFT JOIN profiles pr ON pr.owner_id = c.farmer_id LEFT JOIN agronomist a ON a.agronomist_id = c.agronomist_id';

const newPostId = () => `post-${crypto.randomUUID()}`;
const newCommentId = () => `comment-${crypto.randomUUID()}`;
const newLikeId = () => `like-${crypto.randomUUID()}`;

const findPost = async (q, id) => {
  const { rows } = await q.query(`SELECT ${POST_COLUMNS} FROM ${POST_FROM} WHERE p.post_id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'Post not found');
  return rows[0];
};

const findComment = async (q, id) => {
  const { rows } = await q.query(`SELECT ${COMMENT_COLUMNS} FROM ${COMMENT_FROM} WHERE c.comment_id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'Comment not found');
  return rows[0];
};

const findVerifiedAgronomist = async (q, id) => {
  const { rows } = await q.query('SELECT agronomist_id AS "agronomistId", verified_status AS "verifiedStatus" FROM agronomist WHERE agronomist_id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Agronomist not found');
  if (!rows[0].verifiedStatus) throw new HttpError(403, 'This agronomist is not verified');
  return rows[0];
};

const commentsForPost = async (q, postId) =>
  (await q.query(`SELECT ${COMMENT_COLUMNS} FROM ${COMMENT_FROM} WHERE c.post_id = $1 ORDER BY c.created_at, c.comment_id`, [postId])).rows;

// Every new post gets a draft AI answer as its first comment, in the same
// transaction as the post itself — a post never exists without one. The
// generator is synchronous and can't fail today; if it is ever swapped for a
// real network-calling model, whether a draft failure should still let the
// post through (rather than failing the whole request) is worth revisiting
// then — right now failing together is the simpler, safer default.
const createPost = async (db, { farmerId, title, content, cropTag, districtTag, problemTypeTag }) => {
  const id = newPostId();
  await db.tx(async (c) => {
    await c.query(
      'INSERT INTO community_post (post_id, farmer_id, title, content, crop_tag, district_tag, problem_type_tag) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, farmerId, title, content, cropTag, districtTag, problemTypeTag],
    );
    const draft = generateDraftAnswer({ title, content, cropTag, districtTag, problemTypeTag });
    await addAiComment(c, { postId: id, content: draft });
  });
  return findPost(db, id);
};

const addComment = async (db, { postId, farmerId, content, agronomistId }) => {
  return db.tx(async (c) => {
    await findPost(c, postId); // 404 if the post does not exist
    if (agronomistId) await findVerifiedAgronomist(c, agronomistId);
    const id = newCommentId();
    await c.query(
      `INSERT INTO post_comment (comment_id, post_id, farmer_id, content, is_ai_generated, is_agronomist_verified, agronomist_id)
       VALUES ($1,$2,$3,$4,false,$5,$6)`,
      [id, postId, farmerId, content, Boolean(agronomistId), agronomistId || null],
    );
    return findComment(c, id);
  });
};

// Used by the AI-answer service too (Phase 2) — always is_ai_generated=true,
// never agronomist-attributed at insert time (that only happens via `verify`).
const addAiComment = async (db, { postId, content }) => {
  const id = newCommentId();
  await db.query(
    "INSERT INTO post_comment (comment_id, post_id, farmer_id, content, is_ai_generated, is_agronomist_verified) VALUES ($1,$2,'ai-assistant',$3,true,false)",
    [id, postId, content],
  );
  return findComment(db, id);
};

// An agronomist can clean up the AI draft's wording before verifying it.
// Editing does not itself verify — that is still the separate call below.
const editAiComment = async (db, { commentId, agronomistId, content }) => {
  return db.tx(async (c) => {
    const comment = await findComment(c, commentId);
    if (!comment.isAiGenerated) throw new HttpError(409, 'Only an AI-generated answer can be edited this way');
    await findVerifiedAgronomist(c, agronomistId);
    await c.query('UPDATE post_comment SET content = $2 WHERE comment_id = $1', [commentId, content]);
    return findComment(c, commentId);
  });
};

const verifyComment = async (db, { commentId, agronomistId }) => {
  return db.tx(async (c) => {
    const comment = await findComment(c, commentId);
    if (!comment.isAiGenerated) throw new HttpError(409, 'Only an AI-generated answer can be verified');
    await findVerifiedAgronomist(c, agronomistId);
    await c.query('UPDATE post_comment SET is_agronomist_verified = true, agronomist_id = $2 WHERE comment_id = $1', [commentId, agronomistId]);
    return findComment(c, commentId);
  });
};

// Toggle: unlike if already liked, else like. Wrapped in a transaction so a
// concurrent double-tap from the same farmer settles on one consistent state.
// The insert uses ON CONFLICT DO NOTHING rather than catching a unique-
// violation — Postgres aborts the *whole* transaction after any statement
// errors (until a ROLLBACK or a SAVEPOINT), so a caught error here would
// still fail every later statement in the same transaction with "current
// transaction is aborted"; ON CONFLICT never raises that error at all.
const hasLiked = async (q, postId, farmerId) =>
  (await q.query('SELECT 1 FROM post_like WHERE post_id = $1 AND farmer_id = $2', [postId, farmerId])).rows.length > 0;

const toggleLike = async (db, { postId, farmerId }) => {
  return db.tx(async (c) => {
    await findPost(c, postId);
    const removed = await c.query('DELETE FROM post_like WHERE post_id = $1 AND farmer_id = $2', [postId, farmerId]);
    let liked = false;
    if (removed.rowCount === 0) {
      await c.query(
        'INSERT INTO post_like (like_id, post_id, farmer_id) VALUES ($1,$2,$3) ON CONFLICT (post_id, farmer_id) DO NOTHING',
        [newLikeId(), postId, farmerId],
      );
      liked = true; // Either we just inserted it, or a concurrent request already did — the row exists either way.
    }
    const { rows } = await c.query('SELECT count(*)::int AS n FROM post_like WHERE post_id = $1', [postId]);
    return { liked, likeCount: rows[0].n };
  });
};

module.exports = {
  PROBLEM_TYPES,
  POST_COLUMNS,
  POST_FROM,
  COMMENT_COLUMNS,
  COMMENT_FROM,
  newPostId,
  findPost,
  hasLiked,
  findComment,
  commentsForPost,
  createPost,
  addComment,
  addAiComment,
  editAiComment,
  verifyComment,
  toggleLike,
};
