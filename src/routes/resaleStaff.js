const express = require('express');
const { HttpError, asyncHandler, str, num, oneOf, bool, isoDate, body, deviceId } = require('../utils/http');
const resale = require('../services/resale');
const { upiId } = require('./resale');
const { recordAudit } = require('../services/audit');

// What the operator checks with the goods in front of them.
const readChecklist = (input) => ({
  productMatches: bool(input.productMatches, 'productMatches'),
  seal: oneOf(input.seal, 'seal', resale.SEALS),
  units: num(input.units, 'units', { min: 1, max: 100000, integer: true }),
  mfgDate: input.mfgDate ? isoDate(input.mfgDate, 'mfgDate') : undefined,
  expiryDate: isoDate(input.expiryDate, 'expiryDate'),
  batchNumber: str(input.batchNumber, 'batchNumber', { min: 1, max: 40, optional: true }) || '',
  visual: oneOf(input.visual, 'visual', resale.VISUALS),
  purchaseProofSeen: input.purchaseProofSeen === undefined ? false : bool(input.purchaseProofSeen, 'purchaseProofSeen'),
  unitPrice: input.unitPrice === undefined || input.unitPrice === null ? undefined : num(input.unitPrice, 'unitPrice', { min: 1, max: 1000000 }),
  upiId: upiId(input.upiId),
  notes: str(input.notes, 'notes', { max: 300, optional: true }) || '',
});

// The village center's side: check what farmers want to sell, take goods in at the counter, and pay out cash.
// Mounted under /v1/operator/resale, after the operator check, so req.center is this operator's center.
const operatorResale = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  router.get('/', ah(async (req, res) => {
    const statuses = req.query.status ? String(req.query.status).split(',').map((s) => oneOf(s, 'status', ['pending_verification', 'inspection_required', 'live', 'awaiting_handover', 'listed', 'sold_out', 'rejected', 'withdrawn'])) : undefined;
    res.json(await resale.queue(db, req.center.centerId, statuses));
  }));

  router.get('/sellers', ah(async (req, res) => res.json(await resale.findSellers(db, req.query.q))));

  router.post('/suggest', ah(async (req, res) => {
    const input = body(req);
    res.json(await resale.suggest(db, {
      productId: str(input.productId, 'productId', { max: 100 }),
      condition: oneOf(input.condition, 'condition', resale.CONDITIONS),
      visual: input.visual ? oneOf(input.visual, 'visual', resale.VISUALS) : undefined,
      mfgDate: input.mfgDate ? isoDate(input.mfgDate, 'mfgDate') : undefined,
    }));
  }));

  router.post('/walk-in', ah(async (req, res) => {
    const input = body(req);
    const sellerId = str(input.sellerId, 'sellerId', { max: 100, optional: true });
    res.status(201).json(await resale.walkIn(db, {
      centerId: req.center.centerId,
      actor: deviceId(req),
      sellerId,
      sellerName: str(input.sellerName, 'sellerName', { max: 80, optional: true }),
      sellerPhone: str(input.sellerPhone, 'sellerPhone', { max: 20, optional: true }),
      productId: str(input.productId, 'productId', { max: 100 }),
      checklist: readChecklist(input),
      payoutMode: input.payoutMode ? oneOf(input.payoutMode, 'payoutMode', resale.PAYOUT_MODES) : undefined,
    }));
  }));

  router.get('/payouts/cash', ah(async (req, res) => res.json(await resale.cashDue(db, req.center.centerId))));
  router.post('/payouts/:saleId/cash-paid', ah(async (req, res) => res.json(await resale.markCashPaid(db, { centerId: req.center.centerId, saleId: req.params.saleId }))));

  router.get('/:id', ah(async (req, res) => {
    const listing = await resale.getListing(db, req.params.id);
    if (listing.centerId !== req.center.centerId) throw new HttpError(404, 'Listing not found');
    res.json(listing);
  }));

  router.get('/:id/photos/:kind', ah(async (req, res) => {
    const listing = await resale.getListing(db, req.params.id);
    if (listing.centerId !== req.center.centerId) throw new HttpError(404, 'Listing not found');
    const photo = await resale.readPhoto(db, req.params.id, req.params.kind);
    res.set({ 'Content-Type': photo.contentType, 'Cache-Control': 'private, no-store' }).send(photo.data);
  }));

  router.post('/:id/preapprove', ah(async (req, res) => res.json(await resale.preapprove(db, { centerId: req.center.centerId, actor: deviceId(req), id: req.params.id }))));

  router.post('/:id/request-inspection', ah(async (req, res) => {
    res.json(await resale.requestInspection(db, { centerId: req.center.centerId, id: req.params.id, note: str(body(req).note, 'note', { max: 200, optional: true }) || '' }));
  }));

  router.post('/:id/reject', ah(async (req, res) => {
    res.json(await resale.rejectListing(db, { centerId: req.center.centerId, id: req.params.id, reason: str(body(req).reason, 'reason', { min: 3, max: 300 }) }));
  }));

  router.post('/:id/inspect', ah(async (req, res) => {
    res.json(await resale.inspect(db, { centerId: req.center.centerId, actor: deviceId(req), id: req.params.id, checklist: readChecklist(body(req)) }));
  }));

  return router;
};

// The platform's side: complaints about surplus goods, and UPI payouts to sellers.
const adminResale = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  router.get('/disputes', ah(async (req, res) => res.json(await resale.disputes(db, req.query.status ? oneOf(req.query.status, 'status', ['open', 'upheld', 'rejected']) : undefined))));

  router.post('/disputes/:id/resolve', ah(async (req, res) => {
    const input = body(req);
    const decision = oneOf(input.decision, 'decision', ['uphold', 'reject']);
    res.json(await resale.resolveDispute(db, {
      disputeId: req.params.id,
      decision,
      refundPercent: decision === 'uphold' ? num(input.refundPercent, 'refundPercent', { min: 1, max: 100, integer: true }) : undefined,
      note: str(input.note, 'note', { max: 300, optional: true }) || '',
      after: (c, result) => recordAudit(c, req, { action: `resale.dispute.${decision}`, targetType: 'resale_dispute', targetId: req.params.id, details: result }),
    }));
  }));

  router.get('/payouts/upi', ah(async (req, res) => res.json(await resale.upiPending(db))));
  router.post('/payouts/:saleId/paid', ah(async (req, res) => {
    res.json(await resale.markUpiPaid(db, { saleId: req.params.saleId, reference: str(body(req).reference, 'reference', { max: 60, optional: true }) || '' }));
  }));

  return router;
};

module.exports = { operatorResale, adminResale };
