// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const TOAST_MS = 3000;
const TOAST_OUT_MS = 200;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_WEAK_LENGTH = 4;
const PASSWORD_GOOD_LENGTH = 12;
const PASSWORD_STRONG_LENGTH = 16;
const PASSWORD_STRENGTH_CLASSES = ['strength-weak', 'strength-medium', 'strength-good', 'strength-strong'];
const EMPTY_TEXT = 'Not configured';
const KEY_REFRESH_INTERVAL_MS = 10000;
const PAGE_DASHBOARD = 'dashboard';
const PAGE_SETTINGS = 'settings';
const PAGE_KEYS = 'keys';
const PAGE_LOGIN = 'login';
const PAGE_SETUP = 'setup';
const TEST_BUTTON_LABEL = 'Test connection';
const VERSION_PREFIX_PATTERN = /^v/i;
const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_X = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const ICON_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const ICON_DELETE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_SPINNER = '<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>';

let currentKeys = [];
let currentConfig = null;
let pendingDeleteKeyId = '';
let keyRefreshTimer = null;

/**
 * Find one element by selector.
 * @param {string} selector - CSS selector.
 * @returns {Element|null}
 */
function find(selector) {
  return document.querySelector(selector);
}

/**
 * Find all elements by selector.
 * @param {string} selector - CSS selector.
 * @returns {Array<Element>}
 */
function findAll(selector) {
  return Array.from(document.querySelectorAll(selector));
}

/**
 * Set text content when an element exists.
 * @param {string} selector - CSS selector.
 * @param {*} value - Value to render.
 * @returns {void}
 */
function setText(selector, value) {
  const element = find(selector);
  if (element) {
    element.textContent = value;
  }
}

/**
 * Escape text for safe HTML rendering.
 * @param {*} value - Raw value.
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Convert a form to a JSON-compatible object.
 * @param {HTMLFormElement} form - Form element.
 * @returns {Object}
 */
