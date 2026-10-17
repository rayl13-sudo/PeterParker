const PREFIX = "pp_map_history_";
const MAX_SAVED = 100;
const MAX_RECENT = 3;

const valid = (entry) => entry && (entry.type === "place" || entry.type === "lot")
  && typeof entry.id === "string" && entry.id.length > 0;
const same = (a, b) => a.type === b.type && a.id === b.id;

export function createMapHistory(userId, storage) {
  const key = `${PREFIX}${userId}`;
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { storage = null; }
  }
  let saved = [];
  let recent = [];
  try {
    const data = JSON.parse(storage?.getItem(key) ?? "null");
    if (Array.isArray(data?.saved)) saved = data.saved.filter(valid).slice(0, MAX_SAVED);
    if (Array.isArray(data?.recent)) recent = data.recent.filter(valid).slice(0, MAX_RECENT);
  } catch {
    // Keep the map working when storage is disabled or contains old data.
  }

  const persist = () => {
    try { storage?.setItem(key, JSON.stringify({ saved, recent })); } catch { /* Session only. */ }
  };

  return {
    saved: () => [...saved],
    recent: () => [...recent],
    isSaved: (entry) => saved.some((item) => same(item, entry)),
    toggleSaved(entry) {
      if (!valid(entry)) return false;
      const wasSaved = saved.some((item) => same(item, entry));
      saved = wasSaved
        ? saved.filter((item) => !same(item, entry))
        : [entry, ...saved].slice(0, MAX_SAVED);
      persist();
      return !wasSaved;
    },
    remember(entry) {
      if (!valid(entry)) return;
      recent = [entry, ...recent.filter((item) => !same(item, entry))].slice(0, MAX_RECENT);
      persist();
    },
  };
}

export function clearMapHistory(userId, storage) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { return; }
  }
  try { storage?.removeItem(`${PREFIX}${userId}`); } catch { /* Best effort. */ }
}
