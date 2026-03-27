let previousTab = null; // Stores the last tab the user was on
let backgroundEnabled = true; // Flag for the auto-grouping feature
let skipCreatedTabGroupingCount = 0; // Counter to skip auto-grouping for a certain number of created tabs
const tabLastUsedAtById = {}; // Tracks when a tab was most recently active, in ms
let tabLastUsedStoreLoaded = false;

function getTabLastUsed(tab, fallbackMs) {
  const explicit = tab?.lastAccessed;
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  return fallbackMs;
}

async function ensureTabLastUsedStoreLoaded() {
  if (tabLastUsedStoreLoaded) {
    return;
  }

  const result = await chrome.storage.local.get({ tabLastUsedAtById: {}, tabCreatedAtById: {} });
  const stored =
    Object.keys(result.tabLastUsedAtById || {}).length > 0
      ? result.tabLastUsedAtById
      : result.tabCreatedAtById || {};

  Object.keys(stored).forEach((tabId) => {
    const lastUsedAt = Number(stored[tabId]);
    if (!Number.isNaN(lastUsedAt) && lastUsedAt > 0) {
      tabLastUsedAtById[tabId] = lastUsedAt;
    }
  });

  tabLastUsedStoreLoaded = true;
  await syncTabLastUsedStoreWithOpenTabs();
}

async function persistTabLastUsedStore() {
  await chrome.storage.local.set({ tabLastUsedAtById });
}

async function markTabAsUsed(tabId) {
  await ensureTabLastUsedStoreLoaded();

  if (!Number.isFinite(tabId)) {
    return;
  }

  tabLastUsedAtById[String(tabId)] = Date.now();
  await persistTabLastUsedStore();
}

async function syncTabLastUsedStoreWithOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const openTabIds = new Set();
  const now = Date.now();
  let changed = false;

  tabs.forEach((tab) => {
    if (tab.id === undefined) {
      return;
    }

    const id = String(tab.id);
    openTabIds.add(id);

    if (!tabLastUsedAtById[id]) {
      tabLastUsedAtById[id] = getTabLastUsed(tab, now);
      changed = true;
    }
  });

  Object.keys(tabLastUsedAtById).forEach((id) => {
    if (!openTabIds.has(id)) {
      delete tabLastUsedAtById[id];
      changed = true;
    }
  });

  if (changed) {
    await persistTabLastUsedStore();
  }
}

async function getTabsSortedByLastUsed() {
  await ensureTabLastUsedStoreLoaded();
  await syncTabLastUsedStoreWithOpenTabs();

  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const groupIds = Array.from(
    new Set(
      tabs
        .map((tab) => tab.groupId)
        .filter((groupId) => groupId !== undefined && groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
    )
  );
  const groupLabelById = {};
  const groupColorById = {};

  await Promise.all(
    groupIds.map(async (groupId) => {
      try {
        const group = await chrome.tabGroups.get(groupId);
        groupLabelById[groupId] = group.title || `Group ${groupId}`;
        groupColorById[groupId] = group.color || 'grey';
      } catch (_) {
        groupLabelById[groupId] = `Group ${groupId}`;
        groupColorById[groupId] = 'grey';
      }
    })
  );

  return tabs
    .filter((tab) => tab.id !== undefined)
    .map((tab) => {
      const id = String(tab.id);
      const lastUsedAt = tabLastUsedAtById[id] || getTabLastUsed(tab, now);
      const groupId = tab.groupId;
      const isUngrouped =
        groupId === undefined || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE;
      const groupLabel = isUngrouped ? 'Ungrouped' : groupLabelById[groupId] || `Group ${groupId}`;
      const groupColor = isUngrouped ? null : groupColorById[groupId] || 'grey';

      return {
        id: tab.id,
        title: tab.title || '(Untitled tab)',
        url: tab.url || '',
        groupId: isUngrouped ? null : groupId,
        groupLabel,
        groupColor,
        lastUsedAt,
        inactiveMs: Math.max(0, now - lastUsedAt)
      };
    })
    .sort((a, b) => b.inactiveMs - a.inactiveMs);
}

async function closeLeastRecentlyUsedTabs(count) {
  if (!Number.isFinite(count) || count <= 0) {
    return { closedCount: 0, requestedCount: 0 };
  }

  const sortedTabs = await getTabsSortedByLastUsed();
  const requestedCount = Math.floor(count);
  const tabsToClose = sortedTabs.slice(0, requestedCount);
  const idsToClose = tabsToClose
    .map((tab) => tab.id)
    .filter((id) => id !== undefined);

  if (idsToClose.length > 0) {
    await chrome.tabs.remove(idsToClose);
  }

  idsToClose.forEach((id) => {
    delete tabLastUsedAtById[String(id)];
  });

  if (idsToClose.length > 0) {
    await persistTabLastUsedStore();
  }

  return {
    closedCount: idsToClose.length,
    requestedCount
  };
}

async function closeTabsInactiveLongerThan(thresholdMs) {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    return { closedCount: 0, thresholdMs: 0 };
  }

  const sortedTabs = await getTabsSortedByLastUsed();
  const tabsToClose = sortedTabs.filter((tab) => tab.inactiveMs > thresholdMs);
  const idsToClose = tabsToClose
    .map((tab) => tab.id)
    .filter((id) => id !== undefined);

  if (idsToClose.length > 0) {
    await chrome.tabs.remove(idsToClose);
  }

  idsToClose.forEach((id) => {
    delete tabLastUsedAtById[String(id)];
  });

  if (idsToClose.length > 0) {
    await persistTabLastUsedStore();
  }

  return {
    closedCount: idsToClose.length,
    thresholdMs
  };
}

