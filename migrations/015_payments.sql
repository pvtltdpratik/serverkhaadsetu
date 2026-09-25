-- Online payment (Razorpay) for an order's goods.
--
-- The buyer pays the goods online; the home-delivery fee, if any, is still paid in cash to the
-- partner, so the partner never owes the center for goods that were already paid.
-- The money side is only ever decided by the server: the app receives a Razorpay order id to
-- open the checkout with, and the payment counts only after the server has verified
-- Razorpay's signature (or its webhook).
CREATE TABLE payment (
  payment_id           text PRIMARY KEY,
  owner_id             text NOT NULL,
  order_id             text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_paise         integer NOT NULL CHECK (amount_paise > 0),
  currency             text NOT NULL DEFAULT 'INR',
  razorpay_order_id    text NOT NULL UNIQUE,
  razorpay_payment_id  text,
  status               text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','refund_pending','refunded','refund_failed')),
  refund_id            text,
  failure              text NOT NULL DEFAULT '',
  created_at           timestamptz NOT NULL DEFAULT now(),
  paid_at              timestamptz,
  refunded_at          timestamptz
);
CREATE INDEX payment_order_idx ON payment (order_id);
CREATE INDEX payment_owner_idx ON payment (owner_id, created_at DESC);
-- An order can be paid once: only one payment may ever be in a paid-or-refunding state for it.
CREATE UNIQUE INDEX payment_one_paid_per_order ON payment (order_id) WHERE status IN ('paid','refund_pending');

ALTER TABLE orders
  ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
  ADD COLUMN paid_at timestamptz;
