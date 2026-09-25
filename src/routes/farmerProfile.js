const crypto = require('crypto');
const express = require('express');
const { HttpError, asyncHandler, str, num, body, deviceId } = require('../utils/http');
const { mergeDetails } = require('../data/farmerDetails');

const MAX_ADDRESSES = 10;

const ADDRESS_COLUMNS = `address_id AS "addressId", label, full_name AS "fullName", phone, line1, line2, landmark, village, taluka,
  district, state, pincode, latitude, longitude, is_default AS "isDefault", created_at AS "createdAt"`;

const PHONE = /^\+?[0-9][0-9 -]{7,14}[0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const phone = (v, name) => {
  const s = str(v, name, { max: 20 });
  if (!PHONE.test(s)) throw new HttpError(400, `"${name}" must be a valid phone number`);
  return s.replace(/[ -]/g, '');
};

// Validates an address body. With `partial`, only the keys sent are checked.
const readAddress = (input, { partial = false } = {}) => {
  const out = {};
  const has = (k) => input[k] !== undefined;
  const need = (k) => !partial || has(k);
  if (need('label')) out.label = has('label') ? str(input.label, 'label', { max: 30 }) : 'Home';
  if (need('fullName')) out.fullName = str(input.fullName, 'fullName', { max: 80 });
  if (need('phone')) out.phone = phone(input.phone, 'phone');
  if (need('line1')) out.line1 = str(input.line1, 'line1', { max: 160 });
  if (need('pincode')) {
    const p = str(input.pincode, 'pincode', { max: 6 });
    if (!/^[1-9][0-9]{5}$/.test(p)) throw new HttpError(400, '"pincode" must be a 6-digit PIN code');
    out.pincode = p;
  }
  for (const [key, max] of [['line2', 160], ['landmark', 100], ['village', 100], ['taluka', 80], ['district', 80], ['state', 60]]) {
    if (has(key)) out[key] = input[key] === null || input[key] === '' ? '' : str(input[key], key, { max });
  }
  if (has('latitude') || has('longitude')) {
    if (input.latitude === null && input.longitude === null) {
      out.latitude = null;
      out.longitude = null;
    } else {
      out.latitude = num(input.latitude, 'latitude', { min: -90, max: 90 });
      out.longitude = num(input.longitude, 'longitude', { min: -180, max: 180 });
    }
  }
  return out;
};

// Saved addresses, contact details and the answers schemes are checked against.
module.exports = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  const addressFor = async (q, owner, id) => {
    const { rows } = await q.query(`SELECT ${ADDRESS_COLUMNS} FROM farmer_address WHERE owner_id = $1 AND address_id = $2`, [owner, id]);
    if (!rows.length) throw new HttpError(404, 'Address not found');
    return rows[0];
  };

  // ---- Contact details -------------------------------------------------------

  router.get('/contact', ah(async (req, res) => {
    const owner = deviceId(req);
    const row = (await db.query('SELECT contact_email AS email, contact_phone AS phone FROM profiles WHERE owner_id = $1', [owner])).rows[0];
    res.json({ email: row ? row.email : '', phone: row ? row.phone : '', loginEmail: req.userEmail || '' });
  }));

  router.put('/contact', ah(async (req, res) => {
    const owner = deviceId(req);
    const input = body(req);
    const email = input.email === undefined ? undefined : input.email === '' ? '' : str(input.email, 'email', { max: 120 });
    if (email && !EMAIL.test(email)) throw new HttpError(400, '"email" must be a valid email address');
    const mobile = input.phone === undefined ? undefined : input.phone === '' ? '' : phone(input.phone, 'phone');
    const row = (await db.query(
      `INSERT INTO profiles (owner_id, contact_email, contact_phone) VALUES ($1, COALESCE($2,''), COALESCE($3,''))
       ON CONFLICT (owner_id) DO UPDATE SET contact_email = COALESCE($2, profiles.contact_email), contact_phone = COALESCE($3, profiles.contact_phone)
       RETURNING contact_email AS email, contact_phone AS phone`,
      [owner, email === undefined ? null : email, mobile === undefined ? null : mobile],
    )).rows[0];
    res.json({ ...row, loginEmail: req.userEmail || '' });
  }));

  // ---- Addresses ------------------------------------------------------------

  router.get('/addresses', ah(async (req, res) => {
    const rows = (await db.query(
      `SELECT ${ADDRESS_COLUMNS} FROM farmer_address WHERE owner_id = $1 ORDER BY is_default DESC, created_at DESC, address_id`, [deviceId(req)],
    )).rows;
    res.json(rows);
  }));

  router.post('/addresses', ah(async (req, res) => {
    const owner = deviceId(req);
    const a = readAddress(body(req));
    const wantsDefault = req.body.isDefault === true;
    const created = await db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`address:${owner}`]);
      const count = (await c.query('SELECT count(*)::int AS n FROM farmer_address WHERE owner_id = $1', [owner])).rows[0].n;
      if (count >= MAX_ADDRESSES) throw new HttpError(409, `You can save up to ${MAX_ADDRESSES} addresses`);
      // The first address is the default; so is one the farmer asks for.
      const isDefault = count === 0 || wantsDefault;
      if (isDefault) await c.query('UPDATE farmer_address SET is_default = false WHERE owner_id = $1', [owner]);
      const id = `addr-${crypto.randomUUID()}`;
      await c.query(
        `INSERT INTO farmer_address (address_id, owner_id, label, full_name, phone, line1, line2, landmark, village, taluka, district, state, pincode, latitude, longitude, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,'Maharashtra'),$13,$14,$15,$16)`,
        [id, owner, a.label, a.fullName, a.phone, a.line1, a.line2 || '', a.landmark || '', a.village || '', a.taluka || '', a.district || '',
          a.state || null, a.pincode, a.latitude ?? null, a.longitude ?? null, isDefault],
      );
      return addressFor(c, owner, id);
    });
    res.status(201).json(created);
  }));

  router.patch('/addresses/:id', ah(async (req, res) => {
    const owner = deviceId(req);
    const a = readAddress(body(req), { partial: true });
    const updated = await db.tx(async (c) => {
      await addressFor(c, owner, req.params.id);
      const sets = [];
      const params = [owner, req.params.id];
      const column = { fullName: 'full_name' };
      for (const [k, v] of Object.entries(a)) {
        params.push(v);
        sets.push(`${column[k] || k} = $${params.length}`);
      }
      if (sets.length) await c.query(`UPDATE farmer_address SET ${sets.join(', ')}, updated_at = now() WHERE owner_id = $1 AND address_id = $2`, params);
      return addressFor(c, owner, req.params.id);
    });
    res.json(updated);
  }));

  router.post('/addresses/:id/default', ah(async (req, res) => {
    const owner = deviceId(req);
    const updated = await db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`address:${owner}`]);
      await addressFor(c, owner, req.params.id);
      await c.query('UPDATE farmer_address SET is_default = false WHERE owner_id = $1 AND is_default', [owner]);
      await c.query('UPDATE farmer_address SET is_default = true WHERE owner_id = $1 AND address_id = $2', [owner, req.params.id]);
      return addressFor(c, owner, req.params.id);
    });
    res.json(updated);
  }));

  router.delete('/addresses/:id', ah(async (req, res) => {
    const owner = deviceId(req);
    await db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`address:${owner}`]);
      const gone = await addressFor(c, owner, req.params.id);
      await c.query('DELETE FROM farmer_address WHERE owner_id = $1 AND address_id = $2', [owner, req.params.id]);
      // Deleting the default hands the role to the newest remaining address.
      if (gone.isDefault) {
        await c.query(
          `UPDATE farmer_address SET is_default = true WHERE address_id = (
             SELECT address_id FROM farmer_address WHERE owner_id = $1 ORDER BY created_at DESC, address_id LIMIT 1)`, [owner],
        );
      }
    });
    res.status(204).end();
  }));

  // ---- What the farmer told us, for scheme checks ----------------------------

  const readDetails = async (q, owner) => {
    const row = (await q.query('SELECT data, updated_at AS "updatedAt" FROM farmer_details WHERE owner_id = $1', [owner])).rows[0];
    return { details: row ? row.data : {}, updatedAt: row ? row.updatedAt : null };
  };

  router.get('/details', ah(async (req, res) => res.json(await readDetails(db, deviceId(req)))));

  router.put('/details', ah(async (req, res) => {
    const owner = deviceId(req);
    const input = body(req);
    const out = await db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`details:${owner}`]);
      const next = mergeDetails((await readDetails(c, owner)).details, input);
      const row = (await c.query(
        `INSERT INTO farmer_details (owner_id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (owner_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() RETURNING data AS details, updated_at AS "updatedAt"`,
        [owner, JSON.stringify(next)],
      )).rows[0];
      return row;
    });
    res.json(out);
  }));

  return router;
};
