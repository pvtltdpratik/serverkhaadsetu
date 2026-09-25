const express = require('express');
const multer = require('multer');
const { HttpError, asyncHandler, str, num, oneOf, isoDate, body, deviceId } = require('../utils/http');
const resale = require('../services/resale');
const wallet = require('../services/wallet');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 3 } });

const UPI = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/;
const upiId = (v) => {
  if (v === undefined || v === null || v === '') return '';
  const s = str(v, 'upiId', { max: 60 });
  if (!UPI.test(s)) throw new HttpError(400, '"upiId" must look like name@bank');
  return s;
};

// The farmer's side of selling leftover organic fertilizer, and of the platform wallet.
const resaleRouter = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  // What this farmer bought and collected, and how much of it may be resold.
  router.get('/eligible', ah(async (req, res) => res.json(await resale.eligibleProducts(db, deviceId(req)))));

  // The suggested price and the range a farmer may choose from.
  router.post('/suggest', ah(async (req, res) => {
    const input = body(req);
    res.json(await resale.suggest(db, {
      productId: str(input.productId, 'productId', { max: 100 }),
      condition: oneOf(input.condition, 'condition', resale.CONDITIONS),
      mfgDate: input.mfgDate ? isoDate(input.mfgDate, 'mfgDate') : undefined,
    }));
  }));

  router.get('/mine', ah(async (req, res) => res.json(await resale.listMine(db, deviceId(req)))));

  // Starts a listing as a draft; the photos are added, then it is submitted.
  router.post('/', ah(async (req, res) => {
    const input = body(req);
    const listing = await resale.createDraft(db, {
      seller: deviceId(req),
      productId: str(input.productId, 'productId', { max: 100 }),
      units: num(input.units, 'units', { min: 1, max: 100000, integer: true }),
      condition: oneOf(input.condition, 'condition', resale.CONDITIONS),
      mfgDate: input.mfgDate ? isoDate(input.mfgDate, 'mfgDate') : undefined,
      expiryDate: isoDate(input.expiryDate, 'expiryDate'),
      batchNumber: str(input.batchNumber, 'batchNumber', { max: 40, optional: true }) || '',
      askingPrice: num(input.askingPrice, 'askingPrice', { min: 1, max: 1000000 }),
      centerId: str(input.centerId, 'centerId', { max: 100 }),
      payoutMode: oneOf(input.payoutMode, 'payoutMode', resale.PAYOUT_MODES),
      upiId: upiId(input.upiId),
    });
    res.status(201).json(listing);
  }));

  router.post('/:id/photos/:kind', upload.single('file'), ah(async (req, res) => {
    res.status(201).json(await resale.savePhoto(db, deviceId(req), req.params.id, req.params.kind, req.file && req.file.buffer));
  }));

  router.get('/:id/photos/:kind', ah(async (req, res) => {
    await resale.detailMine(db, deviceId(req), req.params.id); // 404 unless it is theirs
    const photo = await resale.readPhoto(db, req.params.id, req.params.kind);
    res.set({ 'Content-Type': photo.contentType, 'Cache-Control': 'private, no-store' }).send(photo.data);
  }));

  router.post('/:id/submit', ah(async (req, res) => res.json(await resale.submit(db, deviceId(req), req.params.id))));
  router.post('/:id/withdraw', ah(async (req, res) => res.json(await resale.withdrawMine(db, deviceId(req), req.params.id))));

  // A buyer's complaint about surplus goods, within 48 hours of collecting them.
  router.post('/disputes', ah(async (req, res) => {
    const input = body(req);
    res.status(201).json(await resale.raiseDispute(db, {
      buyer: deviceId(req), orderId: str(input.orderId, 'orderId', { max: 100 }), reason: str(input.reason, 'reason', { min: 5, max: 500 }),
    }));
  }));

  router.get('/:id', ah(async (req, res) => res.json(await resale.detailMine(db, deviceId(req), req.params.id))));

  return router;
};

const walletRouter = (db) => {
  const router = express.Router();
  router.get('/', asyncHandler(async (req, res) => {
    const owner = deviceId(req);
    res.json({ balance: await wallet.balanceOf(db, owner), entries: await wallet.entriesOf(db, owner) });
  }));
  return router;
};

module.exports = { resaleRouter, walletRouter, upiId };
