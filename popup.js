// Auto-Close Tabs popup logic.

const SETTINGS_KEY = "settings";
const WHITELIST_KEY = "whitelist";
const UNDO_KEY = "undoBatch";
const DEFAULTS = { enabled: true, timeoutMinutes: 15, checkIntervalMinutes: 2 };

const enabledEl = document.getElementById("enabled");
const timeoutEl = document.getElementById("timeout");
const addBtn = document.getElementById("add-current");
const listEl = document.getElementById("list");
const undoBtn = document.getElementById("undo");

async function getSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULTS, ...(s || {}) };
}

async function getWhitelist() {
  const { [WHITELIST_KEY]: w } = await chrome.storage.local.get(WHITELIST_KEY);
  return Array.isArray(w) ? w : [];
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function saveWhitelist(list) {
  await chrome.storage.local.set({ [WHITELIST_KEY]: list });
}

function renderList(list) {
  listEl.innerHTML = "";
  if (!list.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No whitelisted tabs";
    listEl.appendChild(div);
    return;
  }
  for (const entry of list) {
    const item = document.createElement("div");
    item.className = "item";

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = sanitize(entry.title || entry.url || "Untitled tab");
    title.title = entry.url || "";

    const remove = document.createElement("button");
    remove.className = "icon-btn";
    remove.textContent = "✕";
    remove.title = "Remove from whitelist";
    remove.addEventListener("click", async () => {
      await saveWhitelist(list.filter((e) => e.id !== entry.id));
      renderList(await getWhitelist());
    });

    item.appendChild(title);
    item.appendChild(remove);
    listEl.appendChild(item);
  }
}

// Prevent HTML injection via tab titles.
function sanitize(text) {
  const el = document.createElement("span");
  el.textContent = text;
  return el.textContent;
}

async function getUndoBatch() {
  const { [UNDO_KEY]: b } = await chrome.storage.local.get(UNDO_KEY);
  return b && Array.isArray(b.tabs) && b.tabs.length ? b : null;
}

async function refreshUndoButton() {
  const batch = await getUndoBatch();
  undoBtn.disabled = !batch;
  undoBtn.title = batch
    ? `Restore ${batch.tabs.length} inactively closed tab${batch.tabs.length === 1 ? "" : "s"}`
    : "Nothing to undo";
}

async function handleUndo() {
  if (undoBtn.disabled) return;
  undoBtn.disabled = true;
  // The restore runs in the service worker: creating tabs can move focus and
  // close this popup mid-loop, which used to truncate the restore to one tab.
  try {
    await chrome.runtime.sendMessage({ type: "restoreUndoBatch" });
  } catch (_) {
    // Worker unavailable; the button state is refreshed below.
  }
  await refreshUndoButton();
}

async function init() {
  const settings = await getSettings();
  enabledEl.checked = settings.enabled;
  timeoutEl.value = settings.timeoutMinutes;

  enabledEl.addEventListener("change", async () => {
    const s = await getSettings();
    s.enabled = enabledEl.checked;
    await saveSettings(s);
  });

  timeoutEl.addEventListener("change", async () => {
    const v = parseInt(timeoutEl.value, 10);
    if (isNaN(v) || v < 1) {
      timeoutEl.value = (await getSettings()).timeoutMinutes;
      return;
    }
    const s = await getSettings();
    s.timeoutMinutes = v;
    await saveSettings(s);
  });

  addBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) return;
    const list = await getWhitelist();
    if (list.some((e) => e.id === tab.id)) return;
    const entry = {
      id: tab.id,
      url: tab.url ? tab.url.split("#")[0] : "",
      title: tab.title || "",
      addedAt: Date.now()
    };
    list.push(entry);
    await saveWhitelist(list);
    renderList(list);
  });

  renderList(await getWhitelist());

  undoBtn.addEventListener("click", handleUndo);
  await refreshUndoButton();
}

init();