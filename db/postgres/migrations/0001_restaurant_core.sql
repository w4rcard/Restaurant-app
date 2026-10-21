-- PostgreSQL schema foundation. All IDs remain text so a later importer can
-- preserve legacy identifiers without assuming UUID or numeric formats.
-- Currency amounts use unconstrained NUMERIC: V9 permits COP/USD and stores
-- JS numbers; no universal minor-unit/exponent conversion has been verified.

CREATE TABLE restaurants (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  currency_code text NOT NULL CHECK (currency_code IN ('COP', 'USD')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  role text NOT NULL CHECK (role IN ('Administrador', 'Mesero', 'Cocina', 'Caja')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id)
);

-- Keep Phase 2B credential lifecycle values. reset_required has no verifier;
-- active and must_change require a valid scrypt-v1 verifier.
CREATE TABLE employee_credentials (
  restaurant_id text NOT NULL,
  employee_id text NOT NULL,
  scheme text,
  salt bytea,
  password_hash bytea,
  credential_state text NOT NULL CHECK (credential_state IN ('active', 'must_change', 'reset_required')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, employee_id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (
    (credential_state = 'reset_required' AND scheme IS NULL AND salt IS NULL AND password_hash IS NULL)
    OR
    (credential_state IN ('active', 'must_change') AND scheme = 'scrypt-v1'
      AND salt IS NOT NULL AND password_hash IS NOT NULL
      AND octet_length(salt) = 16 AND octet_length(password_hash) = 32)
  )
);

CREATE TABLE employee_sessions (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  employee_id text NOT NULL,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (token_hash),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX employee_sessions_active_expiry_idx ON employee_sessions (restaurant_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE login_attempts (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  subject_key_hash bytea NOT NULL CHECK (octet_length(subject_key_hash) = 32),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  succeeded boolean NOT NULL,
  PRIMARY KEY (restaurant_id, id)
);
CREATE INDEX login_attempts_subject_time_idx ON login_attempts (restaurant_id, subject_key_hash, attempted_at DESC);

CREATE TABLE security_events (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  employee_id text,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX security_events_time_idx ON security_events (restaurant_id, occurred_at DESC);

CREATE TABLE restaurant_tables (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  shape text NOT NULL CHECK (shape IN ('round', 'wide', 'square', 'oval', 'large')),
  x numeric NOT NULL,
  y numeric NOT NULL,
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 12),
  size_scale numeric NOT NULL DEFAULT 1 CHECK (size_scale > 0),
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, name)
);

-- V9 represents merged tables as reciprocal joinedWith IDs, not persistent
-- group entities. This normalized relation can represent the same membership.
CREATE TABLE table_groups (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id)
);
CREATE TABLE table_group_members (
  restaurant_id text NOT NULL,
  group_id text NOT NULL,
  table_id text NOT NULL,
  PRIMARY KEY (restaurant_id, group_id, table_id),
  FOREIGN KEY (restaurant_id, group_id) REFERENCES table_groups(restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, table_id) REFERENCES restaurant_tables(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX table_group_members_table_idx ON table_group_members (restaurant_id, table_id);

CREATE TABLE customers (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  phone text,
  email text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id)
);
CREATE INDEX customers_name_idx ON customers (restaurant_id, lower(name));
CREATE INDEX customers_phone_idx ON customers (restaurant_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE reservations (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  customer_id text,
  customer_name_snapshot text NOT NULL,
  table_id text,
  reserved_for timestamptz NOT NULL,
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 40),
  status text NOT NULL CHECK (status IN ('pendiente', 'confirmada', 'atendida', 'cancelada')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, table_id) REFERENCES restaurant_tables(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX reservations_schedule_idx ON reservations (restaurant_id, reserved_for, status);

CREATE TABLE categories (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, name)
);
CREATE TABLE products (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  category_id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text NOT NULL DEFAULT '',
  price numeric NOT NULL CHECK (price >= 0),
  active boolean NOT NULL DEFAULT true,
  image text NOT NULL DEFAULT '',
  estimated_prep_seconds integer NOT NULL CHECK (estimated_prep_seconds >= 0),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, category_id) REFERENCES categories(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX products_category_active_idx ON products (restaurant_id, category_id, active, name);

CREATE TABLE modifier_categories (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, name)
);
CREATE TABLE ingredient_categories (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, name)
);
CREATE TABLE ingredients (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  category_id text,
  category_name_snapshot text NOT NULL DEFAULT '',
  stock_unit text NOT NULL CHECK (stock_unit IN ('g', 'kg', 'ml', 'L', 'unidad')),
  cost_per_unit numeric NOT NULL DEFAULT 0 CHECK (cost_per_unit >= 0),
  min_stock numeric NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, category_id) REFERENCES ingredient_categories(restaurant_id, id) ON DELETE RESTRICT
);
CREATE TABLE inventory_balances (
  restaurant_id text NOT NULL,
  ingredient_id text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, ingredient_id),
  FOREIGN KEY (restaurant_id, ingredient_id) REFERENCES ingredients(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE product_recipe_versions (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  product_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, product_id, version),
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, created_by) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT
);
CREATE TABLE product_recipe_ingredients (
  restaurant_id text NOT NULL,
  recipe_version_id text NOT NULL,
  ingredient_id text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit text NOT NULL CHECK (unit IN ('g', 'kg', 'ml', 'L', 'unidad')),
  PRIMARY KEY (restaurant_id, recipe_version_id, ingredient_id),
  FOREIGN KEY (restaurant_id, recipe_version_id) REFERENCES product_recipe_versions(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, ingredient_id) REFERENCES ingredients(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE modifiers (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  category_id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  price numeric NOT NULL CHECK (price >= 0),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, category_id) REFERENCES modifier_categories(restaurant_id, id) ON DELETE RESTRICT
);
CREATE TABLE modifier_ingredients (
  restaurant_id text NOT NULL,
  modifier_id text NOT NULL,
  ingredient_id text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit text NOT NULL CHECK (unit IN ('g', 'kg', 'ml', 'L', 'unidad')),
  PRIMARY KEY (restaurant_id, modifier_id, ingredient_id),
  FOREIGN KEY (restaurant_id, modifier_id) REFERENCES modifiers(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, ingredient_id) REFERENCES ingredients(restaurant_id, id) ON DELETE RESTRICT
);
CREATE TABLE product_modifiers (
  restaurant_id text NOT NULL,
  product_id text NOT NULL,
  modifier_id text NOT NULL,
  PRIMARY KEY (restaurant_id, product_id, modifier_id),
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, modifier_id) REFERENCES modifiers(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE orders (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  order_number bigint NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('mesa', 'pickup', 'delivery')),
  status text NOT NULL CHECK (status IN ('PENDIENTE', 'PREPARANDO', 'LISTO', 'ENTREGADO', 'CANCELADO')),
  table_id text,
  table_name_snapshot text NOT NULL,
  customer_id text,
  reservation_id text,
  delivery_address text NOT NULL DEFAULT '',
  source_order_id text,
  employee_id text,
  subtotal numeric NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  sent_to_kitchen_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, order_number),
  FOREIGN KEY (restaurant_id, table_id) REFERENCES restaurant_tables(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, reservation_id) REFERENCES reservations(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, source_order_id) REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX orders_active_queue_idx ON orders (restaurant_id, status, created_at)
  WHERE status IN ('PENDIENTE', 'PREPARANDO', 'LISTO');
CREATE INDEX orders_table_history_idx ON orders (restaurant_id, table_id, created_at DESC);
CREATE INDEX orders_customer_history_idx ON orders (restaurant_id, customer_id, created_at DESC) WHERE customer_id IS NOT NULL;

CREATE TABLE order_lines (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  order_id text NOT NULL,
  product_id text,
  product_name_snapshot text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit_price_snapshot numeric NOT NULL CHECK (unit_price_snapshot >= 0),
  line_total_snapshot numeric NOT NULL CHECK (line_total_snapshot >= 0),
  recipe_version_id text,
  removed_ingredients jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(removed_ingredients) = 'array'),
  note text NOT NULL DEFAULT '',
  estimated_prep_seconds integer NOT NULL DEFAULT 0 CHECK (estimated_prep_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, order_id) REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, product_id) REFERENCES products(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, recipe_version_id) REFERENCES product_recipe_versions(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX order_lines_order_idx ON order_lines (restaurant_id, order_id);
CREATE TABLE order_line_modifiers (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  order_line_id text NOT NULL,
  modifier_id text,
  name_snapshot text NOT NULL,
  unit_price_snapshot numeric NOT NULL CHECK (unit_price_snapshot >= 0),
  quantity numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, order_line_id) REFERENCES order_lines(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, modifier_id) REFERENCES modifiers(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX order_line_modifiers_line_idx ON order_line_modifiers (restaurant_id, order_line_id);

CREATE TABLE order_status_events (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  order_id text NOT NULL,
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('PENDIENTE', 'PREPARANDO', 'LISTO', 'ENTREGADO', 'CANCELADO')),
  employee_id text,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, order_id) REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX order_status_events_order_time_idx ON order_status_events (restaurant_id, order_id, occurred_at);
CREATE TABLE preparation_events (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  order_line_id text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  event_type text NOT NULL CHECK (event_type IN ('started', 'ready', 'delivered', 'cancelled')),
  employee_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, order_line_id) REFERENCES order_lines(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX preparation_events_line_time_idx ON preparation_events (restaurant_id, order_line_id, occurred_at);

CREATE TABLE inventory_movements (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  ingredient_id text NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('purchase', 'adjustment', 'sale')),
  quantity_delta numeric NOT NULL CHECK (quantity_delta <> 0),
  unit text NOT NULL CHECK (unit IN ('g', 'kg', 'ml', 'L', 'unidad')),
  stock_before numeric,
  stock_after numeric CHECK (stock_after IS NULL OR stock_after >= 0),
  sale_id text,
  employee_id text,
  reason text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, ingredient_id) REFERENCES ingredients(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (stock_before IS NULL OR stock_after IS NULL OR stock_after = stock_before + quantity_delta)
);
CREATE INDEX inventory_movements_ingredient_time_idx ON inventory_movements (restaurant_id, ingredient_id, occurred_at DESC);
CREATE INDEX inventory_movements_sale_idx ON inventory_movements (restaurant_id, sale_id) WHERE sale_id IS NOT NULL;

CREATE TABLE cash_sessions (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  opened_by text NOT NULL,
  opened_at timestamptz NOT NULL,
  opening_amount numeric NOT NULL CHECK (opening_amount >= 0),
  closed_by text,
  closed_at timestamptz,
  expected_amount numeric CHECK (expected_amount IS NULL OR expected_amount >= 0),
  counted_amount numeric CHECK (counted_amount IS NULL OR counted_amount >= 0),
  difference numeric,
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, opened_by) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, closed_by) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT,
  CHECK ((closed_at IS NULL AND closed_by IS NULL AND expected_amount IS NULL AND counted_amount IS NULL AND difference IS NULL)
      OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND expected_amount IS NOT NULL AND counted_amount IS NOT NULL
        AND difference IS NOT NULL AND difference = counted_amount - expected_amount))
);
CREATE UNIQUE INDEX cash_sessions_one_open_idx ON cash_sessions (restaurant_id) WHERE closed_at IS NULL;
CREATE INDEX cash_sessions_history_idx ON cash_sessions (restaurant_id, opened_at DESC);

