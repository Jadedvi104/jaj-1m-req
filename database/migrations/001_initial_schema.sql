create extension if not exists pgcrypto;

create type order_status as enum (
  'pending_payment', 'paid', 'processing', 'delivered', 'payment_failed', 'expired'
);
create type payment_status as enum (
  'pending', 'confirmed', 'failed', 'refund_pending', 'partially_refunded', 'review_required'
);
create type staff_role as enum (
  'corporation_admin', 'branch_manager', 'cashier', 'kitchen_staff', 'service_staff'
);

create table corporations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table branches (
  id uuid primary key default gen_random_uuid(),
  corporation_id uuid not null references corporations(id),
  name text not null,
  timezone text not null default 'Asia/Bangkok',
  created_at timestamptz not null default now(),
  unique (corporation_id, id)
);

create table dining_tables (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  public_id uuid not null default gen_random_uuid() unique,
  table_number text not null,
  rotating_code_hash text not null,
  rotating_code_expires_at timestamptz not null,
  active boolean not null default true,
  unique (branch_id, table_number),
  unique (branch_id, id)
);

create table table_sessions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null,
  table_id uuid not null,
  expires_at timestamptz not null default now() + interval '30 minutes',
  created_at timestamptz not null default now(),
  foreign key (branch_id, table_id) references dining_tables(branch_id, id)
);
create index table_sessions_expiry_idx on table_sessions(expires_at);

create table staff_users (
  id uuid primary key,
  corporation_id uuid not null references corporations(id),
  email text,
  phone text,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (corporation_id, id)
);

create table staff_branch_assignments (
  corporation_id uuid not null,
  staff_id uuid not null,
  branch_id uuid not null,
  role staff_role not null,
  primary key (staff_id, branch_id, role),
  foreign key (corporation_id, staff_id) references staff_users(corporation_id, id),
  foreign key (corporation_id, branch_id) references branches(corporation_id, id)
);

create table products (
  id uuid primary key default gen_random_uuid(),
  corporation_id uuid not null references corporations(id),
  name_th text not null,
  name_en text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (corporation_id, id)
);

create table branch_menu_items (
  corporation_id uuid not null,
  branch_id uuid not null,
  product_id uuid not null,
  price_satang integer not null check (price_satang >= 0),
  estimated_prep_minutes integer not null check (estimated_prep_minutes > 0),
  available boolean not null default true,
  primary key (branch_id, product_id),
  foreign key (corporation_id, branch_id) references branches(corporation_id, id),
  foreign key (corporation_id, product_id) references products(corporation_id, id)
);

create table product_sizes (
  branch_id uuid not null,
  product_id uuid not null,
  size_code text not null,
  label_th text not null,
  label_en text not null,
  price_satang integer not null check (price_satang >= 0),
  primary key (branch_id, product_id, size_code),
  foreign key (branch_id, product_id) references branch_menu_items(branch_id, product_id)
);

create table daily_inventory (
  branch_id uuid not null,
  product_id uuid not null,
  business_date date not null,
  available_quantity integer not null check (available_quantity >= 0),
  reserved_quantity integer not null default 0 check (reserved_quantity >= 0),
  sold_quantity integer not null default 0 check (sold_quantity >= 0),
  primary key (branch_id, product_id, business_date),
  foreign key (branch_id, product_id) references branch_menu_items(branch_id, product_id),
  check (reserved_quantity + sold_quantity <= available_quantity)
);

create table branch_order_counters (
  branch_id uuid not null references branches(id),
  business_date date not null,
  last_number bigint not null,
  primary key (branch_id, business_date)
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  public_reference uuid not null default gen_random_uuid() unique,
  corporation_id uuid not null references corporations(id),
  branch_id uuid not null,
  table_id uuid not null,
  table_session_id uuid not null references table_sessions(id),
  business_date date not null,
  display_number bigint not null,
  idempotency_key text not null,
  customer_name text not null,
  customer_phone text not null,
  table_number_snapshot text not null,
  status order_status not null default 'pending_payment',
  subtotal_satang integer not null check (subtotal_satang >= 0),
  discount_satang integer not null default 0 check (discount_satang >= 0),
  total_satang integer not null check (total_satang >= 0),
  currency char(3) not null default 'THB' check (currency = 'THB'),
  reservation_expires_at timestamptz not null,
  public_access_expires_at timestamptz not null default now() + interval '30 minutes',
  extension_used boolean not null default false,
  accepted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (corporation_id, branch_id) references branches(corporation_id, id),
  foreign key (branch_id, table_id) references dining_tables(branch_id, id),
  unique (branch_id, business_date, display_number),
  constraint orders_branch_idempotency_unique unique (branch_id, idempotency_key),
  unique (corporation_id, id)
);

create index orders_branch_queue_idx on orders(branch_id, status, created_at);
create index orders_expiration_idx on orders(status, reservation_expires_at)
  where status = 'pending_payment';

create table order_items (
  id uuid primary key default gen_random_uuid(),
  corporation_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  product_name_th text not null,
  product_name_en text not null,
  size_code text,
  spice_level text,
  quantity integer not null check (quantity > 0),
  unit_price_satang integer not null check (unit_price_satang >= 0),
  line_total_satang integer not null check (line_total_satang >= 0),
  foreign key (corporation_id, order_id) references orders(corporation_id, id),
  foreign key (corporation_id, product_id) references products(corporation_id, id)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) unique,
  provider text not null default 'kbank',
  provider_payment_reference text not null unique,
  provider_transaction_id text unique,
  expected_amount_satang integer not null check (expected_amount_satang >= 0),
  received_amount_satang integer,
  status payment_status not null default 'pending',
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table order_adjustments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  actor_staff_id uuid not null references staff_users(id),
  kind text not null check (kind in ('substitution', 'partial_refund')),
  amount_satang integer not null default 0 check (amount_satang >= 0),
  reason text not null,
  details jsonb not null,
  created_at timestamptz not null default now()
);

create table audit_logs (
  id bigint generated always as identity primary key,
  corporation_id uuid not null references corporations(id),
  branch_id uuid references branches(id),
  actor_staff_id uuid references staff_users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  reason text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now(),
  foreign key (corporation_id, branch_id) references branches(corporation_id, id),
  foreign key (corporation_id, actor_staff_id) references staff_users(corporation_id, id)
);

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  partition_key text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  last_error text
);

create index outbox_unpublished_idx on outbox_events(occurred_at)
  where published_at is null;

-- Public clients never access tables directly. The backend uses a dedicated role
-- and always scopes queries by corporation/branch. RLS remains enabled as defense in depth.
alter table corporations enable row level security;
alter table branches enable row level security;
alter table dining_tables enable row level security;
alter table table_sessions enable row level security;
alter table staff_users enable row level security;
alter table products enable row level security;
alter table branch_menu_items enable row level security;
alter table daily_inventory enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table payments enable row level security;
