-- P2B hardening: reject PostgreSQL NUMERIC special values in business values
-- and make recorded business/security history append-only at the table layer.
-- No currency scale or maximum amount is imposed: the supported range and
-- rounding policy still require an explicit business decision.

DO $finite_numeric_constraints$
DECLARE
  field record;
BEGIN
  FOR field IN
    SELECT * FROM (VALUES
      ('restaurant_tables', 'x'), ('restaurant_tables', 'y'), ('restaurant_tables', 'size_scale'),
      ('products', 'price'), ('ingredients', 'cost_per_unit'), ('ingredients', 'min_stock'),
      ('inventory_balances', 'quantity'),
      ('product_recipe_ingredients', 'quantity'), ('modifiers', 'price'),
      ('modifier_ingredients', 'quantity'), ('orders', 'subtotal'),
      ('order_lines', 'quantity'), ('order_lines', 'unit_price_snapshot'), ('order_lines', 'line_total_snapshot'),
      ('order_line_modifiers', 'unit_price_snapshot'), ('order_line_modifiers', 'quantity'),
      ('preparation_events', 'quantity'), ('inventory_movements', 'quantity_delta'),
      ('inventory_movements', 'stock_before'), ('inventory_movements', 'stock_after'),
      ('cash_sessions', 'opening_amount'), ('cash_sessions', 'expected_amount'),
      ('cash_sessions', 'counted_amount'), ('cash_sessions', 'difference'),
      ('sales', 'subtotal'), ('sales', 'discount'), ('sales', 'net_total'), ('sales', 'tip'),
      ('sales', 'total'), ('sales', 'cash_received'), ('sales', 'cash_change'),
      ('sale_lines', 'quantity'), ('sale_lines', 'unit_price_snapshot'), ('sale_lines', 'line_total_snapshot'),
      ('payment_attempts', 'amount'), ('payments', 'amount'), ('refunds', 'amount'),
      ('sale_adjustments', 'amount_delta'), ('cash_movements', 'amount')
    ) AS numeric_fields(table_name, column_name)
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I::text NOT IN (''NaN'', ''Infinity'', ''-Infinity''))',
      field.table_name,
      field.column_name || '_finite_check',
      field.column_name
    );
  END LOOP;
END
$finite_numeric_constraints$;

CREATE FUNCTION public.reject_immutable_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $reject_immutable_record_mutation$
BEGIN
  RAISE EXCEPTION 'records in table % are append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$reject_immutable_record_mutation$;

DO $append_only_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'security_events', 'order_status_events', 'preparation_events', 'inventory_movements',
    'sales', 'sale_orders', 'sale_lines', 'sale_documents', 'payments', 'refunds',
    'sale_adjustments', 'cash_movements', 'audit_events'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_record_mutation()',
      table_name || '_append_only_guard', table_name
    );
  END LOOP;
END
$append_only_triggers$;

CREATE FUNCTION public.protect_closed_cash_session()
RETURNS trigger
LANGUAGE plpgsql
AS $protect_closed_cash_session$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'closed cash sessions are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$protect_closed_cash_session$;

CREATE TRIGGER cash_sessions_closed_guard
BEFORE UPDATE OR DELETE ON public.cash_sessions
FOR EACH ROW EXECUTE FUNCTION public.protect_closed_cash_session();