async function closeTabById(tabId) {
  if (!Number.isFinite(tabId)) {
    return { closed: false, error: 'Invalid tab id' };
  }

  const parsedTabId = Math.floor(tabId);

  try {
    await chrome.tabs.get(parsedTabId);
  } catch (_) {
    // If the tab vanished between render and click, consider this request satisfied.
    return { closed: true, tabId: parsedTabId, alreadyClosed: true };
  }

  try {
    await chrome.tabs.remove(parsedTabId);
  } catch (error) {
    return { closed: false, error: String(error) };
  }

  const key = String(parsedTabId);
  if (tabLastUsedAtById[key]) {
    delete tabLastUsedAtById[key];
    await persistTabLastUsedStore();
  }

  return { closed: true, tabId: parsedTabId, alreadyClosed: false };
}

async function focusTabById(tabId) {
  if (!Number.isFinite(tabId)) {
    return { focused: false, error: 'Invalid tab id' };
  }

  const parsedTabId = Math.floor(tabId);
  let tab;

  try {
    tab = await chrome.tabs.get(parsedTabId);
  } catch (_) {
    return { focused: false, error: 'Tab not found' };
  }

  try {
    // Activate first; this is the critical step for navigation.
    const updatedTab = await chrome.tabs.update(parsedTabId, { active: true });

    let windowFocused = false;
    let focusWarning = null;
    const targetWindowId = Number.isFinite(updatedTab?.windowId)
      ? updatedTab.windowId
      : tab.windowId;

    if (Number.isFinite(targetWindowId)) {
      try {
        await chrome.windows.update(targetWindowId, { focused: true });
        windowFocused = true;
      } catch (focusError) {
        // Some platforms/states can deny focusing even when tab activation succeeded.
        focusWarning = String(focusError);
      }
    }

    return { focused: true, tabId: parsedTabId, windowFocused, focusWarning };
  } catch (error) {
    return { focused: false, error: String(error) };
  }
}

function consumeSkipCreatedTabGrouping() {
  if (skipCreatedTabGroupingCount <= 0) {
    return false;
  }

  skipCreatedTabGroupingCount -= 1;
  return true;
}

function queueSkipCreatedTabGrouping() {
  skipCreatedTabGroupingCount += 1;
}

async function openTabInSameGroupAsActiveTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || activeTab.id === undefined || activeTab.index === undefined) {
    return;
  }

  // Prevent the generic onCreated auto-grouping path from racing this explicit action.
  queueSkipCreatedTabGrouping();

  const newTab = await chrome.tabs.create({
    windowId: activeTab.windowId,
    index: activeTab.index + 1,
    active: true
  });

  if (
    newTab.id !== undefined &&
    activeTab.groupId !== undefined &&
    activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
  ) {
    await chrome.tabs.group({ tabIds: newTab.id, groupId: activeTab.groupId });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === 'skip-next-created-tab-grouping') {
      queueSkipCreatedTabGrouping();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'get-tabs-by-age') {
      const tabs = await getTabsSortedByLastUsed();
      sendResponse({ ok: true, tabs });
      return;
    }

    if (message?.type === 'get-tabs-by-last-used') {
      const tabs = await getTabsSortedByLastUsed();
      sendResponse({ ok: true, tabs });
      return;
    }

    if (message?.type === 'close-oldest-tabs') {
      const count = Number(message?.count);
      const result = await closeLeastRecentlyUsedTabs(count);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === 'close-least-recently-used-tabs') {
      const count = Number(message?.count);
      const result = await closeLeastRecentlyUsedTabs(count);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === 'close-tabs-inactive-longer-than') {
      const thresholdMs = Number(message?.thresholdMs);
      const result = await closeTabsInactiveLongerThan(thresholdMs);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === 'close-tab-by-id') {
      const tabId = Number(message?.tabId);
      const result = await closeTabById(tabId);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === 'focus-tab-by-id') {
      const tabId = Number(message?.tabId);
      const result = await focusTabById(tabId);
      sendResponse({ ok: true, ...result });
      return;
    }

    sendResponse({ ok: false });
  })().catch((error) => {
    console.error('Runtime message handling failed:', error);
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'open-tab-in-same-group') {
    return;
  }

  openTabInSameGroupAsActiveTab().catch((error) => {
    console.error('Failed to open a tab in the same group:', error);
  });
});

function refreshEnabledState() {
  chrome.storage.sync.get({ enabled: false }, (result) => {
    backgroundEnabled = result.enabled !== false;
    if (!backgroundEnabled) {
      previousTab = null;
    }
  });
}

refreshEnabledState();
ensureTabLastUsedStoreLoaded().catch((error) => {
  console.error('Failed to initialize tab last-used store:', error);
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'sync' || !changes.enabled) {
    return;
  }

  backgroundEnabled = changes.enabled.newValue !== false;
  if (!backgroundEnabled) {
    previousTab = null;
  } else {
    // When re-enabling, cache the currently active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      previousTab = activeTab;
    }
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await markTabAsUsed(tabId);

  if (!backgroundEnabled) {
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  previousTab = tab;
});

chrome.tabs.onCreated.addListener(async (newTab) => {
  await ensureTabLastUsedStoreLoaded();

  if (newTab.id !== undefined) {
    tabLastUsedAtById[String(newTab.id)] = getTabLastUsed(newTab, Date.now());
    await persistTabLastUsedStore();
  }

  if (!backgroundEnabled) {
    return;
  }

  if (consumeSkipCreatedTabGrouping()) {
    return;
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const resolveSourceTab = async () => {
    if (newTab.openerTabId) {
      try {
        return await chrome.tabs.get(newTab.openerTabId);
      } catch (_) {
        // opener tab might no longer exist
      }
    }

    const activeTabs = await chrome.tabs.query({ active: true, windowId: newTab.windowId });
    if (activeTabs && activeTabs.length > 0 && activeTabs[0].id !== newTab.id) {
      return activeTabs[0];
    }

    return previousTab;
  };

  for (let i = 0; i < 6; i++) {
    const sourceTab = await resolveSourceTab();
    const groupId = sourceTab?.groupId;
    if (groupId !== undefined && groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      try {
        await chrome.tabs.group({ tabIds: newTab.id, groupId });
        await chrome.tabs.update(newTab.id, { active: true });
      } catch (_) {
        // Ignore transient errors while tab is still initializing.
      }
      return;
    }
    await delay(40);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureTabLastUsedStoreLoaded();

  const key = String(tabId);
  if (!tabLastUsedAtById[key]) {
    return;
  }

  delete tabLastUsedAtById[key];
  await persistTabLastUsedStore();
});