-- Profile pictures: random default colors and an optional uploaded photo (data URL).
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_bg TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_fg TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_image TEXT;
