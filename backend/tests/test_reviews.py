import json

import pytest

from app.api.routes.navigation import PLACES_FILE

MPS = "way/171169301"  # Mesa Parking Structure


@pytest.fixture
def langson():
    places = json.loads(PLACES_FILE.read_text())["places"]
    return next(p["id"] for p in places if p["name"] == "Langson Library")


def other_user(client, name="gwen"):
    res = client.post(
        "/api/auth/signup",
        json={"username": name, "email": f"{name}@example.com", "password": "Spider-Verse1"},
    )
    return {"Authorization": f"Bearer {res.json()['token']}"}


def review(client, headers, rating, comment="", target_type="lot", target_id=MPS):
    return client.put(
        "/api/reviews",
        json={"target_type": target_type, "target_id": target_id, "rating": rating, "comment": comment},
        headers=headers,
    )


def test_reviews_require_sign_in(client):
    assert client.get("/api/reviews", params={"target_type": "lot", "target_id": MPS}).status_code == 401
    assert client.get("/api/reviews/summary").status_code == 401


def test_post_list_and_average(client, auth_headers):
    res = review(client, auth_headers, 4, "  Easy to find a spot after 10am.  ")
    assert res.status_code == 200, res.json()
    body = res.json()
    assert body["count"] == 1 and body["average"] == 4
    mine = body["reviews"][0]
    assert mine["mine"] and mine["comment"] == "Easy to find a spot after 10am."
    assert mine["author"]["username"] == "peter" and mine["author"]["avatar"]["bg"].startswith("#")

    review(client, other_user(client), 1, "Full by 9.")
    body = client.get("/api/reviews", params={"target_type": "lot", "target_id": MPS}, headers=auth_headers).json()
    assert body["count"] == 2 and body["average"] == 2.5
    assert body["reviews"][0]["mine"]  # your own review is listed first
    assert client.get("/api/reviews/summary", headers=auth_headers).json() == {f"lot:{MPS}": {"average": 2.5, "count": 2}}


def test_one_review_per_person_is_updated(client, auth_headers):
    review(client, auth_headers, 2, "meh")
    body = review(client, auth_headers, 5, "Changed my mind").json()
    assert body["count"] == 1 and body["reviews"][0]["rating"] == 5
    assert body["reviews"][0]["comment"] == "Changed my mind"


def test_places_can_be_reviewed(client, auth_headers, langson):
    res = review(client, auth_headers, 5, "Quiet floors upstairs", target_type="place", target_id=langson)
    assert res.status_code == 200 and res.json()["target_type"] == "place"
    summary = client.get("/api/reviews/summary", headers=auth_headers).json()
    assert summary[f"place:{langson}"]["count"] == 1


def test_delete_only_your_own(client, auth_headers):
    review_id = review(client, auth_headers, 3).json()["reviews"][0]["id"]
    assert client.delete(f"/api/reviews/{review_id}", headers=other_user(client)).status_code == 404
    assert client.delete(f"/api/reviews/{review_id}", headers=auth_headers).status_code == 204
    body = client.get("/api/reviews", params={"target_type": "lot", "target_id": MPS}, headers=auth_headers).json()
    assert body["count"] == 0 and body["average"] is None


def test_rejects_bad_reviews(client, auth_headers):
    assert review(client, auth_headers, 0).status_code == 422
    assert review(client, auth_headers, 6).status_code == 422
    assert review(client, auth_headers, 4, "x" * 1001).status_code == 422
    assert review(client, auth_headers, 4, target_id="way/0").status_code == 404
    assert review(client, auth_headers, 4, target_type="planet").status_code == 422


def test_comment_is_stored_as_plain_text(client, auth_headers):
    body = review(client, auth_headers, 4, "<script>alert(1)</script>").json()
    assert body["reviews"][0]["comment"] == "<script>alert(1)</script>"  # escaped when shown, never run


def reply(client, headers, review_id, comment):
    return client.post(f"/api/reviews/{review_id}/replies", json={"comment": comment}, headers=headers)


def test_reply_to_a_review(client, auth_headers):
    review_id = review(client, auth_headers, 2, "Always full").json()["reviews"][0]["id"]
    gwen = other_user(client)
    res = reply(client, gwen, review_id, "  Try after 2pm, it clears out.  ")
    assert res.status_code == 201, res.json()
    replies = res.json()["reviews"][0]["replies"]
    assert [(r["comment"], r["author"]["username"], r["mine"]) for r in replies] == [
        ("Try after 2pm, it clears out.", "gwen", True)
    ]
    reply(client, auth_headers, review_id, "Thanks, will do")
    listed = client.get("/api/reviews", params={"target_type": "lot", "target_id": MPS}, headers=auth_headers).json()
    assert [r["comment"] for r in listed["reviews"][0]["replies"]] == ["Try after 2pm, it clears out.", "Thanks, will do"]
    assert [r["mine"] for r in listed["reviews"][0]["replies"]] == [False, True]
    # Replies don't count toward the rating.
    assert listed["count"] == 1 and listed["average"] == 2


def test_delete_own_reply_only(client, auth_headers):
    review_id = review(client, auth_headers, 4).json()["reviews"][0]["id"]
    gwen = other_user(client)
    reply_id = reply(client, gwen, review_id, "Agreed").json()["reviews"][0]["replies"][0]["id"]
    assert client.delete(f"/api/reviews/replies/{reply_id}", headers=auth_headers).status_code == 404
    assert client.delete(f"/api/reviews/replies/{reply_id}", headers=gwen).status_code == 204
    listed = client.get("/api/reviews", params={"target_type": "lot", "target_id": MPS}, headers=gwen).json()
    assert listed["reviews"][0]["replies"] == []


def test_deleting_a_review_removes_its_replies(client, auth_headers):
    review_id = review(client, auth_headers, 3).json()["reviews"][0]["id"]
    reply(client, other_user(client), review_id, "Hmm")
    assert client.delete(f"/api/reviews/{review_id}", headers=auth_headers).status_code == 204
    # Re-reviewing starts fresh, without the old thread.
    body = review(client, auth_headers, 5).json()
    assert body["reviews"][0]["replies"] == []


def test_rejects_bad_replies(client, auth_headers):
    review_id = review(client, auth_headers, 3).json()["reviews"][0]["id"]
    assert reply(client, auth_headers, review_id, "   ").status_code == 422
    assert reply(client, auth_headers, review_id, "x" * 501).status_code == 422
    assert reply(client, auth_headers, 999999, "hello").status_code == 404
    assert client.post(f"/api/reviews/{review_id}/replies", json={"comment": "hi"}).status_code == 401
