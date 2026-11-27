-- Phones and tablets (Moonshine for Android): they only watch, never host, so friends' lists show them
-- apart from PCs ('' = a PC, 'phone' = a phone or tablet).
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT '';
