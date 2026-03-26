const openTabButton = document.getElementById('openTab');
const editShortcutButton = document.getElementById('editShortcut');
const toggle = document.getElementById('toggle');
const status = document.getElementById('status');

function setStatus(text) {
  if (status) {
    status.textContent = text;
  }
}

// Toggle the automatic group feature
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

// Open tab in new group
if (openTabButton) {
  openTabButton.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'skip-next-created-tab-grouping' });

      const newTab = await chrome.tabs.create({ active: true });

      // Omitting groupId creates a brand-new tab group.
      await chrome.tabs.group({ tabIds: newTab.id });

      window.close();
    } catch (error) {
      console.error('Failed to open tab in a new group:', error);
      setStatus('Failed to open tab. See extension console.');
    }
  });
}

// Edit the shortcut
if (editShortcutButton) {
  editShortcutButton.addEventListener('click', async () => {
    try {
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      window.close();
    } catch (error) {
      console.error('Failed to open shortcuts settings:', error);
      setStatus('Could not open shortcut settings.');
    }
  });
}