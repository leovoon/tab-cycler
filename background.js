// Tab Cycler background service worker.
// Watches tab activity and periodically closes tabs that have been inactive
// for longer than the configured timeout — unless the feature is disabled,
// the tab is pinned, it's the active tab, or it is whitelisted.

const DEFAULTS = {
  enabled: true,
  timeoutMinutes: 15,
  checkIntervalMinutes: 2
};

const WHITELIST_KEY = "whitelist"; // [{ id, url, title, addedAt }]
const SETTINGS_KEY = "settings";
const UNDO_KEY = "undoBatch"; // { tabs: [{url,title,windowId,index}], at } | null

let lastActive = new Map(); // tabId -> timestamp (ms) of last activity

// ---------- Settings / whitelist helpers ----------
async function getSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULTS, ...(s || {}) };
}

async function getWhitelist() {
  const { [WHITELIST_KEY]: w } = await chrome.storage.local.get(WHITELIST_KEY);
  return Array.isArray(w) ? w : [];
}

async function isWhitelisted(tabId, url) {
  const list = await getWhitelist();
  return list.some(
    (e) => e.id === tabId || (url && e.url && e.url === url.split("#")[0])
  );
}

// ---------- Activity tracking ----------
function markActive(tabId) {
  if (tabId != null && tabId > 0) lastActive.set(tabId, Date.now());
}

function onTabActivated({ tabId }) {
  markActive(tabId);
}

function onTabUpdated(tabId, changeInfo, tab) {
  // A URL change or a load to complete counts as activity.
  if (changeInfo.url || changeInfo.status === "complete") markActive(tabId);
}

function onTabCreated(tab) {
  if (tab && tab.id != null) markActive(tab.id);
}

function onTabRemoved(tabId) {
  lastActive.delete(tabId);
}

// ---------- The main sweep ----------
async function sweepInactiveTabs() {
  const settings = await getSettings();
  if (!settings.enabled) return;

  const now = Date.now();
  const timeoutMs = settings.timeoutMinutes * 60 * 1000;

  const tabs = await chrome.tabs.query({});
  const activeTabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

  const closed = []; // this sweep's closed tabs, for the undo buffer

  for (const tab of tabs) {
    if (tab.id == null || tab.id < 0) continue;
    if (tab.pinned) continue;                 // never close pinned tabs
    if (tab.active || tab.id === activeTabId) {
      markActive(tab.id);                     // active tab is always "in use"
      continue;
    }

    const last = lastActive.get(tab.id);
    if (last == null) {
      // No recorded activity yet; adopt the tab's own last access time.
      const ref = tab.lastAccessed ? tab.lastAccessed : now;
      lastActive.set(tab.id, ref);
      continue;
    }

    if (now - last < timeoutMs) continue;     // still recent

    if (await isWhitelisted(tab.id, tab.url)) continue;

    try {
      await chrome.tabs.remove(tab.id);
      lastActive.delete(tab.id);
      closed.push({
        url: tab.url || "",
        title: tab.title || "",
        windowId: tab.windowId,
        index: tab.index
      });
    } catch (err) {
      // Tab may have been closed concurrently; ignore.
    }
  }

  // Keep only the single most recent batch for one-click undo.
  if (closed.length) {
    await chrome.storage.local.set({
      [UNDO_KEY]: { tabs: closed, at: Date.now() }
    });
  }
}

// ---------- Init ----------
chrome.tabs.onActivated.addListener(onTabActivated);
chrome.tabs.onUpdated.addListener(onTabUpdated);
chrome.tabs.onCreated.addListener(onTabCreated);
chrome.tabs.onRemoved.addListener(onTabRemoved);

chrome.runtime.onInstalled.addListener(async () => {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  if (!s) await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULTS });
  await ensureAlarm();
});

chrome.runtime.onStartup.addListener(ensureAlarm);

async function ensureAlarm() {
  const settings = await getSettings();
  const period = Math.max(1, settings.checkIntervalMinutes);
  await chrome.alarms.create("tab-cycler-sweep", {
    delayInMinutes: 1,
    periodInMinutes: period
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tab-cycler-sweep") sweepInactiveTabs();
});

// Re-arm the alarm whenever settings change (interval may have changed).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) ensureAlarm();
});

// Seed last-access for tabs that already exist when the worker starts.
chrome.runtime.onStartup.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id != null) markActive(t.id);
});