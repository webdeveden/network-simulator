from tests.conftest import auth_headers

TOPO = {"devices": [], "links": []}


async def test_register_login_me(client):
    headers = await auth_headers(client)
    me = await client.get("/api/auth/me", headers=headers)
    assert me.json()["username"] == "neo"

    dup = await client.post("/api/auth/register", json={"username": "neo", "password": "whatever"})
    assert dup.status_code == 409

    bad = await client.post("/api/auth/login", json={"username": "neo", "password": "wrongpass"})
    assert bad.status_code == 401
    ok = await client.post("/api/auth/login", json={"username": "neo", "password": "matrix123"})
    assert ok.status_code == 200

    assert (await client.get("/api/auth/me")).status_code == 401
    assert (await client.get("/api/auth/me", headers={"Authorization": "Bearer junk"})).status_code == 401


async def test_topology_crud_and_ownership(client):
    h1 = await auth_headers(client, "alice")
    h2 = await auth_headers(client, "bob")

    created = await client.post("/api/topologies", json={"name": "lab", "data": TOPO}, headers=h1)
    assert created.status_code == 201
    tid = created.json()["id"]

    upd = await client.put(f"/api/topologies/{tid}", json={"name": "lab2", "data": TOPO}, headers=h1)
    assert upd.json()["name"] == "lab2"
    assert [t["name"] for t in (await client.get("/api/topologies", headers=h1)).json()] == ["lab2"]

    assert (await client.get(f"/api/topologies/{tid}", headers=h2)).status_code == 404
    assert (await client.delete(f"/api/topologies/{tid}", headers=h2)).status_code == 404
    assert (await client.get("/api/topologies", headers=h2)).json() == []

    assert (await client.delete(f"/api/topologies/{tid}", headers=h1)).status_code == 204
    assert (await client.get("/api/topologies", headers=h1)).json() == []


async def test_missions_and_progress_keeps_best(client):
    missions = (await client.get("/api/missions")).json()
    assert [m["order"] for m in missions] == list(range(1, len(missions) + 1))
    assert (await client.get("/api/missions/nope")).status_code == 404

    h = await auth_headers(client)
    url = "/api/missions/hello-world/complete"
    r = await client.post(url, json={"stars": 3, "time": 90, "cost": 10, "topology": TOPO}, headers=h)
    assert r.status_code == 200
    r = await client.post(url, json={"stars": 1, "time": 40, "cost": 50, "topology": TOPO}, headers=h)
    assert r.json() == {"mission_id": "hello-world", "stars": 3, "best_time": 40, "best_cost": 10}

    progress = (await client.get("/api/progress", headers=h)).json()
    assert len(progress) == 1

    bad = await client.post(url, json={"stars": 5, "time": 1, "cost": 1, "topology": TOPO}, headers=h)
    assert bad.status_code == 422
    assert (await client.post(url, json={"stars": 1, "time": 1, "cost": 1, "topology": TOPO})).status_code == 401