function formToObject(form) {
  const data = new FormData(form);
  const output = {};
  data.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

/**
 * Fetch JSON from the Turnstile API.
 * @param {string} url - API URL.
 * @param {Object} options - Fetch options.
 * @returns {Promise<Object>}
 */
async function api(url, options) {
  const response = await fetch(url, Object.assign({
    headers: {
      'Content-Type': 'application/json'
    }
  }, options || {}));
  const body = await response.json();

  if (!body.success) {
    throw new Error(body.detail || 'The request could not be completed.');
  }

  return body.data;
}

/**
 * Submit a server-rendered auth form and follow redirects in the browser.
 * @param {HTMLFormElement} form - Auth form.
 * @returns {Promise<void>}
 */
async function submitAuthForm(form) {
  const response = await fetch(form.action, {
    method: form.method || 'POST',
    body: new URLSearchParams(new FormData(form)),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  if (response.redirected) {
    window.location.href = response.url;
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await response.json();
    if (!body.success) {
      throw new Error(body.detail || 'The request could not be completed.');
    }
  }

  window.location.href = 'ui';
}

/**
 * Show a temporary toast message.
 * @param {string} message - Message text.
 * @param {string} type - Toast type.
 * @returns {void}
 */
function showToast(message, type) {
  const container = find('#toast-container');
  if (!container) {
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type || 'success'}`;
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add('exiting');
    window.setTimeout(() => toast.remove(), TOAST_OUT_MS);
  }, TOAST_MS);
}

/**
 * Write text to the clipboard.
 * @param {string} value - Text to copy.
 * @returns {Promise<void>}
 */
async function copyText(value) {
  await navigator.clipboard.writeText(value);
  showToast('Copied to clipboard.', 'success');
}

/**
 * Show an inline authentication error.
 * @param {string} containerSelector - Error container selector.
 * @param {string} textSelector - Error text selector.
 * @param {string} message - Error message.
 * @returns {void}
 */
function showAuthError(containerSelector, textSelector, message) {
  setText(textSelector, message);
  find(containerSelector)?.classList.add('visible');
}

/**
 * Hide an inline authentication error.
 * @param {string} containerSelector - Error container selector.
 * @returns {void}
 */
function hideAuthError(containerSelector) {
  find(containerSelector)?.classList.remove('visible');
}

/**
 * Update the password strength meter.
 * @param {string} password - Password value.
 * @returns {void}
 */
function updatePasswordStrength(password) {
  const bar = find('#password-strength-bar');
  if (!bar) {
    return;
  }

  let nextClass = '';
  if (password.length >= PASSWORD_STRONG_LENGTH) {
    nextClass = 'strength-strong';
  } else if (password.length >= PASSWORD_GOOD_LENGTH) {
    nextClass = 'strength-good';
  } else if (password.length >= PASSWORD_MIN_LENGTH) {
    nextClass = 'strength-medium';
  } else if (password.length >= PASSWORD_WEAK_LENGTH) {
    nextClass = 'strength-weak';
  }

  bar.classList.remove(...PASSWORD_STRENGTH_CLASSES);
  if (nextClass) {
    bar.classList.add(nextClass);
  }
}

/**
 * Bind the first-run setup form.
 * @returns {void}
 */
function bindSetupForm() {
  const form = find('#setup-form');
  const password = find('#setup-password');
  const confirm = find('#setup-password-confirm');
  if (!form || !password || !confirm) {
    return;
  }

  password.addEventListener('input', () => updatePasswordStrength(password.value));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (password.value.length < PASSWORD_MIN_LENGTH) {
      showAuthError('#setup-error', '#setup-error-text', 'Password must be at least 12 characters.');
      return;
    }

    if (password.value !== confirm.value) {
      showAuthError('#setup-error', '#setup-error-text', 'Passwords do not match.');
      return;
    }

    hideAuthError('#setup-error');
    try {
      await submitAuthForm(form);
    } catch (error) {
      showAuthError('#setup-error', '#setup-error-text', error.message);
    }
  });
}

/**
 * Bind the UI login form.
 * @returns {void}
 */
function bindLoginForm() {
  const form = find('#login-form');
  if (!form) {
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAuthError('#login-error');
    try {
      await submitAuthForm(form);
    } catch (error) {
      showAuthError('#login-error', '#login-error-text', error.message);
      find('#login-password')?.focus();
    }
  });
}

/**
 * Highlight the active navigation link.
 * @param {string} page - Current page.
 * @returns {void}
 */
function markActiveNavigation(page) {
  findAll('[data-page-link]').forEach((link) => {
    link.classList.toggle('active', link.getAttribute('data-page-link') === page);
  });
}

/**
 * Bind mobile menu and collapsible controls.
 * @returns {void}
 */
function bindShellControls() {
  find('[data-toggle-menu]')?.addEventListener('click', () => {
    find('#nav-links')?.classList.toggle('open');
  });

  findAll('[data-toggle-collapsible]').forEach((button) => {
    button.addEventListener('click', () => {
      find(`#${button.getAttribute('data-toggle-collapsible')}`)?.classList.toggle('open');
    });
  });
}

/**
 * Set a status dot to online or offline.
 * @param {string} selector - Dot selector.
 * @param {boolean} ok - Whether the status is healthy.
 * @returns {void}
 */
function setStatusDot(selector, ok) {
  const dot = find(selector);
  if (!dot) {
    return;
  }

  dot.classList.remove('idle', 'online', 'offline', 'warning');
  dot.classList.add(ok ? 'online' : 'offline');
}

/**
 * Format a URL for compact display.
 * @param {string} value - Raw URL value.
 * @returns {string}
 */
function formatUrlDisplay(value) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch (error) {
    return value || EMPTY_TEXT;
  }
}

/**
 * Set an external link href and label.
 * @param {string} selector - Link selector.
 * @param {string} value - URL value.
 * @returns {void}
 */
function setExternalLink(selector, value) {
  const link = find(selector);
  if (!link) {
    return;
  }

  if (!value) {
    link.removeAttribute('href');
    link.textContent = EMPTY_TEXT;
    return;
  }

  link.setAttribute('href', value);
  link.textContent = formatUrlDisplay(value);
}

/**
 * Format a version with a leading v for display.
 * @param {string} value - Version value.
 * @returns {string}
 */
function formatVersion(value) {
  const clean = String(value || '').trim().replace(VERSION_PREFIX_PATTERN, '');
  return clean ? `v${clean}` : EMPTY_TEXT;
}

/**
 * Render a command list into a monospace block.
 * @param {string} selector - Command block selector.
 * @param {Array<string>} commands - Commands to render.
 * @returns {void}
 */
function setCommandList(selector, commands) {
  setText(selector, Array.isArray(commands) ? commands.join('\n') : '');
}