CREATE TABLE sales (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  currency_code text NOT NULL CHECK (currency_code IN ('COP', 'USD')),
  subtotal numeric NOT NULL CHECK (subtotal >= 0),
  discount numeric NOT NULL CHECK (discount >= 0),
  net_total numeric NOT NULL CHECK (net_total >= 0),
  tip numeric NOT NULL CHECK (tip >= 0),
  total numeric NOT NULL CHECK (total >= 0),
  payment_method text NOT NULL,
  people integer NOT NULL CHECK (people > 0),
  employee_id text,
  table_id text,
  table_name_snapshot text NOT NULL DEFAULT '',
  customer_id text,
  reservation_id text,
  order_type text NOT NULL CHECK (order_type IN ('mesa', 'pickup', 'delivery')),
  cash_received numeric NOT NULL DEFAULT 0 CHECK (cash_received >= 0),
  cash_change numeric NOT NULL DEFAULT 0 CHECK (cash_change >= 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, table_id) REFERENCES restaurant_tables(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, reservation_id) REFERENCES reservations(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (discount <= subtotal AND net_total = subtotal - discount AND total = net_total + tip)
);
CREATE INDEX sales_time_idx ON sales (restaurant_id, created_at DESC);
CREATE INDEX sales_employee_time_idx ON sales (restaurant_id, employee_id, created_at DESC);
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_sale_fk
  FOREIGN KEY (restaurant_id, sale_id) REFERENCES sales(restaurant_id, id) ON DELETE RESTRICT;
CREATE TABLE sale_orders (
  restaurant_id text NOT NULL,
  sale_id text NOT NULL,
  order_id text NOT NULL,
  PRIMARY KEY (restaurant_id, sale_id, order_id),
  UNIQUE (restaurant_id, order_id),
  FOREIGN KEY (restaurant_id, sale_id) REFERENCES sales(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, order_id) REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT
);
CREATE TABLE sale_lines (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  sale_id text NOT NULL,
  order_line_id text,
  product_name_snapshot text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit_price_snapshot numeric NOT NULL CHECK (unit_price_snapshot >= 0),
  line_total_snapshot numeric NOT NULL CHECK (line_total_snapshot >= 0),
  modifiers_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(modifiers_snapshot) = 'array'),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, sale_id) REFERENCES sales(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, order_line_id) REFERENCES order_lines(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX sale_lines_sale_idx ON sale_lines (restaurant_id, sale_id);
CREATE TABLE sale_documents (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  sale_id text NOT NULL,
  document_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, sale_id) REFERENCES sales(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX sale_documents_sale_idx ON sale_documents (restaurant_id, sale_id, created_at);

CREATE TABLE payment_attempts (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  sale_id text NOT NULL,
  payment_method text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  employee_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, sale_id) REFERENCES sales(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'pending' AND completed_at IS NULL) OR (status <> 'pending' AND completed_at IS NOT NULL))
);
CREATE INDEX payment_attempts_sale_time_idx ON payment_attempts (restaurant_id, sale_id, created_at);
CREATE TABLE payments (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  sale_id text NOT NULL,
  attempt_id text,
  payment_method text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  employee_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, attempt_id),
  FOREIGN KEY (restaurant_id, sale_id) REFERENCES sales(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, attempt_id) REFERENCES payment_attempts(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX payments_sale_idx ON payments (restaurant_id, sale_id);
CREATE TABLE refunds (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  sale_id text NOT NULL,
  payment_id text,
  amount numeric NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  employee_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, sale_id) REFERENCES sales(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, payment_id) REFERENCES payments(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX refunds_sale_time_idx ON refunds (restaurant_id, sale_id, recorded_at);
CREATE TABLE sale_adjustments (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  sale_id text NOT NULL,
  amount_delta numeric NOT NULL CHECK (amount_delta <> 0),
  reason text NOT NULL,
  employee_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, sale_id) REFERENCES sales(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX sale_adjustments_sale_time_idx ON sale_adjustments (restaurant_id, sale_id, recorded_at);

CREATE TABLE cash_movements (
  restaurant_id text NOT NULL,
  id text NOT NULL,
  cash_session_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('income', 'expense')),
  amount numeric NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  payment_method text NOT NULL,
  sale_id text,
  employee_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, cash_session_id) REFERENCES cash_sessions(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, sale_id) REFERENCES sales(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX cash_movements_session_time_idx ON cash_movements (restaurant_id, cash_session_id, occurred_at);

CREATE TABLE idempotency_records (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (restaurant_id, scope, idempotency_key),
  CHECK (expires_at > created_at),
  CHECK ((status = 'completed' AND response IS NOT NULL) OR status <> 'completed')
);
CREATE INDEX idempotency_expiry_idx ON idempotency_records (expires_at);

CREATE TABLE entity_revisions (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, entity_type, entity_id)
);

CREATE TABLE audit_events (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  employee_id text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees(restaurant_id, id) ON DELETE RESTRICT
);
CREATE INDEX audit_events_entity_time_idx ON audit_events (restaurant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_events_time_idx ON audit_events (restaurant_id, occurred_at DESC);

CREATE TABLE outbox_events (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  PRIMARY KEY (restaurant_id, id)
);
CREATE INDEX outbox_pending_idx ON outbox_events (created_at) WHERE published_at IS NULL;

-- The schema stores immutable snapshots/ledgers, but append-only enforcement
-- is intentionally a database-role/application grant policy in a later phase.
