-- Release 5 (T109): how long a supplier takes to deliver, for forecast-based reordering.
ALTER TABLE suppliers ADD COLUMN lead_time_days integer NOT NULL DEFAULT 7 CHECK (lead_time_days BETWEEN 0 AND 365);
