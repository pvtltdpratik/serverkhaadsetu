const express = require('express');
const multer = require('multer');
const { HttpError, asyncHandler, str, num, oneOf, bool, isoDate, body, deviceId } = require('../utils/http');
const reviews = require('../services/fertilizerReviews');
const crops = require('../data/cropReference');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 3 } });

const today = () => new Date().toISOString().slice(0, 10);

// The farmer's side of the structured fertilizer log (three phases), what they earn for it, and the reviews other
// farmers read. Mounted at /v1/reviews.
module.exports = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  // ---- reference data for the forms and the calculator ----
  router.get('/reference/crops', ah(async (req, res) => res.json(crops.list())));

  // ---- what other farmers see on a product ----
  router.get('/product/:productId', ah(async (req, res) => {
    const q = req.query;
    res.json(await reviews.forProduct(db, {
      productId: req.params.productId,
      soil: q.soil ? oneOf(q.soil, 'soil', reviews.SOILS) : undefined,
      crop: q.crop ? String(q.crop) : undefined,
      district: q.district ? String(q.district) : undefined,
      season: q.season ? oneOf(q.season, 'season', ['kharif', 'rabi', 'zaid']) : undefined,
      size: q.size ? oneOf(q.size, 'size', ['small', 'medium', 'large']) : undefined,
      improved: q.improved === '1' || q.improved === 'true',
    }));
  }));

  router.get('/product/:productId/prediction', ah(async (req, res) => {
    res.json(await reviews.predictYield(db, {
      owner: deviceId(req), productId: req.params.productId,
      acres: num(req.query.acres, 'acres', { min: 0.1, max: 1000 }), crop: str(req.query.crop, 'crop', { max: 40 }),
    }));
  }));

  // ---- rewards ----
  router.get('/rewards', ah(async (req, res) => res.json(await reviews.rewardsOf(db, deviceId(req)))));
  router.post('/rewards/redeem', ah(async (req, res) => {
    res.json(await reviews.redeemCoins(db, deviceId(req), num(body(req).coins, 'coins', { min: 1, max: 100000, integer: true })));
  }));

  // ---- my log ----
  router.get('/eligible', ah(async (req, res) => res.json(await reviews.eligibleProducts(db, deviceId(req)))));
  router.get('/prefill/:productId', ah(async (req, res) => res.json(await reviews.prefill(db, deviceId(req), req.params.productId))));
  router.get('/mine', ah(async (req, res) => res.json(await reviews.listMine(db, deviceId(req)))));

  // Phase 1: the baseline, before the fertilizer goes on.
  router.post('/', ah(async (req, res) => {
    const input = body(req);
    const appliedOn = isoDate(input.appliedOn === undefined ? today() : input.appliedOn, 'appliedOn');
    if (appliedOn > today()) throw new HttpError(400, '"appliedOn" cannot be in the future');
    res.status(201).json(await reviews.startPhase1(db, {
      owner: deviceId(req),
      productId: str(input.productId, 'productId', { max: 100 }),
      input: {
        acres: num(input.acres, 'acres', { min: 0.1, max: 1000 }),
        crop: str(input.crop, 'crop', { max: 40 }),
        variety: str(input.variety, 'variety', { max: 60, optional: true }) || '',
        growthStage: oneOf(input.growthStage, 'growthStage', reviews.STAGES),
        irrigation: input.irrigation === undefined ? undefined : oneOf(input.irrigation, 'irrigation', reviews.IRRIGATION),
        qtyPerAcre: num(input.qtyPerAcre, 'qtyPerAcre', { min: 0.1, max: 100000 }),
        method: oneOf(input.method, 'method', reviews.METHODS),
        reason: oneOf(input.reason, 'reason', reviews.REASONS),
        appliedOn,
      },
    }));
  }));

  // Phase 2: how the crop looks a month on.
  router.post('/:id/mid', ah(async (req, res) => {
    const input = body(req);
    res.json(await reviews.submitMid(db, {
      owner: deviceId(req), id: req.params.id,
      input: {
        colorChange: oneOf(input.colorChange, 'colorChange', reviews.MID_CHANGES),
        leafHealth: oneOf(input.leafHealth, 'leafHealth', reviews.LEAF),
        pestDisease: bool(input.pestDisease, 'pestDisease'),
        pestNote: str(input.pestNote, 'pestNote', { max: 200, optional: true }) || '',
        soilFeel: oneOf(input.soilFeel, 'soilFeel', reviews.SOIL_FEEL),
        unexpected: str(input.unexpected, 'unexpected', { max: 300, optional: true }) || '',
      },
    }));
  }));

  // Phase 3: the harvest.
  router.post('/:id/post', ah(async (req, res) => {
    const input = body(req);
    res.json(await reviews.submitPost(db, {
      owner: deviceId(req), id: req.params.id,
      input: {
        yieldQpa: num(input.yieldQpa, 'yieldQpa', { min: 0.1, max: 5000 }),
        lastSeasonQpa: input.lastSeasonQpa === undefined || input.lastSeasonQpa === null ? undefined : num(input.lastSeasonQpa, 'lastSeasonQpa', { min: 0.1, max: 5000 }),
        starsOverall: num(input.starsOverall, 'starsOverall', { min: 1, max: 5, integer: true }),
        starsValue: num(input.starsValue, 'starsValue', { min: 1, max: 5, integer: true }),
        starsEase: num(input.starsEase, 'starsEase', { min: 1, max: 5, integer: true }),
        useAgain: oneOf(input.useAgain, 'useAgain', reviews.USE_AGAIN),
        recommend: bool(input.recommend, 'recommend'),
        comment: str(input.comment, 'comment', { max: 1000, optional: true }) || '',
      },
    }));
  }));

  router.post('/:id/photos/:kind', upload.single('file'), ah(async (req, res) => {
    res.status(201).json(await reviews.savePhoto(db, { owner: deviceId(req), id: req.params.id, kind: req.params.kind, buffer: req.file && req.file.buffer }));
  }));

  return router;
};

// The agronomist's side, under /v1/admin/reviews.
module.exports.admin = (db) => {
  const router = express.Router();
  const ah = asyncHandler;
  router.get('/flagged', ah(async (req, res) => res.json(await reviews.flagged(db))));
  router.post('/:id/decide', ah(async (req, res) => {
    const input = body(req);
    res.json(await reviews.decide(db, { id: req.params.id, decision: oneOf(input.decision, 'decision', ['validate', 'reject']), note: str(input.note, 'note', { max: 300, optional: true }) || '' }));
  }));
  router.post('/:id/feature', ah(async (req, res) => res.json(await reviews.feature(db, { id: req.params.id }))));
  // Every finished, published review as a training record for the recommendation and yield models.
  router.get('/training-data', ah(async (req, res) => res.json(await reviews.trainingData(db))));
  return router;
};
