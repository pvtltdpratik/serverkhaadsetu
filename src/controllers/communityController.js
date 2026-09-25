const { str, oneOf, body, deviceId, sendPaged, likePattern } = require('../utils/http');
const community = require('../services/communityService');

module.exports = (db) => ({
  listPosts: async (req, res) => {
    const where = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (req.query.crop) add('lower(p.crop_tag) = lower(?)', String(req.query.crop));
    if (req.query.district) add('lower(p.district_tag) = lower(?)', String(req.query.district));
    if (req.query.problemType) add('p.problem_type_tag = ?', oneOf(req.query.problemType, 'problemType', community.PROBLEM_TYPES));
    if (req.query.q) add("(p.title || ' ' || p.content) ILIKE ?", likePattern(req.query.q));
    await sendPaged(req, res, db, {
      select: community.POST_COLUMNS,
      from: `${community.POST_FROM}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'p.created_at DESC, p.post_id',
    });
  },

  createPost: async (req, res) => {
    const input = body(req);
    const post = await community.createPost(db, {
      farmerId: deviceId(req),
      title: str(input.title, 'title', { min: 5, max: 150 }),
      content: str(input.content, 'content', { min: 5, max: 3000 }),
      cropTag: str(input.cropTag, 'cropTag', { max: 50, optional: true }) || '',
      districtTag: str(input.districtTag, 'districtTag', { max: 60, optional: true }) || '',
      problemTypeTag: oneOf(input.problemTypeTag, 'problemTypeTag', community.PROBLEM_TYPES),
    });
    res.status(201).json(post);
  },

  // The signed-in farmer's own posts and replies, newest first, each reply with the title
  // of the post it is under so the profile can link back to it.
  mine: async (req, res) => {
    const owner = deviceId(req);
    const posts = (await db.query(
      `SELECT ${community.POST_COLUMNS} FROM ${community.POST_FROM} WHERE p.farmer_id = $1 ORDER BY p.created_at DESC, p.post_id LIMIT 100`, [owner],
    )).rows;
    const comments = (await db.query(
      `SELECT ${community.COMMENT_COLUMNS}, p.title AS "postTitle" FROM ${community.COMMENT_FROM}
         JOIN community_post p ON p.post_id = c.post_id WHERE c.farmer_id = $1 ORDER BY c.created_at DESC, c.comment_id LIMIT 100`, [owner],
    )).rows;
    res.json({ posts, comments });
  },

  getPost: async (req, res) => {
    const post = await community.findPost(db, req.params.id);
    const comments = await community.commentsForPost(db, req.params.id);
    const likedByMe = await community.hasLiked(db, req.params.id, deviceId(req));
    res.json({ ...post, likedByMe, comments });
  },

  addComment: async (req, res) => {
    const input = body(req);
    const comment = await community.addComment(db, {
      postId: req.params.id,
      farmerId: deviceId(req),
      content: str(input.content, 'content', { min: 2, max: 3000 }),
      agronomistId: str(input.agronomistId, 'agronomistId', { max: 100, optional: true }),
    });
    res.status(201).json(comment);
  },

  editComment: async (req, res) => {
    const input = body(req);
    const comment = await community.editAiComment(db, {
      commentId: req.params.id,
      agronomistId: str(input.agronomistId, 'agronomistId', { max: 100 }),
      content: str(input.content, 'content', { min: 2, max: 3000 }),
    });
    res.json(comment);
  },

  verifyComment: async (req, res) => {
    const input = body(req);
    const comment = await community.verifyComment(db, {
      commentId: req.params.id,
      agronomistId: str(input.agronomistId, 'agronomistId', { max: 100 }),
    });
    res.json(comment);
  },

  toggleLike: async (req, res) => {
    const result = await community.toggleLike(db, { postId: req.params.id, farmerId: deviceId(req) });
    res.json(result);
  },
});
