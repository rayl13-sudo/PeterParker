-- Which Terms of Service version each account accepted at sign-up, and when.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS terms_version TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
