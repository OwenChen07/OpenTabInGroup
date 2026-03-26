const openTabButton = document.getElementById('openTab');
const toggle = document.getElementById('toggle');
const status = document.getElementById('status');

function setStatus(text) {
  if (status) {
    status.textContent = text;
  }
}

if (toggle) {
  chrome.storage.sync.get({ enabled: true }, (result) => {
    const isEnabled = result.enabled !== false;
    toggle.checked = isEnabled;
    setStatus(isEnabled ? 'Background service is ON' : 'Background service is OFF');
  });

  toggle.addEventListener('change', () => {
    chrome.storage.sync.set({ enabled: toggle.checked }, () => {
      setStatus(toggle.checked ? 'Background service is ON' : 'Background service is OFF');
    });
  });
}

if (openTabButton) {
  openTabButton.addEventListener('click', async () => {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) {
        throw new Error('No active tab found in the current window.');
      }

      const newTab = await chrome.tabs.create({ active: true });

      if (activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await chrome.tabs.group({
          tabIds: newTab.id,
          groupId: activeTab.groupId
        });
      }

      window.close();
    } catch (error) {
      console.error('Failed to open and group tab:', error);
      setStatus('Failed to open tab. See extension console.');
    }
  });
}