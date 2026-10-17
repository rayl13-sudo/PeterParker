import pytest

from app.moderation import is_username_allowed


@pytest.mark.parametrize(
    "name", ["fuck", "MotherFucker", "sh1t", "b1tch_99", "f_u_c_k", "fuuuuck", "ass", "dick.head", "a55"]
)
def test_blocked(name):
    assert not is_username_allowed(name)


# Innocent names that contain a short blocked word inside them.
@pytest.mark.parametrize(
    "name", ["spidey", "classic", "peacock", "spicy", "raccoon", "grape", "title", "hello", "cucumber"]
)
def test_allowed(name):
    assert is_username_allowed(name)
