ALTER TABLE allocations ADD COLUMN recovers_allocation_id TEXT REFERENCES allocations(allocation_id);

CREATE INDEX allocations_recovers_idx ON allocations(recovers_allocation_id);
CREATE INDEX allocations_purpose_idx ON allocations(purpose);
