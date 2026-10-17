CREATE TABLE IF NOT EXISTS review_likes (
    review_id BIGINT NOT NULL REFERENCES public.reviews(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    PRIMARY KEY (review_id, user_id)
);
ALTER TABLE review_likes ENABLE ROW LEVEL SECURITY;
