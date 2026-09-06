-- Existing orders remain readable by their public capability. Their old
-- idempotency keys fail closed because the original request cannot be verified.
alter table orders add column request_fingerprint text
  check (request_fingerprint ~ '^[0-9a-f]{64}$');

-- Payment/expiry inventory joins otherwise repeatedly scan all historical items.
create unique index order_items_order_product_idx on order_items(order_id, product_id);
