-- Custom migration: trigram search for the FDC food cache (used from M2).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
