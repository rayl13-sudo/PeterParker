import test from "node:test";
import assert from "node:assert/strict";
import { createMapHistory, clearMapHistory } from "../js/map-history.mjs";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("recent searches keep the newest three unique selections", () => {
  const store = storage();
  const history = createMapHistory(7, store);
  for (const id of ["a", "b", "c", "d", "b"]) history.remember({ type: "place", id });
  assert.deepEqual(history.recent(), [
    { type: "place", id: "b" },
    { type: "place", id: "d" },
    { type: "place", id: "c" },
  ]);
  assert.deepEqual(createMapHistory(7, store).recent(), history.recent());
});

test("saved places are scoped to an account and removed with it", () => {
  const store = storage();
  const place = { type: "place", id: "way/1" };
  const first = createMapHistory(7, store);
  assert.equal(first.toggleSaved(place), true);
  assert.equal(first.isSaved(place), true);
  assert.deepEqual(createMapHistory(8, store).saved(), []);
  assert.equal(createMapHistory(7, store).toggleSaved(place), false);
  assert.deepEqual(createMapHistory(7, store).saved(), []);
  first.toggleSaved(place);
  clearMapHistory(7, store);
  assert.deepEqual(createMapHistory(7, store).saved(), []);
});

test("bad stored data does not break map history", () => {
  const store = storage();
  store.setItem("pp_map_history_7", "{bad json");
  const history = createMapHistory(7, store);
  assert.deepEqual(history.saved(), []);
  history.remember({ type: "lot", id: "way/2" });
  assert.deepEqual(createMapHistory(7, store).recent(), [{ type: "lot", id: "way/2" }]);
});