/**
 * Render top-nav update status.
 * @param {Object} update - Update status payload.
 * @returns {void}
 */
function renderUpdateStatus(update) {
  const currentVersion = formatVersion(update?.current_version);
  const latestVersion = formatVersion(update?.latest_version);
  const versionButton = find('#nav-version');
  const releaseLink = find('#version-release-link');
  const commands = find('#version-commands');

  if (!versionButton) {
    return;
  }

  versionButton.classList.remove('update-available', 'update-unavailable');
  versionButton.setAttribute('aria-label', `Turnstile ${currentVersion}`);
  if (!update || !update.checked) {
    versionButton.classList.add('update-unavailable');
    versionButton.setAttribute('aria-label', `Turnstile ${currentVersion}. Update check unavailable.`);
    setText('#version-title', 'Update check unavailable');
    setText('#version-detail', `Current ${currentVersion}`);
    releaseLink?.classList.add('hidden');
    commands?.classList.add('hidden');
    return;
  }

  if (update.update_available) {
    versionButton.classList.add('update-available');
    versionButton.setAttribute('aria-label', `Turnstile ${currentVersion}. Update ${latestVersion} available.`);
    setText('#version-title', `${latestVersion} is available`);
    setText('#version-detail', `Current ${currentVersion} · Latest ${latestVersion}`);
    setCommandList('#version-node-command', update.commands?.bare_node);
    setCommandList('#version-docker-command', update.commands?.docker);
    setText('#version-docker-image', update.docker_image || '');
    commands?.classList.remove('hidden');
  } else {
    setText('#version-title', 'Turnstile is up to date');
    setText('#version-detail', `Current ${currentVersion} · Latest ${latestVersion}`);
    commands?.classList.add('hidden');
  }

  if (releaseLink && update.release_url) {
    releaseLink.href = update.release_url;
    releaseLink.classList.remove('hidden');
  }
}

/**
 * Load health data and update shared shell labels.
 * @returns {Promise<Object>}
 */
async function loadHealth() {
  const health = await api('api/v1/health');
  setText('#nav-version', `v${health.version}`);

  api('api/v1/update')
    .then(renderUpdateStatus)
    .catch(() => {
      renderUpdateStatus({
        checked: false,
        current_version: health.version
      });
    });

  return health;
}

/**
 * Load dashboard data.
 * @returns {Promise<void>}
 */
async function loadDashboard() {
  const health = await loadHealth();
  const results = await Promise.all([
    api('api/v1/config'),
    api('api/v1/keys')
  ]);
  const config = results[0];
  const keys = results[1];
  const allConnected = Boolean(health.prowlarr && health.torrent_client_connected);

  setStatusDot('#health-dot', allConnected);
  setText('#health-summary-text', allConnected ? 'All systems connected' : 'Some connections need attention');
  setStatusDot('#prowlarr-dot', health.prowlarr);
  setStatusDot('#torrent-dot', health.torrent_client_connected);
  setExternalLink('#prowlarr-url', config.prowlarrUrl);
  setText('#torrent-client', config.torrentClient || health.torrent_client || EMPTY_TEXT);
  setExternalLink('#torrent-url', config.torrentClientUrl);
  setText('#downloads-path', config.downloadsPath || EMPTY_TEXT);
  setText('#key-count', keys.length);
  setText('#bridge-url-inline', config.bridgeUrl || EMPTY_TEXT);
}

/**
 * Load settings into the settings form.
 * @returns {Promise<void>}
 */
async function loadSettings() {
  await loadHealth();
  currentConfig = await api('api/v1/config');
  Object.keys(currentConfig).forEach((key) => {
    const input = find(`[name="${key}"]`);
    if (input) {
      input.value = currentConfig[key] || '';
    }
  });
}

/**
 * Render a connection test result.
 * @param {string} type - Test type.
 * @param {boolean} connected - Whether the service connected.
 * @returns {void}
 */
function renderTestResult(type, connected) {
  const result = find(`#test-${type}`);
  if (!result) {
    return;
  }

  result.className = `test-result visible ${connected ? 'ok' : 'fail'}`;
  result.innerHTML = `${connected ? ICON_CHECK : ICON_X} ${connected ? 'Connected' : 'Failed'}`;
}

/**
 * Bind settings save and connection test controls.
 * @returns {void}
 */
