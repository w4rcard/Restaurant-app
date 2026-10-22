-- Immutable acceptance metadata for a legacy import. It deliberately stores
-- counts and identifiers only; no source payload, credential material, or PII.
CREATE TABLE legacy_import_runs (
  restaurant_id text NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('staging', 'completed')),
  source_state_version integer NOT NULL,
  source_counts jsonb NOT NULL CHECK (jsonb_typeof(source_counts) = 'object'),
  imported_counts jsonb NOT NULL CHECK (jsonb_typeof(imported_counts) = 'object'),
  relationship_counts jsonb NOT NULL CHECK (jsonb_typeof(relationship_counts) = 'object'),
  credential_state_counts jsonb NOT NULL CHECK (jsonb_typeof(credential_state_counts) = 'object'),
  reconciliation jsonb NOT NULL CHECK (jsonb_typeof(reconciliation) = 'object'),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, source_sha256)
);

CREATE TABLE legacy_import_entity_map (
  restaurant_id text NOT NULL,
  import_id text NOT NULL,
  entity_type text NOT NULL CHECK (length(btrim(entity_type)) > 0),
  source_id text NOT NULL,
  target_id text NOT NULL,
  generated boolean NOT NULL DEFAULT false,
  PRIMARY KEY (restaurant_id, import_id, entity_type, source_id),
  FOREIGN KEY (restaurant_id, import_id)
    REFERENCES legacy_import_runs(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (length(source_id) > 0 AND length(target_id) > 0)
);

CREATE FUNCTION public.guard_legacy_import_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $legacy_import_run_transition$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'staging' OR NEW.status <> 'completed'
     OR (to_jsonb(NEW) - 'status' - 'completed_at') <> (to_jsonb(OLD) - 'status' - 'completed_at') THEN
    RAISE EXCEPTION 'legacy import runs only permit staging to completed transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$legacy_import_run_transition$;

CREATE TRIGGER legacy_import_runs_transition_guard
BEFORE UPDATE OR DELETE ON legacy_import_runs
FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_import_run_transition();
CREATE TRIGGER legacy_import_entity_map_immutable_guard
BEFORE UPDATE OR DELETE ON legacy_import_entity_map
FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_record_mutation();
