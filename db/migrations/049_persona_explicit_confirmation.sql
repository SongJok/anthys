-- A bare scope message cannot prove which original proposal it refers to.
ALTER TABLE persona_control_responses DROP CONSTRAINT persona_control_responses_outcome_check;
ALTER TABLE persona_control_responses ADD CHECK(outcome IN ('SAVED','VIEW','HELP','CLARIFY','DENIED','CONFLICT','LOCKED','UNAVAILABLE','AMBIGUOUS','CANCELLED','EXPIRED','NOT_FOUND','CONFIRM_REQUIRED'));