function bindSettings() {
  const form = find('#settings-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      currentConfig = await api('api/v1/config', {
        method: 'POST',
        body: JSON.stringify(formToObject(form))
      });
      showToast('Settings saved.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  findAll('[data-test]').forEach((button) => {
    button.addEventListener('click', async () => {
      const type = button.getAttribute('data-test');
      const resultId = type;
      const previousHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `${ICON_SPINNER} Testing...`;
      try {
        const data = await api(`api/v1/config/test/${type}`, {
          method: 'POST',
          body: '{}'
        });
        renderTestResult(resultId, data.connected);
      } catch (error) {
        renderTestResult(resultId, false);
        showToast(error.message, 'error');
      } finally {
        button.disabled = false;
        button.innerHTML = previousHtml || TEST_BUTTON_LABEL;
      }
    });
  });
}

/**
 * Format a date for key metadata.
 * @param {string} value - ISO date value.
 * @returns {string}
 */
function formatDate(value) {
  if (!value) {
    return EMPTY_TEXT;
  }

  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Render category tags.
 * @param {Array<number>} categories - Category IDs.
 * @returns {string}
 */
function renderCategoryTags(categories) {
  if (!Array.isArray(categories) || !categories.length) {
    return '<span class="text-muted">All categories</span>';
  }

  return categories.map((category) => `<span class="key-tag">${escapeHtml(category)}</span>`).join('');
}

/**
 * Render one API key row.
 * @param {Object} key - Masked API key record.
 * @returns {string}
 */
function renderKeyItem(key) {
  const indexers = Array.isArray(key.indexers) && key.indexers.length ? key.indexers.join(', ') : 'All indexers';
  return `
    <div class="key-item" data-key-id="${escapeHtml(key.id)}">
      <div class="key-primary">
        <span class="key-name">${escapeHtml(key.name)}</span>
        <span class="key-masked">${escapeHtml(key.key)}</span>
        <div class="key-actions">
          <button class="btn-icon" type="button" title="Edit" data-edit-key="${escapeHtml(key.id)}">${ICON_EDIT}</button>
          <button class="btn-icon destructive" type="button" title="Delete" data-delete-key="${escapeHtml(key.id)}">${ICON_DELETE}</button>
        </div>
      </div>
      <div class="key-meta">
        ${renderCategoryTags(key.categories)}
        <span class="sep">&middot;</span> <span class="mono">${escapeHtml(indexers)}</span>
        <span class="sep">&middot;</span> <span class="mono">${escapeHtml(key.downloads_path || '')}</span>
        <span class="sep">&middot;</span> ${escapeHtml(formatDate(key.created_at))}
      </div>
    </div>
  `;
}

/**
 * Render the empty key list state.
 * @returns {string}
 */
function renderEmptyKeys() {
  return `
    <div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
      <h3>No API keys yet</h3>
      <p>Create one to connect Pageturner or another app.</p>
      <button class="btn-primary btn-sm" type="button" data-open-key-modal>Create your first key</button>
    </div>
  `;
}

/**
 * Render API keys into the list.
 * @param {Array<Object>} keys - Masked API keys.
 * @returns {void}
 */
function renderKeys(keys) {
  const list = find('#keys-list');
  if (!list) {
    return;
  }

  setText('#key-count', keys.length);
  list.innerHTML = keys.length ? keys.map(renderKeyItem).join('') : renderEmptyKeys();
}

/**
 * Load API keys and supporting config.
 * @returns {Promise<void>}
 */
async function loadKeys() {
  await loadHealth();
  const results = await Promise.all([
    api('api/v1/config'),
    api('api/v1/keys')
  ]);
  currentConfig = results[0];
  currentKeys = results[1];
  renderKeys(currentKeys);
}

/**
 * Refresh API keys without interrupting the user with transient errors.
 * @returns {Promise<void>}
 */
async function refreshKeysQuietly() {
  try {
    await loadKeys();
  } catch (error) {
    return;
  }
}

/**
 * Start automatic API key refresh for live key list updates.
 * @returns {void}
 */
function startKeyAutoRefresh() {
  if (keyRefreshTimer) {
    return;
  }

  keyRefreshTimer = window.setInterval(refreshKeysQuietly, KEY_REFRESH_INTERVAL_MS);
  window.addEventListener('focus', refreshKeysQuietly);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshKeysQuietly();
    }
  });
}

/**
 * Open a modal.
 * @param {string} id - Modal element id.
 * @returns {void}
 */
