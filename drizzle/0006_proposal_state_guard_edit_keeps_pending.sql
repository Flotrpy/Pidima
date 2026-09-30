-- Re-issues the guard function after `edit` stopped being a state change (edits append a version instead).
-- (src/approvals/state-machine.ts). Keep the two in sync; tests/state-machine.test.ts checks it.
CREATE OR REPLACE FUNCTION proposal_state_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('DRAFT','PENDING_APPROVAL'),
      ('DRAFT','CANCELED'),
      ('PENDING_APPROVAL','APPROVED'),
      ('PENDING_APPROVAL','PENDING_APPROVAL'),
      ('PENDING_APPROVAL','DENIED'),
      ('PENDING_APPROVAL','CANCELED'),
      ('PENDING_APPROVAL','EXPIRED'),
      ('APPROVED','EXECUTING'),
      ('APPROVED','CANCELED'),
      ('APPROVED','EXPIRED'),
      ('APPROVED','FAILED'),
      ('EXECUTING','SUCCEEDED'),
      ('EXECUTING','FAILED'),
      ('EXECUTING','OUTCOME_UNKNOWN'),
      ('OUTCOME_UNKNOWN','SUCCEEDED'),
      ('OUTCOME_UNKNOWN','FAILED')
    ) AS allowed(from_state, to_state)
    WHERE allowed.from_state = OLD.state::text AND allowed.to_state = NEW.state::text
  ) THEN
    RAISE EXCEPTION 'illegal proposal transition % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
