UPDATE runs SET budget=jsonb_build_object('schemaVersion',1)||budget WHERE jsonb_typeof(budget)='object' AND NOT budget?'schemaVersion';
CREATE FUNCTION public.oa_runtime_budget_valid(value_arg jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE field_arg text; amount numeric;
BEGIN
 IF jsonb_typeof(value_arg) IS DISTINCT FROM 'object' OR (value_arg->'schemaVersion') IS DISTINCT FROM '1'::jsonb THEN RETURN false;END IF;
 IF value_arg-ARRAY['schemaVersion','maxTurns','maxTools','maxActiveMs']<>'{}'::jsonb THEN RETURN false;END IF;
 FOREACH field_arg IN ARRAY ARRAY['maxTurns','maxTools','maxActiveMs'] LOOP
  IF jsonb_typeof(value_arg->field_arg) IS DISTINCT FROM 'number' THEN RETURN false;END IF;
  amount:=(value_arg->>field_arg)::numeric;
  IF amount<>trunc(amount) OR amount<0 THEN RETURN false;END IF;
  IF field_arg='maxTurns' AND amount>64 OR field_arg='maxTools' AND amount>120 OR field_arg='maxActiveMs' AND (amount<1 OR amount>1800000) THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END;$$;
REVOKE ALL ON FUNCTION public.oa_runtime_budget_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_runtime_budget_valid(jsonb) TO oa_runtime,oa_app;
