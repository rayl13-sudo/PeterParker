-- The UCI parking permit a user holds (e.g. 'S4', 'R-ME'), so the map can show where it's valid.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS permit TEXT;
