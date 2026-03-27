const backButton = document.getElementById('back');
const closeOlderThanButton = document.getElementById('closeOlderThan');
const refreshButton = document.getElementById('refresh');
const olderThanSelect = document.getElementById('olderThan');
const summary = document.getElementById('summary');
const status = document.getElementById('status');
const list = document.getElementById('list');

function setStatus(text) {
  if (status) {
    status.textContent = text;
  }
}

function formatDuration(durationMs) {
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return map[char] || char;
  });
}

function toGroupColorCss(groupColor) {
  const map = {
    gray: '#9aa0a6',
    grey: '#9aa0a6',
    blue: '#1a73e8',
    red: '#d93025',
    yellow: '#f9ab00',
    green: '#188038',
    pink: '#d01884',
    purple: '#9334e6',
    cyan: '#129eaf',
    orange: '#e37400'
  };

  if (!groupColor) {
    return '#c4c9d2';
  }

  if (typeof groupColor === 'string') {
    const normalized = groupColor.trim().toLowerCase();
    if (normalized in map) {
      return map[normalized];
    }

    // Fall back to raw CSS color strings returned by the API.
    return normalized;
  }

  return '#9aa0a6';
}

function renderTabs(tabs) {
  if (!list) {
    return;
  }

  if (!tabs || tabs.length === 0) {
    list.innerHTML = '<div class="empty">No open tabs found.</div>';
    if (summary) {
      summary.textContent = '0 tabs';
    }
    return;
  }

  if (summary) {
    const leastRecentlyUsed = tabs[0];
    summary.textContent = `${tabs.length} tabs - least recently used is ${formatDuration(leastRecentlyUsed.inactiveMs)} ago`;
  }

  const html = tabs
    .map((tab, index) => {
      const safeTitle = escapeHtml(tab.title || '(Untitled tab)');
      const safeGroup = escapeHtml(tab.groupLabel || 'Ungrouped');
      const groupColorCss = toGroupColorCss(tab.groupColor);
      const safeGroupColor = escapeHtml(tab.groupColor || 'none');

      return `
        <div class="row">
          <div class="row-top">
            <div class="row-title">${index + 1}. ${safeTitle}</div>
            <div class="row-actions">
              <button class="row-go" type="button" data-tab-id="${tab.id}">Go To</button>
              <button class="row-close" type="button" data-tab-id="${tab.id}">Close</button>
            </div>
          </div>
            <div class="row-meta">
              <span>Inactive: ${formatDuration(tab.inactiveMs)} |</span>
              <span class="group-dot" style="background-color:${groupColorCss};" title="${safeGroupColor}"></span>
              <span>Group: ${safeGroup}</span>
            </div>
        </div>
      `;
    })
    .join('');

  list.innerHTML = html;
}

async function loadTabs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-tabs-by-last-used' });
    if (!response?.ok) {
      throw new Error('Failed to load tabs by last used');
    }

    renderTabs(response.tabs || []);
    setStatus('');
  } catch (error) {
    console.error('Failed to load tab ages:', error);
    setStatus('Could not load tabs. See extension console.');
  }
}

async function closeTabsOlderThan(thresholdMs) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'close-tabs-inactive-longer-than',
      thresholdMs
    });

    if (!response?.ok) {
      throw new Error('Failed to close inactive tabs by threshold');
    }

    setStatus(`Closed ${response.closedCount} tab(s) inactive longer than selected threshold.`);
    await loadTabs();
  } catch (error) {
    console.error('Failed to close tabs older than threshold:', error);
    setStatus('Could not close tabs by threshold. See extension console.');
  }
}

async function closeTabById(tabId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'close-tab-by-id',
      tabId
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to close tab');
    }

    if (!response.closed) {
      throw new Error(response?.error || 'Failed to close tab');
    }

    if (response.alreadyClosed) {
      setStatus('Tab was already closed.');
    } else {
      setStatus('Closed 1 tab.');
    }
    await loadTabs();
  } catch (error) {
    console.error('Failed to close tab by id:', error);
    setStatus(`Could not close tab: ${error.message || 'Unknown error'}`);
  }
}

async function goToTabById(tabId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'focus-tab-by-id',
      tabId
    });

    if (!response?.ok || !response.focused) {
      throw new Error(response?.error || 'Failed to focus tab');
    }

    if (response.focusWarning) {
      console.warn('Tab activated but window focus warning:', response.focusWarning);
    }

    window.close();
  } catch (error) {
    console.error('Failed to go to tab by id:', error);
    setStatus(`Could not switch to tab: ${error.message || 'Unknown error'}`);
  }
}

if (backButton) {
  backButton.addEventListener('click', () => {
    window.location.href = 'popup.html';
  });
}

if (refreshButton) {
  refreshButton.addEventListener('click', () => {
    loadTabs();
  });
}

if (closeOlderThanButton) {
  closeOlderThanButton.addEventListener('click', () => {
    const thresholdMs = Number(olderThanSelect?.value || 0);
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
      setStatus('Choose a valid threshold.');
      return;
    }

    closeTabsOlderThan(Math.floor(thresholdMs));
  });
}

if (list) {
  list.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const goButton = target.closest('.row-go');
    if (goButton instanceof HTMLElement) {
      const tabId = Number(goButton.getAttribute('data-tab-id'));
      if (!Number.isFinite(tabId)) {
        setStatus('Invalid tab selection.');
        return;
      }

      goToTabById(tabId);
      return;
    }

    const closeButton = target.closest('.row-close');
    if (!(closeButton instanceof HTMLElement)) {
      return;
    }

    const tabId = Number(closeButton.getAttribute('data-tab-id'));
    if (!Number.isFinite(tabId)) {
      setStatus('Invalid tab selection.');
      return;
    }

    closeTabById(tabId);
  });
}

loadTabs();
