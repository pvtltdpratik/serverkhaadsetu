-- Community v2: replaces the original posts/replies/post_likes (author-name
-- text only, no comments, no AI, no agronomists) with a proper Q&A model.
-- farmer_id is the Supabase user id (or the anonymous device id when
-- authentication is off) — see 001_init.sql's note on owner_id; deliberately
-- not a foreign key, since accounts live in Supabase, not in this database.

DROP TABLE IF EXISTS post_likes;
DROP TABLE IF EXISTS replies;
DROP TABLE IF EXISTS posts;

CREATE TABLE agronomist (
  agronomist_id    text PRIMARY KEY,
  name             text NOT NULL,
  verified_status  boolean NOT NULL DEFAULT false,
  specialization   text NOT NULL DEFAULT ''
);

CREATE TABLE community_post (
  post_id           text PRIMARY KEY,
  farmer_id         text NOT NULL,
  title             text NOT NULL,
  content           text NOT NULL,
  crop_tag          text NOT NULL DEFAULT '',
  district_tag      text NOT NULL DEFAULT '',
  problem_type_tag  text NOT NULL CHECK (problem_type_tag IN ('pest','disease','nutrientDeficiency','weather','market','general')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- One index per filter param (crop, district, problemType) plus the default sort.
CREATE INDEX community_post_created_idx ON community_post (created_at DESC);
CREATE INDEX community_post_crop_idx ON community_post (crop_tag);
CREATE INDEX community_post_district_idx ON community_post (district_tag);
CREATE INDEX community_post_problem_type_idx ON community_post (problem_type_tag);

CREATE TABLE post_comment (
  comment_id              text PRIMARY KEY,
  post_id                 text NOT NULL REFERENCES community_post(post_id) ON DELETE CASCADE,
  farmer_id               text NOT NULL,
  content                 text NOT NULL,
  is_ai_generated         boolean NOT NULL DEFAULT false,
  is_agronomist_verified  boolean NOT NULL DEFAULT false,
  agronomist_id           text REFERENCES agronomist(agronomist_id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_comment_post_idx ON post_comment (post_id, created_at);

CREATE TABLE post_like (
  like_id     text PRIMARY KEY,
  post_id     text NOT NULL REFERENCES community_post(post_id) ON DELETE CASCADE,
  farmer_id   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, farmer_id)
);
