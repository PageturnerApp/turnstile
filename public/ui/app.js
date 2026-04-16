// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const TOAST_MS = 3200;
const MASKED_COPY_DETAIL = 'Full keys are shown only when created.';
const COMMON_CATEGORY_TEXT = '3030/3040 Audiobooks · 7000/7020 Ebooks · 2000 Movies · 5000 TV';

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
 * Show a temporary toast message.
 * @param {string} message - Message text.
 * @param {boolean} isError - Whether the toast is an error.
 * @returns {void}
 */
function toast(message, isError) {
  const element = find('#toast');
  if (!element) {
    return;
  }

  element.textContent = message;
  element.classList.toggle('error', Boolean(isError));
  element.classList.add('show');
  window.setTimeout(() => element.classList.remove('show'), TOAST_MS);
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
 * Write text to the clipboard.
 * @param {string} value - Text to copy.
 * @returns {Promise<void>}
 */
async function copyText(value) {
  await navigator.clipboard.writeText(value);
  toast('Copied to clipboard.', false);
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
 * Set a status dot state.
 * @param {string} selector - CSS selector.
 * @param {boolean} ok - Whether the status is healthy.
 * @returns {void}
 */
function setDot(selector, ok) {
  const element = find(selector);
  if (element) {
    element.classList.toggle('ok', Boolean(ok));
  }
}

/**
 * Load dashboard health and configuration data.
 * @returns {Promise<void>}
 */
async function loadDashboard() {
  const health = await api('api/v1/health');
  const config = await api('api/v1/config');
  const keys = await api('api/v1/keys');

  setText('#version', health.version);
  setText('#prowlarr-url', config.prowlarrUrl || 'Not configured');
  setText('#torrent-client', config.torrentClient);
  setText('#torrent-url', config.torrentClientUrl || 'Not configured');
  setText('#downloads-path', config.downloadsPath || 'Not configured');
  setText('#key-count', keys.length);
  setText('#bridge-url', config.bridgeUrl || 'Not configured');
  setDot('#prowlarr-dot', health.prowlarr);
  setDot('#torrent-dot', health.torrent_client_connected);
}

/**
 * Load settings into the settings form.
 * @returns {Promise<void>}
 */
async function loadSettings() {
  const config = await api('api/v1/config');
  Object.keys(config).forEach((key) => {
    const input = find(`[name="${key}"]`);
    if (input) {
      input.value = config[key] || '';
    }
  });
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
 * Wire the settings form and test buttons.
 * @returns {void}
 */
function bindSettings() {
  const form = find('#settings-form');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('api/v1/config', {
          method: 'POST',
          body: JSON.stringify(formToObject(form))
        });
        toast('Settings saved successfully.', false);
      } catch (error) {
        toast(error.message, true);
      }
    });
  }

  findAll('[data-test]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const data = await api(`api/v1/config/test/${button.dataset.test}`, {
          method: 'POST',
          body: '{}'
        });
        toast(data.connected ? 'Connection succeeded.' : 'Connection failed.', !data.connected);
      } catch (error) {
        toast(error.message, true);
      }
    });
  });
}

/**
 * Render API keys into the keys table.
 * @param {Array<Object>} keys - Masked API keys.
 * @returns {void}
 */
