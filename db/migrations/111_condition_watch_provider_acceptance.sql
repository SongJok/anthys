-- Provider acceptance without a delivery receipt is its own terminal outcome:
-- it consumes the reservation, retains value dedupe and lets the monitor
-- reschedule. UNKNOWN remains the only state that blocks further sends.
ALTER TABLE public.condition_watch_notifications DROP CONSTRAINT condition_watch_notifications_state_check;
ALTER TABLE public.condition_watch_notifications ADD CONSTRAINT condition_watch_notifications_state_valid
 CHECK(state IN ('PENDING','CONFIRMED','APPLIED_UNVERIFIED','FAILED','UNKNOWN'));
