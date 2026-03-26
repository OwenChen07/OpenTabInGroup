let previousTab = null; // Stores the last tab the user was on
let backgroundEnabled = true; // Flag for the auto-grouping feature
let skipCreatedTabGroupingCount = 0; // Counter to skip auto-grouping for a certain number of created tabs

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
  if (message?.type === 'skip-next-created-tab-grouping') {
    queueSkipCreatedTabGrouping();
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false });
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
  chrome.storage.sync.get({ enabled: true }, (result) => {
    backgroundEnabled = result.enabled !== false;
    if (!backgroundEnabled) {
      previousTab = null;
    }
  });
}

refreshEnabledState();

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
  if (!backgroundEnabled) {
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  previousTab = tab;
});

chrome.tabs.onCreated.addListener(async (newTab) => {
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