function openModal(id) {
  find(`#${id}`)?.classList.add('active');
  document.body.classList.add('modal-open');
}

/**
 * Close a modal.
 * @param {string} id - Modal element id.
 * @returns {void}
 */
function closeModal(id) {
  find(`#${id}`)?.classList.remove('active');
  if (!find('.modal-overlay.active')) {
    document.body.classList.remove('modal-open');
  }
}

/**
 * Reset the API key form.
 * @returns {void}
 */
function resetKeyForm() {
  const form = find('#key-form');
  if (!form) {
    return;
  }

  form.reset();
  form.elements.id.value = '';
  form.elements.downloads_path.value = currentConfig?.downloadsPath || '';
  setText('#key-form-title', 'New API key');
  setText('#save-key-button', 'Create key');
}

/**
 * Fill the key form for editing.
 * @param {Object} key - Masked API key record.
 * @returns {void}
 */
function fillKeyForm(key) {
  const form = find('#key-form');
  if (!form || !key) {
    return;
  }

  form.elements.id.value = key.id;
  form.elements.name.value = key.name || '';
  form.elements.categories.value = (key.categories || []).join(', ');
  form.elements.indexers.value = (key.indexers || []).join(', ');
  form.elements.downloads_path.value = key.downloads_path || '';
  setText('#key-form-title', 'Edit API key');
  setText('#save-key-button', 'Save key');
}

/**
 * Show the one-time API key reveal modal.
 * @param {Object} key - Created API key.
 * @returns {void}
 */
function showKeyReveal(key) {
  setText('#reveal-key-name', key.name || 'this device');
  setText('#reveal-key-value', key.key || '');
  openModal('modal-key-reveal');
}

/**
 * Bind API key modals and list controls.
 * @returns {void}
 */
function bindKeys() {
  startKeyAutoRefresh();

  find('#add-key-button')?.addEventListener('click', () => {
    resetKeyForm();
    openModal('modal-add-key');
  });

  find('#keys-list')?.addEventListener('click', async (event) => {
    const target = event.target.closest('button');
    if (!target) {
      return;
    }

    if (target.hasAttribute('data-open-key-modal')) {
      resetKeyForm();
      openModal('modal-add-key');
      return;
    }

    if (target.hasAttribute('data-edit-key')) {
      const key = currentKeys.find((item) => item.id === target.getAttribute('data-edit-key'));
      fillKeyForm(key);
      openModal('modal-add-key');
      return;
    }

    if (target.hasAttribute('data-delete-key')) {
      pendingDeleteKeyId = target.getAttribute('data-delete-key') || '';
      openModal('modal-confirm-delete');
    }
  });

  find('#key-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = formToObject(form);
    const id = payload.id;
    delete payload.id;

    try {
      const saved = await api(id ? `api/v1/keys/${id}` : 'api/v1/keys', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      closeModal('modal-add-key');
      await loadKeys();
      if (id) {
        showToast('API key updated.', 'success');
      } else {
        showKeyReveal(saved);
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  find('#confirm-delete-key')?.addEventListener('click', async () => {
    if (!pendingDeleteKeyId) {
      closeModal('modal-confirm-delete');
      return;
    }

    try {
      await api(`api/v1/keys/${pendingDeleteKeyId}`, {
        method: 'DELETE'
      });
      pendingDeleteKeyId = '';
      closeModal('modal-confirm-delete');
      await loadKeys();
      showToast('Key deleted.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  find('#copy-new-key')?.addEventListener('click', async () => {
    await copyText(find('#reveal-key-value')?.textContent || '');
  });

  findAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.getAttribute('data-close-modal')));
  });

  findAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        closeModal(overlay.id);
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      findAll('.modal-overlay.active').forEach((modal) => closeModal(modal.id));
    }
  });
}

/**
 * Initialize the current page.
 * @returns {Promise<void>}
 */
async function init() {
  const page = document.body.dataset.page;
  markActiveNavigation(page);
  bindShellControls();

  try {
    if (page === PAGE_SETUP) {
      bindSetupForm();
    } else if (page === PAGE_LOGIN) {
      bindLoginForm();
    } else if (page === PAGE_DASHBOARD) {
      await loadDashboard();
    } else if (page === PAGE_SETTINGS) {
      await loadSettings();
      bindSettings();
    } else if (page === PAGE_KEYS) {
      await loadKeys();
      bindKeys();
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);