function renderKeys(keys) {
  const tbody = find('#keys-table tbody');
  if (!tbody) {
    return;
  }

  tbody.innerHTML = keys.map((key) => `
    <tr>
      <td>${escapeHtml(key.name)}</td>
      <td class="mono">${escapeHtml(key.key)}</td>
      <td>${escapeHtml((key.categories || []).join(', '))}</td>
      <td>${escapeHtml((key.indexers || []).join(', ') || 'All')}</td>
      <td class="mono">${escapeHtml(key.downloads_path || '')}</td>
      <td>${escapeHtml(new Date(key.created_at).toLocaleString())}</td>
      <td>
        <div class="actions">
          <button type="button" data-copy-masked="${escapeHtml(key.key)}">Copy</button>
          <button type="button" data-edit="${escapeHtml(key.id)}">Edit</button>
          <button type="button" class="danger" data-delete="${escapeHtml(key.id)}">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');

  bindKeyTableActions(keys);
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
 * Load and render API keys.
 * @returns {Promise<Array<Object>>}
 */
async function loadKeys() {
  const keys = await api('api/v1/keys');
  renderKeys(keys);
  return keys;
}

/**
 * Bind table action buttons for existing API keys.
 * @param {Array<Object>} keys - Masked keys.
 * @returns {void}
 */
function bindKeyTableActions(keys) {
  findAll('[data-copy-masked]').forEach((button) => {
    button.addEventListener('click', async () => {
      await copyText(button.dataset.copyMasked);
      toast(MASKED_COPY_DETAIL, false);
    });
  });

  findAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = keys.find((item) => item.id === button.dataset.edit);
      fillKeyForm(key);
    });
  });

  findAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`api/v1/keys/${button.dataset.delete}`, {
          method: 'DELETE'
        });
        await loadKeys();
        toast('API key deleted successfully.', false);
      } catch (error) {
        toast(error.message, true);
      }
    });
  });
}

/**
 * Fill the key form for editing.
 * @param {Object} key - Masked key record.
 * @returns {void}
 */
function fillKeyForm(key) {
  const form = find('#key-form');
  const wrapper = find('#key-form-panel');
  if (!form || !wrapper || !key) {
    return;
  }

  wrapper.classList.remove('hidden');
  form.elements.id.value = key.id;
  form.elements.name.value = key.name || '';
  form.elements.categories.value = (key.categories || []).join(', ');
  form.elements.indexers.value = (key.indexers || []).join(', ');
  form.elements.downloads_path.value = key.downloads_path || '';
  setText('#key-form-title', 'Edit API Key');
}

/**
 * Reset the key form for creation.
 * @returns {void}
 */
function resetKeyForm() {
  const form = find('#key-form');
  if (!form) {
    return;
  }

  form.reset();
  form.elements.id.value = '';
  setText('#key-form-title', 'Add API Key');
}

/**
 * Bind API key create and edit controls.
 * @returns {void}
 */
function bindKeys() {
  const panel = find('#key-form-panel');
  const form = find('#key-form');

  setText('#category-helper', COMMON_CATEGORY_TEXT);

  find('#add-key-button')?.addEventListener('click', () => {
    resetKeyForm();
    panel?.classList.remove('hidden');
  });

  find('#cancel-key-button')?.addEventListener('click', () => {
    panel?.classList.add('hidden');
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = formToObject(form);
    const id = payload.id;
    delete payload.id;

    try {
      const created = await api(id ? `api/v1/keys/${id}` : 'api/v1/keys', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      await loadKeys();
      panel?.classList.add('hidden');
      if (!id) {
        showKeyModal(created.key);
      } else {
        toast('API key updated successfully.', false);
      }
    } catch (error) {
      toast(error.message, true);
    }
  });
}

/**
 * Display the one-time API key modal.
 * @param {string} key - Raw API key.
 * @returns {void}
 */
function showKeyModal(key) {
  const backdrop = find('#key-modal');
  const keyElement = find('#new-key-value');
  if (!backdrop || !keyElement) {
    return;
  }

  keyElement.textContent = key;
  backdrop.classList.add('show');
}

/**
 * Bind modal actions.
 * @returns {void}
 */
function bindModal() {
  find('[data-close-modal]')?.addEventListener('click', () => {
    find('#key-modal')?.classList.remove('show');
  });

  find('#copy-new-key')?.addEventListener('click', async () => {
    const key = find('#new-key-value')?.textContent || '';
    await copyText(key);
  });
}

/**
 * Initialize the current page.
 * @returns {void}
 */
async function init() {
  try {
    const page = document.body.dataset.page;
    if (page === 'dashboard') {
      await loadDashboard();
    }
    if (page === 'settings') {
      await loadSettings();
      bindSettings();
    }
    if (page === 'keys') {
      await loadKeys();
      bindKeys();
      bindModal();
    }
  } catch (error) {
    toast(error.message, true);
  }
}

document.addEventListener('DOMContentLoaded', init);
