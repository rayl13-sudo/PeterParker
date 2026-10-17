SIGNUP = {"username": "milesm", "email": "miles@example.com", "password": "Spider-Verse1"}


def signup(client, **overrides):
    res = client.post("/api/auth/signup", json={**SIGNUP, **overrides})
    assert res.status_code == 201, res.json()
    return {"Authorization": f"Bearer {res.json()['token']}"}


def login(client, identifier, password):
    return client.post("/api/auth/login", json={"identifier": identifier, "password": password})


def test_update_username(client):
    headers = signup(client)
    res = client.patch(
        "/api/auth/me",
        json={"username": "Miles#42", "current_password": SIGNUP["password"]},
        headers=headers,
    )
    assert res.status_code == 200, res.json()
    assert res.json()["username"] == "miles#42" and res.json()["email"] == SIGNUP["email"]
    assert client.get("/api/auth/me", headers=headers).json()["username"] == "miles#42"
    assert login(client, "miles#42", SIGNUP["password"]).status_code == 200
    assert login(client, "milesm", SIGNUP["password"]).status_code == 401


def test_update_requires_current_password(client):
    headers = signup(client)
    res = client.patch("/api/auth/me", json={"username": "newname", "current_password": "nope"}, headers=headers)
    assert res.status_code == 400  # not 401, which would sign the user out
    assert client.get("/api/auth/me", headers=headers).status_code == 200


def test_update_rejects_taken_and_email_changes(client):
    headers = signup(client)
    signup(client, username="gwen", email="gwen@example.com")
    taken = client.patch(
        "/api/auth/me", json={"username": "gwen", "current_password": SIGNUP["password"]}, headers=headers
    )
    assert taken.status_code == 409 and "username" in taken.json()["detail"]
    email_change = client.patch(
        "/api/auth/me", json={"email": "other@example.com", "current_password": SIGNUP["password"]}, headers=headers
    )
    assert email_change.status_code == 422
    assert client.get("/api/auth/me", headers=headers).json()["email"] == SIGNUP["email"]


def test_change_password_signs_out_other_devices(client):
    headers = signup(client)
    other_device = {"Authorization": f"Bearer {login(client, 'milesm', SIGNUP['password']).json()['token']}"}

    weak = client.post(
        "/api/auth/password", json={"current_password": SIGNUP["password"], "new_password": "weak"}, headers=headers
    )
    assert weak.status_code == 422
    wrong = client.post(
        "/api/auth/password", json={"current_password": "nope", "new_password": "Brand-New1"}, headers=headers
    )
    assert wrong.status_code == 400

    ok = client.post(
        "/api/auth/password",
        json={"current_password": SIGNUP["password"], "new_password": "Brand-New1"},
        headers=headers,
    )
    assert ok.status_code == 204
    assert client.get("/api/auth/me", headers=headers).status_code == 200
    assert client.get("/api/auth/me", headers=other_device).status_code == 401
    assert login(client, "milesm", "Brand-New1").status_code == 200
    assert login(client, "milesm", SIGNUP["password"]).status_code == 401


TINY_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def test_new_accounts_get_random_two_color_avatar(client):
    first = client.get("/api/auth/me", headers=signup(client)).json()["avatar"]
    second = client.get(
        "/api/auth/me", headers=signup(client, username="gwen", email="gwen@example.com")
    ).json()["avatar"]
    for avatar in (first, second):
        assert avatar["image"] is None
        assert avatar["bg"].startswith("#") and avatar["fg"].startswith("#")
        assert avatar["bg"] != avatar["fg"]
    assert (first["bg"], first["fg"]) != (second["bg"], second["fg"])


def test_avatar_colors_stay_until_shuffled(client):
    headers = signup(client)
    before = client.get("/api/auth/me", headers=headers).json()["avatar"]
    assert client.get("/api/auth/me", headers=headers).json()["avatar"] == before
    after = client.post("/api/auth/me/avatar/colors", headers=headers).json()["avatar"]
    assert (after["bg"], after["fg"]) != (before["bg"], before["fg"])


def test_upload_and_remove_profile_picture(client):
    headers = signup(client)
    res = client.put("/api/auth/me/avatar", json={"image": TINY_PNG}, headers=headers)
    assert res.status_code == 200 and res.json()["avatar"]["image"] == TINY_PNG
    assert client.get("/api/auth/me", headers=headers).json()["avatar"]["image"] == TINY_PNG

    res = client.delete("/api/auth/me/avatar", headers=headers)
    assert res.status_code == 200 and res.json()["avatar"]["image"] is None


def test_rejects_bad_profile_pictures(client):
    headers = signup(client)
    for bad in [
        "https://example.com/me.png",
        "data:text/html;base64,PHNjcmlwdD4=",
        "data:image/svg+xml;base64,PHN2Zz4=",  # SVG can carry scripts
        "data:image/png;base64,not base64!",
        "data:image/png;base64," + "A" * 400_000,
    ]:
        assert client.put("/api/auth/me/avatar", json={"image": bad}, headers=headers).status_code == 422


def test_random_colors_are_far_apart():
    import colorsys
    import random

    from app.avatar import random_colors

    rng = random.Random(1)
    for _ in range(200):
        bg, fg = random_colors(rng)
        hue = lambda h: colorsys.rgb_to_hls(*(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)))[0] * 360
        gap = abs(hue(bg) - hue(fg)) % 360
        assert min(gap, 360 - gap) >= 115  # different color, not a shade of the same one
