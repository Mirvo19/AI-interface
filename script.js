(() => {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 1: CONSTANTS & STATE
  // ─────────────────────────────────────────────────────────────────────────────

  const API_BASE_URL_DEFAULT = 'https://ai.hackclub.com/proxy/v1';
  const LEGACY_API_BASE_URL = 'https://ai.nirvaan.hackclub.app/api/v1';
  const CORS_RELAY_BASE = 'https://corsproxy.io/?';
  const MODELS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  const LS = {
    API_KEY: 'hcai_api_key',
    CONVERSATIONS: 'hcai_conversations',
    ACTIVE_CONV: 'hcai_active_conv',
    MODELS: 'hcai_models',
    MODELS_TS: 'hcai_models_ts',
    SETTINGS: 'hcai_settings',
  };

  const DEFAULT_SETTINGS = {
    chat_model: 'anthropic/claude-sonnet-4-5',
    title_model: 'openai/gpt-4o-mini',
    max_tokens: 4096,
    temperature: 0.7,
    thinking_mode: false,
    thinking_budget: 8000,
    system_prompt: '',
    stream: true,
    show_token_count: true,
    enter_to_send: true,
    auto_title: true,
    compact_mode: false,
    font_size: 14,
    code_theme: 'dark',
    base_url: API_BASE_URL_DEFAULT,
  };

  const state = {
    conversations: [],
    activeConvId: null,
    models: [],
    settings: { ...DEFAULT_SETTINGS },
    isStreaming: false,
    abortController: null,
    thinkingActive: false,
    webSearchActive: false,
    attachedImage: null,
    commandPaletteOpen: false,
    currentDropdown: null,
    commandSelectedIndex: -1,
    commandItems: [],
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 2: STORAGE HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { console.warn('localStorage write failed:', e); return false; }
  }

  function lsDel(key) { localStorage.removeItem(key); }

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function getApiKey() { return localStorage.getItem(LS.API_KEY) || ''; }
  function setApiKey(key) { localStorage.setItem(LS.API_KEY, key.trim()); }

  function getStorageUsedKB() {
    let total = 0;
    try {
      for (const key in localStorage) {
        if (!Object.prototype.hasOwnProperty.call(localStorage, key)) continue;
        total += (localStorage[key].length + key.length) * 2;
      }
    } catch {}
    return (total / 1024).toFixed(1);
  }

  function getBaseUrl() {
    return (state.settings.base_url || API_BASE_URL_DEFAULT).replace(/\/$/, '');
  }

  function generateLocalTitle(text) {
    const cleaned = String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/["'`*_~]/g, '')
      .trim();
    if (!cleaned) return 'New Conversation';

    const words = cleaned.split(' ')
      .filter(Boolean)
      .slice(0, 6)
      .map(word => word.replace(/^[^\w]+|[^\w]+$/g, ''))
      .filter(Boolean);

    const title = words.join(' ');
    return title ? title.slice(0, 80) : 'New Conversation';
  }

  function isCorsFetchFailure(err) {
    const message = String(err?.message || err || '');
    return err instanceof TypeError || /failed to fetch|cors/i.test(message);
  }

  function getRelayUrl(url) {
    return `${CORS_RELAY_BASE}${url}`;
  }

  async function fetchWithCorsFallback(url, options = {}) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (!isCorsFetchFailure(err)) throw err;
      console.warn('Direct request failed, retrying through CORS relay:', url);
      return fetch(getRelayUrl(url), options);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 3: SETTINGS
  // ─────────────────────────────────────────────────────────────────────────────

  function loadSettings() {
    const saved = lsGet(LS.SETTINGS) || {};
    state.settings = { ...DEFAULT_SETTINGS, ...saved };
    if (!saved.base_url || saved.base_url === LEGACY_API_BASE_URL) {
      state.settings.base_url = API_BASE_URL_DEFAULT;
    }
    applySettings();
  }

  function saveSettings() {
    lsSet(LS.SETTINGS, state.settings);
    applySettings();
  }

  function applySettings() {
    document.documentElement.style.setProperty('--font-size', state.settings.font_size + 'px');
    const mc = document.getElementById('messages-container');
    if (mc) mc.classList.toggle('compact', !!state.settings.compact_mode);

    const codeThemeMap = {
      dark: 'github-dark-dimmed',
      light: 'github',
      'github-dark': 'github-dark',
    };
    const hljsEl = document.getElementById('hljs-theme');
    if (hljsEl) {
      const theme = codeThemeMap[state.settings.code_theme] || 'github-dark-dimmed';
      hljsEl.href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${theme}.min.css`;
    }
  }

  function saveSettingsFromUI() {
    // API tab
    const apiKeyInput = document.getElementById('api-key-input');
    if (apiKeyInput && apiKeyInput.value.trim()) setApiKey(apiKeyInput.value.trim());

    const baseUrlInput = document.getElementById('base-url-input');
    if (baseUrlInput) state.settings.base_url = baseUrlInput.value.trim() || API_BASE_URL_DEFAULT;

    // Generation tab
    const maxTokInput = document.getElementById('max-tokens-input');
    if (maxTokInput) state.settings.max_tokens = parseInt(maxTokInput.value, 10) || 4096;

    const tempSlider = document.getElementById('temperature-slider');
    if (tempSlider) state.settings.temperature = parseFloat(tempSlider.value);

    const thinkDefault = document.getElementById('thinking-default-toggle');
    if (thinkDefault) state.settings.thinking_mode = thinkDefault.checked;

    const thinkBudget = document.getElementById('thinking-budget-slider');
    if (thinkBudget) state.settings.thinking_budget = parseInt(thinkBudget.value, 10);

    const sysPrompt = document.getElementById('system-prompt-input');
    if (sysPrompt) state.settings.system_prompt = sysPrompt.value;

    // Interface tab
    const fontSlider = document.getElementById('font-size-slider');
    if (fontSlider) state.settings.font_size = parseInt(fontSlider.value, 10);

    const compactToggle = document.getElementById('compact-mode-toggle');
    if (compactToggle) state.settings.compact_mode = compactToggle.checked;

    const enterSendToggle = document.getElementById('enter-send-toggle');
    if (enterSendToggle) state.settings.enter_to_send = enterSendToggle.checked;

    const showTokensToggle = document.getElementById('show-tokens-toggle');
    if (showTokensToggle) state.settings.show_token_count = showTokensToggle.checked;

    const autoTitleToggle = document.getElementById('auto-title-toggle');
    if (autoTitleToggle) state.settings.auto_title = autoTitleToggle.checked;

    const codeThemeRadio = document.querySelector('input[name="code-theme"]:checked');
    if (codeThemeRadio) state.settings.code_theme = codeThemeRadio.value;

    saveSettings();
    updateApiStatus();
    showToast('Settings saved', 'success');
    closeSettings();
  }

  function loadSettingsIntoUI() {
    const apiKeyInput = document.getElementById('api-key-input');
    if (apiKeyInput) apiKeyInput.value = getApiKey() || '';

    const baseUrlInput = document.getElementById('base-url-input');
    if (baseUrlInput) baseUrlInput.value = state.settings.base_url;

    // Generation
    syncSlider('max-tokens-slider', 'max-tokens-input', 'max-tokens-display', state.settings.max_tokens);
    syncSlider('temperature-slider', null, 'temperature-display', state.settings.temperature);
    syncSlider('thinking-budget-slider', null, 'thinking-budget-display', state.settings.thinking_budget, v => v.toLocaleString() + ' tokens');

    const thinkDefault = document.getElementById('thinking-default-toggle');
    if (thinkDefault) thinkDefault.checked = !!state.settings.thinking_mode;

    const sysPrompt = document.getElementById('system-prompt-input');
    if (sysPrompt) sysPrompt.value = state.settings.system_prompt || '';

    // Interface
    syncSlider('font-size-slider', null, 'font-size-display', state.settings.font_size, v => v + 'px');

    const compactToggle = document.getElementById('compact-mode-toggle');
    if (compactToggle) compactToggle.checked = !!state.settings.compact_mode;

    const enterSendToggle = document.getElementById('enter-send-toggle');
    if (enterSendToggle) enterSendToggle.checked = state.settings.enter_to_send !== false;

    const showTokensToggle = document.getElementById('show-tokens-toggle');
    if (showTokensToggle) showTokensToggle.checked = state.settings.show_token_count !== false;

    const autoTitleToggle = document.getElementById('auto-title-toggle');
    if (autoTitleToggle) autoTitleToggle.checked = state.settings.auto_title !== false;

    const codeThemeRadio = document.querySelector(`input[name="code-theme"][value="${state.settings.code_theme}"]`);
    if (codeThemeRadio) codeThemeRadio.checked = true;

    // Storage usage
    const usedKB = parseFloat(getStorageUsedKB());
    const maxKB = 5120; // 5MB typical localStorage limit
    const pct = Math.min(100, (usedKB / maxKB) * 100);
    const bar = document.getElementById('storage-usage-bar');
    const label = document.getElementById('storage-usage-label');
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = `${usedKB} KB used of ~5 MB`;

    // Models updated time
    const ts = lsGet(LS.MODELS_TS);
    const mu = document.getElementById('models-last-updated');
    if (mu) mu.textContent = ts ? `Updated ${relativeTime(ts)}` : 'Not yet loaded';

    // Model pickers
    updateSettingsModelPicker('settings-chat-model-btn', 'settings-chat-model-label', 'settings-chat-model-dropdown', 'chat');
    updateSettingsModelPicker('settings-title-model-btn', 'settings-title-model-label', 'settings-title-model-dropdown', 'title');

    // Connection status
    updateConnStatusDisplay();
  }

  function syncSlider(sliderId, inputId, displayId, value, fmt) {
    const slider = document.getElementById(sliderId);
    const input = inputId ? document.getElementById(inputId) : null;
    const display = document.getElementById(displayId);
    if (slider) slider.value = value;
    if (input) input.value = value;
    if (display) display.textContent = fmt ? fmt(value) : value;
  }

  function setupSettingsSliders() {
    // Max tokens
    const maxSlider = document.getElementById('max-tokens-slider');
    const maxInput = document.getElementById('max-tokens-input');
    const maxDisplay = document.getElementById('max-tokens-display');
    if (maxSlider && maxInput && maxDisplay) {
      maxSlider.addEventListener('input', () => {
        maxInput.value = maxSlider.value;
        maxDisplay.textContent = Number(maxSlider.value).toLocaleString();
      });
      maxInput.addEventListener('input', () => {
        maxSlider.value = maxInput.value;
        maxDisplay.textContent = Number(maxInput.value).toLocaleString();
      });
    }

    // Temperature
    const tempSlider = document.getElementById('temperature-slider');
    const tempDisplay = document.getElementById('temperature-display');
    if (tempSlider && tempDisplay) {
      tempSlider.addEventListener('input', () => {
        tempDisplay.textContent = parseFloat(tempSlider.value).toFixed(2);
      });
    }

    // Thinking budget
    const thinkSlider = document.getElementById('thinking-budget-slider');
    const thinkDisplay = document.getElementById('thinking-budget-display');
    if (thinkSlider && thinkDisplay) {
      thinkSlider.addEventListener('input', () => {
        thinkDisplay.textContent = Number(thinkSlider.value).toLocaleString() + ' tokens';
      });
    }

    // Font size
    const fontSlider = document.getElementById('font-size-slider');
    const fontDisplay = document.getElementById('font-size-display');
    if (fontSlider && fontDisplay) {
      fontSlider.addEventListener('input', () => {
        fontDisplay.textContent = fontSlider.value + 'px';
        document.documentElement.style.setProperty('--font-size', fontSlider.value + 'px');
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 4: MODEL FETCHING & MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  async function fetchModels(forceRefresh = false) {
    const cached = lsGet(LS.MODELS);
    const ts = lsGet(LS.MODELS_TS);
    if (!forceRefresh && cached && ts && (Date.now() - ts) < MODELS_CACHE_TTL) {
      state.models = cached;
      return cached;
    }
    try {
      const apiKey = getApiKey();
      const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
      const res = await fetchWithCorsFallback(`${getBaseUrl()}/models`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      state.models = json.data || json.models || (Array.isArray(json) ? json : []);
      lsSet(LS.MODELS, state.models);
      lsSet(LS.MODELS_TS, Date.now());
      return state.models;
    } catch (err) {
      if (cached) { state.models = cached; return cached; }
      console.warn('Failed to fetch models:', err);
      return [];
    }
  }

  function getModelById(id) {
    return state.models.find(m => m.id === id) || null;
  }

  function modelCan(model, feature) {
    if (!model) return false;
    const params = model.supported_parameters || [];
    const arch = model.architecture || {};
    const inMods = arch.input_modalities || arch.modality?.split(',').map(s => s.trim()) || [];
    const outMods = arch.output_modalities || [];
    switch (feature) {
      case 'thinking':   return params.includes('reasoning') || params.includes('include_reasoning') || params.includes('thinking');
      case 'vision':     return inMods.includes('image') || inMods.includes('image+text');
      case 'imageGen':   return outMods.includes('image');
      case 'webSearch':  return !!(model.pricing && model.pricing.web_search);
      case 'free':       return model.pricing && model.pricing.prompt === '0' && model.pricing.completion === '0';
      case 'audio':      return inMods.includes('audio');
      case 'video':      return inMods.includes('video');
      default:           return false;
    }
  }

  function modelCapBadges(model) {
    const caps = [];
    if (modelCan(model, 'thinking'))  caps.push('<span class="cap-badge thinking" title="Thinking/Reasoning">🧠</span>');
    if (modelCan(model, 'imageGen'))  caps.push('<span class="cap-badge imagegen" title="Image Generation">🖼</span>');
    if (modelCan(model, 'webSearch')) caps.push('<span class="cap-badge search" title="Web Search">🔍</span>');
    if (modelCan(model, 'vision'))    caps.push('<span class="cap-badge vision" title="Vision">👁</span>');
    if (modelCan(model, 'free'))      caps.push('<span class="cap-badge free" title="Free">FREE</span>');
    return caps.join('');
  }

  function getProviderFromId(modelId) {
    return (modelId || '').split('/')[0] || 'unknown';
  }

  function formatContextLength(n) {
    if (!n) return '';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  }

  function getProviderColorClass(provider) {
    const known = ['anthropic', 'openai', 'google', 'mistral', 'deepseek', 'xai', 'qwen'];
    return known.includes(provider.toLowerCase()) ? `provider-${provider.toLowerCase()}` : 'provider-default';
  }

  function groupModelsByProvider(models) {
    const groups = {};
    for (const m of models) {
      const provider = getProviderFromId(m.id);
      if (!groups[provider]) groups[provider] = [];
      groups[provider].push(m);
    }
    return groups;
  }

  function renderModelDropdown(containerEl, searchInputEl, onSelect, currentModelId) {
    let filteredModels = [...state.models];

    function buildList(query = '') {
      containerEl.innerHTML = '';
      const q = query.toLowerCase();
      const filtered = filteredModels.filter(m =>
        !q || (m.name || m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
      );

      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:16px;text-align:center;color:var(--text-tertiary);font-size:12px';
        empty.textContent = 'No models found';
        containerEl.appendChild(empty);
        return;
      }

      const groups = groupModelsByProvider(filtered);
      const frag = document.createDocumentFragment();
      let focusableItems = [];

      for (const [provider, models] of Object.entries(groups)) {
        const labelEl = document.createElement('div');
        labelEl.className = 'model-group-label';
        labelEl.innerHTML = `<span class="provider-dot ${getProviderColorClass(provider)}"></span>${provider}`;
        frag.appendChild(labelEl);

        for (const model of models) {
          const item = document.createElement('div');
          item.className = 'model-item' + (model.id === currentModelId ? ' selected' : '');
          item.dataset.modelId = model.id;
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', model.id === currentModelId ? 'true' : 'false');
          item.setAttribute('tabindex', '0');

          const ctx = model.context_length ? formatContextLength(model.context_length) : '';
          item.innerHTML = `
            <span class="provider-dot ${getProviderColorClass(provider)}"></span>
            <span class="model-item-name">${escapeHtml(model.name || model.id)}</span>
            ${ctx ? `<span class="model-item-ctx">${ctx}</span>` : ''}
            <span class="model-item-caps">${modelCapBadges(model)}</span>
          `;
          item.addEventListener('click', () => onSelect(model.id));
          item.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(model.id); }
          });
          frag.appendChild(item);
          focusableItems.push(item);
        }
      }
      containerEl.appendChild(frag);

      // Keyboard navigation within the list
      containerEl._focusableItems = focusableItems;
    }

    buildList();

    if (searchInputEl) {
      searchInputEl.addEventListener('input', debounce(() => buildList(searchInputEl.value), 150));
      searchInputEl.addEventListener('keydown', e => {
        if (!containerEl._focusableItems) return;
        const items = containerEl._focusableItems;
        const focused = containerEl.querySelector('.model-item.focused');
        let idx = focused ? items.indexOf(focused) : -1;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (focused) focused.classList.remove('focused');
          idx = Math.min(idx + 1, items.length - 1);
          items[idx]?.classList.add('focused');
          items[idx]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (focused) focused.classList.remove('focused');
          idx = Math.max(idx - 1, 0);
          items[idx]?.classList.add('focused');
          items[idx]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
          if (focused) { e.preventDefault(); focused.click(); }
        }
      });
    }
  }

  function updateSettingsModelPicker(btnId, labelId, dropdownId, type) {
    const btn = document.getElementById(btnId);
    const label = document.getElementById(labelId);
    const ddEl = document.getElementById(dropdownId);
    if (!btn || !label || !ddEl) return;

    const current = type === 'chat' ? state.settings.chat_model : state.settings.title_model;
    const model = getModelById(current);
    label.textContent = model ? (model.name || model.id) : (current || 'Select model');

    const listEl = ddEl.querySelector('.dropdown-list');
    const searchEl = ddEl.querySelector('.dropdown-search');
    if (!listEl) return;

    renderModelDropdown(listEl, searchEl, (modelId) => {
      if (type === 'chat') {
        state.settings.chat_model = modelId;
        const m = getModelById(modelId);
        label.textContent = m ? (m.name || m.id) : modelId;
      } else {
        state.settings.title_model = modelId;
        const m = getModelById(modelId);
        label.textContent = m ? (m.name || m.id) : modelId;
      }
      ddEl.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }, current);

    btn.onclick = (e) => {
      e.stopPropagation();
      const isOpen = !ddEl.classList.contains('hidden');
      closeDropdowns();
      if (!isOpen) {
        ddEl.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        searchEl?.focus();
        state.currentDropdown = ddEl;
      }
    };
  }

  function renderAllModelDropdowns() {
    // Main header dropdown
    const headerList = document.getElementById('model-list');
    const headerSearch = document.getElementById('model-search');
    if (headerList) {
      renderModelDropdown(headerList, headerSearch, (modelId) => {
        state.settings.chat_model = modelId;
        const model = getModelById(modelId);
        const label = document.getElementById('model-selector-label');
        if (label) label.textContent = model ? (model.name || model.id) : modelId;
        document.getElementById('model-dropdown')?.classList.add('hidden');
        document.getElementById('model-selector-btn')?.setAttribute('aria-expanded', 'false');
        updateCapabilityButtons();
        updateDetailsPanel();
      }, state.settings.chat_model);
    }
    // Settings pickers
    updateSettingsModelPicker('settings-chat-model-btn', 'settings-chat-model-label', 'settings-chat-model-dropdown', 'chat');
    updateSettingsModelPicker('settings-title-model-btn', 'settings-title-model-label', 'settings-title-model-dropdown', 'title');

    // Update header label
    const model = getModelById(state.settings.chat_model);
    const label = document.getElementById('model-selector-label');
    if (label) label.textContent = model ? (model.name || model.id) : (state.settings.chat_model || 'Select Model');
  }

  function updateCapabilityButtons() {
    const model = getModelById(state.settings.chat_model);
    const thinkingBtn = document.getElementById('thinking-btn');
    const websearchBtn = document.getElementById('websearch-btn');

    if (thinkingBtn) {
      const canThink = modelCan(model, 'thinking');
      thinkingBtn.style.opacity = canThink ? '1' : '0.4';
      thinkingBtn.title = canThink ? 'Thinking Mode (Ctrl+Shift+T)' : 'Thinking not supported by this model';
    }
    if (websearchBtn) {
      const canSearch = modelCan(model, 'webSearch');
      websearchBtn.style.opacity = canSearch ? '1' : '0.4';
      websearchBtn.title = canSearch ? 'Web Search' : 'Web search not supported by this model';
    }
  }

  function switchModel(modelId) {
    state.settings.chat_model = modelId;
    const model = getModelById(modelId);
    const label = document.getElementById('model-selector-label');
    if (label) label.textContent = model ? (model.name || model.id) : modelId;
    updateCapabilityButtons();
    updateDetailsPanel();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 5: CONVERSATION MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  function loadConversations() {
    state.conversations = lsGet(LS.CONVERSATIONS) || [];
  }

  function saveConversations() {
    lsSet(LS.CONVERSATIONS, state.conversations);
  }

  function createConversation() {
    const conv = {
      id: uuid(),
      title: 'New Conversation',
      created_at: Date.now(),
      updated_at: Date.now(),
      model: state.settings.chat_model,
      system_prompt: state.settings.system_prompt,
      messages: [],
      pinned: false,
      tags: [],
    };
    state.conversations.unshift(conv);
    saveConversations();
    return conv;
  }

  function getActiveConversation() {
    return state.conversations.find(c => c.id === state.activeConvId) || null;
  }

  function setActiveConversation(id) {
    state.activeConvId = id;
    lsSet(LS.ACTIVE_CONV, id);
    renderMessages();
    renderSidebar();
    updateHeaderForConversation();
    updateDetailsPanel();
  }

  function addMessageToConversation(convId, message) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.messages.push(message);
    conv.updated_at = Date.now();
    saveConversations();
  }

  function deleteConversation(id) {
    state.conversations = state.conversations.filter(c => c.id !== id);
    if (state.activeConvId === id) {
      const next = state.conversations[0];
      state.activeConvId = next ? next.id : null;
    }
    saveConversations();
    renderSidebar();
    if (state.activeConvId) {
      setActiveConversation(state.activeConvId);
    } else {
      renderMessages();
      updateHeaderForConversation();
    }
  }

  function duplicateConversation(id) {
    const orig = state.conversations.find(c => c.id === id);
    if (!orig) return;
    const copy = JSON.parse(JSON.stringify(orig));
    copy.id = uuid();
    copy.title = orig.title + ' (copy)';
    copy.created_at = Date.now();
    copy.updated_at = Date.now();
    const idx = state.conversations.findIndex(c => c.id === id);
    state.conversations.splice(idx + 1, 0, copy);
    saveConversations();
    renderSidebar();
  }

  function pinConversation(id) {
    const conv = state.conversations.find(c => c.id === id);
    if (!conv) return;
    conv.pinned = !conv.pinned;
    saveConversations();
    renderSidebar();
  }

  function renameConversation(id, newTitle) {
    const conv = state.conversations.find(c => c.id === id);
    if (!conv) return;
    conv.title = newTitle.trim() || 'Untitled';
    saveConversations();
  }

  function newConversation() {
    const conv = createConversation();
    state.activeConvId = conv.id;
    lsSet(LS.ACTIVE_CONV, conv.id);
    renderSidebar();
    renderMessages();
    updateHeaderForConversation();
    document.getElementById('message-input')?.focus();
  }

  function clearChat() {
    const conv = getActiveConversation();
    if (!conv || !conv.messages.length) return;
    showConfirm('Clear all messages in this conversation?', () => {
      conv.messages = [];
      conv.updated_at = Date.now();
      saveConversations();
      renderMessages();
    });
  }

  function clearAllConversations() {
    state.conversations = [];
    state.activeConvId = null;
    lsDel(LS.ACTIVE_CONV);
    saveConversations();
    renderSidebar();
    renderMessages();
    updateHeaderForConversation();
  }

  function updateHeaderForConversation() {
    const conv = getActiveConversation();
    const titleDisplay = document.getElementById('chat-title-display');
    const titleInput = document.getElementById('chat-title-input');
    if (titleDisplay) {
      titleDisplay.textContent = conv ? conv.title : 'New Conversation';
      titleDisplay.classList.remove('hidden');
    }
    if (titleInput) {
      titleInput.classList.add('hidden');
    }
    // Update model selector
    const label = document.getElementById('model-selector-label');
    if (label) {
      const model = getModelById(state.settings.chat_model);
      label.textContent = model ? (model.name || model.id) : (state.settings.chat_model || 'Select Model');
    }
  }

  function startTitleEdit() {
    const conv = getActiveConversation();
    if (!conv) return;
    const titleDisplay = document.getElementById('chat-title-display');
    const titleInput = document.getElementById('chat-title-input');
    if (!titleDisplay || !titleInput) return;
    titleInput.value = conv.title;
    titleDisplay.classList.add('hidden');
    titleInput.classList.remove('hidden');
    titleInput.focus();
    titleInput.select();

    function finishEdit() {
      const newTitle = titleInput.value.trim() || conv.title;
      renameConversation(conv.id, newTitle);
      titleDisplay.textContent = newTitle;
      titleDisplay.classList.remove('hidden');
      titleInput.classList.add('hidden');
      renderSidebar();
    }

    titleInput.onblur = finishEdit;
    titleInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finishEdit(); }
      if (e.key === 'Escape') { titleDisplay.classList.remove('hidden'); titleInput.classList.add('hidden'); }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 6: SIDEBAR RENDERING
  // ─────────────────────────────────────────────────────────────────────────────

  function renderSidebar() {
    const list = document.getElementById('conv-list');
    const empty = document.getElementById('conv-empty');
    if (!list) return;

    const searchEl = document.getElementById('sidebar-search');
    const search = (searchEl ? searchEl.value : '').toLowerCase();

    let convs = state.conversations.filter(c =>
      !search ||
      c.title.toLowerCase().includes(search) ||
      c.messages.some(m => {
        const txt = typeof m.content === 'string' ? m.content :
          (Array.isArray(m.content) ? (m.content.find(p => p.type === 'text')?.text || '') : '');
        return txt.toLowerCase().includes(search);
      })
    );

    if (!convs.length) {
      list.innerHTML = '';
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');

    // Sort: pinned first, then by updated_at desc
    convs.sort((a, b) => {
      if (a.pinned !== b.pinned) return b.pinned - a.pinned;
      return b.updated_at - a.updated_at;
    });

    const pinned = convs.filter(c => c.pinned);
    const unpinned = convs.filter(c => !c.pinned);

    function timeGroup(ts) {
      const diff = Date.now() - ts;
      if (diff < 86_400_000)   return 'Today';
      if (diff < 172_800_000)  return 'Yesterday';
      if (diff < 604_800_000)  return 'This Week';
      if (diff < 2_592_000_000) return 'This Month';
      return 'Older';
    }

    const frag = document.createDocumentFragment();

    // Pinned section
    if (pinned.length) {
      const lbl = document.createElement('div');
      lbl.className = 'conv-group-label';
      lbl.textContent = 'Pinned';
      frag.appendChild(lbl);
      for (const c of pinned) frag.appendChild(buildConvItem(c));
    }

    // Grouped unpinned
    let lastGroup = null;
    for (const c of unpinned) {
      const grp = timeGroup(c.updated_at);
      if (grp !== lastGroup) {
        const lbl = document.createElement('div');
        lbl.className = 'conv-group-label';
        lbl.textContent = grp;
        frag.appendChild(lbl);
        lastGroup = grp;
      }
      frag.appendChild(buildConvItem(c));
    }

    list.innerHTML = '';
    list.appendChild(frag);
  }

  function buildConvItem(conv) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === state.activeConvId ? ' active' : '');
    item.dataset.convId = conv.id;

    item.innerHTML = `
      ${conv.pinned ? '<span class="conv-item-pin-icon">📌</span>' : ''}
      <span class="conv-item-title">${escapeHtml(conv.title)}</span>
      <span class="conv-item-time">${relativeTime(conv.updated_at)}</span>
      <div class="conv-item-actions">
        <button class="conv-action-btn" data-action="pin" title="${conv.pinned ? 'Unpin' : 'Pin'}">
          ${conv.pinned ? '📌' : '📍'}
        </button>
        <button class="conv-action-btn" data-action="rename" title="Rename">✏️</button>
        <button class="conv-action-btn" data-action="duplicate" title="Duplicate">📋</button>
        <button class="conv-action-btn danger" data-action="delete" title="Delete">🗑️</button>
      </div>
    `;

    item.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action) {
        e.stopPropagation();
        handleConvAction(action, conv.id);
        return;
      }
      setActiveConversation(conv.id);
      // Close sidebar on mobile
      if (window.innerWidth <= 768) closeMobileSidebar();
    });

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showConvContextMenu(e.clientX, e.clientY, conv.id);
    });

    return item;
  }

  function handleConvAction(action, convId) {
    switch (action) {
      case 'pin': pinConversation(convId); break;
      case 'rename': startInlineRename(convId); break;
      case 'duplicate': duplicateConversation(convId); showToast('Conversation duplicated', 'success'); break;
      case 'delete':
        showConfirm('Delete this conversation?', () => deleteConversation(convId));
        break;
    }
  }

  function startInlineRename(convId) {
    const item = document.querySelector(`.conv-item[data-conv-id="${convId}"]`);
    if (!item) return;
    const titleEl = item.querySelector('.conv-item-title');
    const conv = state.conversations.find(c => c.id === convId);
    if (!titleEl || !conv) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = conv.title;
    input.style.cssText = 'width:100%;background:var(--bg-4);border:1px solid var(--border-focus);border-radius:3px;color:var(--text-primary);padding:2px 4px;font-size:13px;font-family:var(--font-body);outline:none';
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    function finish() {
      const val = input.value.trim() || conv.title;
      renameConversation(convId, val);
      if (convId === state.activeConvId) {
        const td = document.getElementById('chat-title-display');
        if (td) td.textContent = val;
      }
      renderSidebar();
    }
    input.onblur = finish;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(); }
      if (e.key === 'Escape') renderSidebar();
    };
  }

  // Context menu for right-click on conversation
  function showConvContextMenu(x, y, convId) {
    removeContextMenu();
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    const menu = document.createElement('div');
    menu.id = 'context-menu';
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--border-radius);box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:1000;min-width:160px;padding:4px;`;
    const actions = [
      { label: conv.pinned ? '📌 Unpin' : '📍 Pin', action: 'pin' },
      { label: '✏️ Rename', action: 'rename' },
      { label: '📋 Duplicate', action: 'duplicate' },
      { label: '🗑️ Delete', action: 'delete', danger: true },
    ];
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.textContent = a.label;
      btn.style.cssText = `display:block;width:100%;background:transparent;border:none;color:${a.danger ? 'var(--danger)' : 'var(--text-primary)'};font-size:13px;font-family:var(--font-body);padding:6px 10px;text-align:left;cursor:pointer;border-radius:4px;`;
      btn.onmouseenter = () => { btn.style.background = 'var(--bg-3)'; };
      btn.onmouseleave = () => { btn.style.background = 'transparent'; };
      btn.onclick = () => { removeContextMenu(); handleConvAction(a.action, convId); };
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', removeContextMenu, { once: true });
    }, 10);

    // Keep within viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
  }

  function removeContextMenu() {
    document.getElementById('context-menu')?.remove();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 7: MESSAGE RENDERING
  // ─────────────────────────────────────────────────────────────────────────────

  function renderMessages() {
    const container = document.getElementById('messages-container');
    const emptyState = document.getElementById('empty-state');
    if (!container) return;

    const conv = getActiveConversation();

    if (!conv || conv.messages.filter(m => m.role !== 'system').length === 0) {
      const existingEmpty = container.querySelector('#empty-state');
      if (!existingEmpty) {
        container.innerHTML = '';
        if (emptyState) container.appendChild(emptyState);
      }
      if (emptyState) emptyState.classList.remove('hidden');
      updateNoKeyBanner();
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    // Remove empty state from container but keep it in DOM
    const existingEmpty = container.querySelector('#empty-state');
    if (existingEmpty) existingEmpty.remove();

    container.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (const msg of conv.messages) {
      if (msg.role === 'system') continue;
      frag.appendChild(createMessageEl(msg));
    }
    container.appendChild(frag);
    scrollToBottom(false);
  }

  function createMessageEl(msg) {
    const el = document.createElement('div');
    el.className = `message ${msg.role}`;
    el.dataset.msgId = msg.id;

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = msg.role === 'user' ? '👤' : '🤖';

    // Content wrapper
    const contentWrap = document.createElement('div');
    contentWrap.className = 'message-content-wrap';

    // Thinking block
    if (msg.thinking && msg.thinking.length > 0) {
      contentWrap.appendChild(createThinkingBlock(msg.thinking, msg.thinkingDuration));
    }

    // Generated image
    if (msg.image_url) {
      contentWrap.appendChild(createImageOutput(msg.image_url));
    }

    // Attached user image
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imgPart = msg.content.find(p => p.type === 'image_url');
      if (imgPart) {
        const img = document.createElement('img');
        img.src = imgPart.image_url.url;
        img.className = 'user-attached-image';
        img.addEventListener('click', () => openLightbox(imgPart.image_url.url));
        contentWrap.appendChild(img);
      }
    }

    // Text content
    const textEl = document.createElement('div');
    textEl.className = msg.role === 'assistant' ? 'message-content md-content' : 'message-content user-content';

    if (msg.role === 'assistant') {
      textEl.innerHTML = renderMarkdown(typeof msg.content === 'string' ? msg.content : '');
      renderKatex(textEl);
    } else {
      const text = typeof msg.content === 'string' ? msg.content
        : (Array.isArray(msg.content) ? (msg.content.find(p => p.type === 'text')?.text || '') : '');
      textEl.textContent = text;
    }

    contentWrap.appendChild(textEl);

    // Message footer
    const footer = document.createElement('div');
    footer.className = 'message-footer';

    if (msg.timestamp) {
      const ts = document.createElement('span');
      ts.className = 'message-timestamp';
      ts.title = new Date(msg.timestamp).toLocaleString();
      ts.textContent = relativeTime(msg.timestamp);
      footer.appendChild(ts);
    }

    if (msg.role === 'assistant' && msg.tokens && state.settings.show_token_count) {
      const total = (msg.tokens.input || 0) + (msg.tokens.output || 0);
      if (total > 0) {
        const tc = document.createElement('span');
        tc.className = 'token-count';
        tc.textContent = `~${total.toLocaleString()} tokens`;
        footer.appendChild(tc);
      }
    }

    if (msg.role === 'assistant' && msg.model) {
      const mb = document.createElement('span');
      mb.className = 'message-model-badge';
      mb.textContent = msg.model.split('/').pop();
      footer.appendChild(mb);
    }

    contentWrap.appendChild(footer);
    contentWrap.appendChild(createMessageActions(msg));

    el.appendChild(avatar);
    el.appendChild(contentWrap);
    return el;
  }

  function createMessageActions(msg) {
    const wrap = document.createElement('div');
    wrap.className = 'message-actions';

    const actions = [];

    // Copy
    actions.push({ label: 'Copy', title: 'Copy text', fn: () => {
      const text = typeof msg.content === 'string' ? msg.content
        : (Array.isArray(msg.content) ? (msg.content.find(p => p.type === 'text')?.text || '') : '');
      navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard', 'success'));
    }});

    if (msg.role === 'user') {
      actions.push({ label: 'Edit', title: 'Edit and resend', fn: () => editMessage(msg) });
    }

    if (msg.role === 'assistant') {
      actions.push({ label: 'Retry', title: 'Regenerate response', fn: () => regenerateMessage(msg) });
    }

    actions.push({ label: 'Del', title: 'Delete message', fn: () => deleteMessage(msg.id) });

    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'msg-action-btn';
      btn.textContent = a.label;
      btn.title = a.title;
      btn.addEventListener('click', a.fn);
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function editMessage(msg) {
    const conv = getActiveConversation();
    if (!conv) return;
    const text = typeof msg.content === 'string' ? msg.content
      : (Array.isArray(msg.content) ? (msg.content.find(p => p.type === 'text')?.text || '') : '');
    const input = document.getElementById('message-input');
    if (input) {
      input.value = text;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 240) + 'px';
      input.focus();
      updateTokenCounter(text);
    }
    // Remove the message and everything after it
    const idx = conv.messages.findIndex(m => m.id === msg.id);
    if (idx !== -1) {
      conv.messages.splice(idx);
      saveConversations();
      renderMessages();
    }
  }

  function deleteMessage(msgId) {
    const conv = getActiveConversation();
    if (!conv) return;
    conv.messages = conv.messages.filter(m => m.id !== msgId);
    saveConversations();
    renderMessages();
  }

  function regenerateMessage(msg) {
    const conv = getActiveConversation();
    if (!conv || state.isStreaming) return;
    // Find the preceding user message
    const idx = conv.messages.findIndex(m => m.id === msg.id);
    const userMsg = idx > 0 ? conv.messages.slice(0, idx).reverse().find(m => m.role === 'user') : null;
    if (!userMsg) return;

    // Remove the assistant message and re-trigger
    conv.messages = conv.messages.filter(m => m.id !== msg.id);
    saveConversations();
    renderMessages();

    // Trigger a new response without re-adding the user message
    sendMessageInternal(conv);
  }

  function createThinkingBlock(thinkingText, duration) {
    const details = document.createElement('details');
    details.className = 'thinking-block';
    const summary = document.createElement('summary');
    const dur = duration ? `Thought for ${(duration / 1000).toFixed(1)}s` : 'Thinking';
    summary.innerHTML = `<span>${dur}</span> <span style="margin-left:auto;font-size:10px;color:var(--text-tertiary)">▶ click to expand</span>`;
    const content = document.createElement('div');
    content.className = 'thinking-content';
    content.textContent = thinkingText;
    details.appendChild(summary);
    details.appendChild(content);
    return details;
  }

  function editLastUserMessage() {
    const conv = getActiveConversation();
    if (!conv) return;
    const userMsgs = conv.messages.filter(m => m.role === 'user');
    if (!userMsgs.length) return;
    const last = userMsgs[userMsgs.length - 1];
    editMessage(last);
  }

  function updateNoKeyBanner() {
    const banner = document.getElementById('no-key-banner');
    if (banner) banner.classList.toggle('hidden', !!getApiKey());
  }

  function renderStreamingPlaceholder(msgId) {
    const container = document.getElementById('messages-container');
    const emptyState = container.querySelector('#empty-state');
    if (emptyState) emptyState.remove();

    const el = document.createElement('div');
    el.className = 'message assistant';
    el.dataset.msgId = msgId;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '🤖';

    const contentWrap = document.createElement('div');
    contentWrap.className = 'message-content-wrap';

    const thinkingWrap = document.createElement('div');
    thinkingWrap.className = 'streaming-thinking-wrap';

    const textEl = document.createElement('div');
    textEl.className = 'message-content md-content';

    const indicator = document.createElement('div');
    indicator.className = 'streaming-indicator';
    indicator.innerHTML = `<span class="streaming-dot"></span><span class="streaming-dot"></span><span class="streaming-dot"></span>`;
    textEl.appendChild(indicator);

    contentWrap.appendChild(thinkingWrap);
    contentWrap.appendChild(textEl);
    el.appendChild(avatar);
    el.appendChild(contentWrap);
    container.appendChild(el);

    if (isNearBottom(200)) scrollToBottom();
    return el;
  }

  function updateStreamingThinking(msgEl, thinkingText) {
    const wrap = msgEl.querySelector('.streaming-thinking-wrap');
    if (!wrap) return;
    let details = wrap.querySelector('.thinking-block');
    if (!details) {
      details = document.createElement('details');
      details.className = 'thinking-block';
      details.setAttribute('open', '');
      const summary = document.createElement('summary');
      summary.textContent = 'Thinking…';
      const content = document.createElement('div');
      content.className = 'thinking-content';
      details.appendChild(summary);
      details.appendChild(content);
      wrap.appendChild(details);
    }
    const content = details.querySelector('.thinking-content');
    if (content) content.textContent = thinkingText;
    if (isNearBottom(200)) scrollToBottom();
  }

  function updateStreamingContent(msgEl, text) {
    const textEl = msgEl.querySelector('.message-content');
    if (!textEl) return;
    textEl.innerHTML = renderMarkdown(text) + '<span class="typing-cursor"></span>';
    renderKatex(textEl);
    if (isNearBottom(200)) scrollToBottom();
  }

  function finalizeStreamedMessage(msgEl, text, thinking, thinkingDuration) {
    const textEl = msgEl.querySelector('.message-content');
    if (textEl) {
      textEl.innerHTML = renderMarkdown(text || '');
      renderKatex(textEl);
    }

    // Update thinking block
    const thinkWrap = msgEl.querySelector('.streaming-thinking-wrap');
    if (thinkWrap) {
      thinkWrap.innerHTML = '';
      if (thinking && thinking.length > 0) {
        thinkWrap.appendChild(createThinkingBlock(thinking, thinkingDuration));
      }
    }

    // Add footer
    const conv = getActiveConversation();
    const msg = conv?.messages.find(m => m.id === msgEl.dataset.msgId);
    if (msg) {
      const footer = document.createElement('div');
      footer.className = 'message-footer';
      const ts = document.createElement('span');
      ts.className = 'message-timestamp';
      ts.title = new Date(msg.timestamp).toLocaleString();
      ts.textContent = relativeTime(msg.timestamp);
      footer.appendChild(ts);

      if (state.settings.show_token_count && msg.tokens) {
        const total = (msg.tokens.input || 0) + (msg.tokens.output || 0);
        if (total > 0) {
          const tc = document.createElement('span');
          tc.className = 'token-count';
          tc.textContent = `~${total.toLocaleString()} tokens`;
          footer.appendChild(tc);
        }
      }

      if (msg.model) {
        const mb = document.createElement('span');
        mb.className = 'message-model-badge';
        mb.textContent = msg.model.split('/').pop();
        footer.appendChild(mb);
      }

      const contentWrap = msgEl.querySelector('.message-content-wrap');
      if (contentWrap) {
        contentWrap.appendChild(footer);
        contentWrap.appendChild(createMessageActions(msg));
      }
    }
  }

  function showErrorMessage(msgEl, errorText) {
    const textEl = msgEl?.querySelector('.message-content');
    if (textEl) {
      textEl.innerHTML = `<div class="error-message">⚠ ${escapeHtml(errorText)}</div>`;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 8: MARKDOWN & CODE RENDERING
  // ─────────────────────────────────────────────────────────────────────────────

  function setupMarked() {
    if (typeof marked === 'undefined') return;

    const renderer = new marked.Renderer();

    renderer.code = (code, language) => {
      const lang = (language || 'plaintext').trim();
      let highlighted;
      try {
        if (typeof hljs !== 'undefined') {
          if (hljs.getLanguage(lang)) {
            highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          } else {
            highlighted = hljs.highlightAuto(code).value;
          }
        } else {
          highlighted = escapeHtml(code);
        }
      } catch {
        highlighted = escapeHtml(code);
      }

      let encodedCode;
      try {
        encodedCode = btoa(unescape(encodeURIComponent(code)));
      } catch {
        encodedCode = btoa(code);
      }

      return `<div class="code-block">
        <div class="code-header">
          <span class="code-lang">${escapeHtml(lang)}</span>
          <button class="copy-code-btn" data-code="${encodedCode}">Copy</button>
        </div>
        <pre><code class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>
      </div>`;
    };

    renderer.link = (href, title, text) =>
      `<a href="${href}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeHtml(title)}"` : ''}>${text} ↗</a>`;

    marked.setOptions({ renderer, breaks: true, gfm: true });
  }

  function renderMarkdown(text) {
    if (!text) return '';
    try {
      return typeof marked !== 'undefined' ? marked.parse(text) : escapeHtml(text).replace(/\n/g, '<br>');
    } catch {
      return escapeHtml(text).replace(/\n/g, '<br>');
    }
  }

  function renderKatex(el) {
    if (typeof renderMathInElement !== 'function') return;
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
      });
    } catch {}
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 9: STREAMING & API CALLS
  // ─────────────────────────────────────────────────────────────────────────────

  async function sendMessage(userText, attachedImageDataUrl = null) {
    if (!userText.trim() && !attachedImageDataUrl) return;
    if (state.isStreaming) return;
    if (!getApiKey()) {
      showToast('Add your API key in Settings first', 'error');
      openSettings('api');
      return;
    }

    let conv = getActiveConversation();
    if (!conv) {
      conv = createConversation();
      state.activeConvId = conv.id;
      lsSet(LS.ACTIVE_CONV, conv.id);
    }

    const model = getModelById(state.settings.chat_model);

    // Build user message content
    let userContent;
    if (attachedImageDataUrl && modelCan(model, 'vision')) {
      userContent = [
        { type: 'image_url', image_url: { url: attachedImageDataUrl } },
        { type: 'text', text: userText.trim() }
      ];
    } else {
      userContent = userText.trim();
    }

    const userMsg = {
      id: uuid(),
      role: 'user',
      content: userContent,
      timestamp: Date.now()
    };

    addMessageToConversation(conv.id, userMsg);

    // Clear empty state and add user message to DOM
    const container = document.getElementById('messages-container');
    const emptyState = document.getElementById('empty-state');
    if (emptyState) {
      emptyState.classList.add('hidden');
      const inContainer = container?.querySelector('#empty-state');
      if (inContainer) inContainer.remove();
    }

    if (container) container.appendChild(createMessageEl(userMsg));
    if (isNearBottom(200)) scrollToBottom();

    clearInput();
    renderSidebar();

    // Create assistant placeholder
    const assistantMsgId = uuid();
    const assistantMsg = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      thinking: '',
      model: state.settings.chat_model,
      tokens: { input: 0, output: 0 },
      timestamp: Date.now()
    };
    addMessageToConversation(conv.id, assistantMsg);

    const msgEl = renderStreamingPlaceholder(assistantMsgId);

    await sendMessageInternal(conv, assistantMsgId, msgEl, userContent);
  }

  async function sendMessageInternal(conv, assistantMsgId, msgEl, originalUserContent) {
    // If called from regenerate, find the placeholder
    if (!assistantMsgId || !msgEl) {
      assistantMsgId = uuid();
      const assistantMsg = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        thinking: '',
        model: state.settings.chat_model,
        tokens: { input: 0, output: 0 },
        timestamp: Date.now()
      };
      addMessageToConversation(conv.id, assistantMsg);
      msgEl = renderStreamingPlaceholder(assistantMsgId);
    }

    const model = getModelById(state.settings.chat_model);

    // Build messages array for API
    const messages = [];
    const systemPrompt = conv.system_prompt || state.settings.system_prompt;
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    for (const m of conv.messages) {
      if (m.id === assistantMsgId) continue;
      if (m.role === 'system') continue;
      messages.push({ role: m.role, content: m.content });
    }

    const payload = {
      model: state.settings.chat_model,
      messages,
      max_tokens: state.settings.max_tokens,
      temperature: state.settings.temperature,
      stream: true,
    };

    if (state.thinkingActive && modelCan(model, 'thinking')) {
      payload.include_reasoning = true;
      payload.reasoning = { max_tokens: state.settings.thinking_budget };
    }

    if (state.webSearchActive && modelCan(model, 'webSearch')) {
      payload.tools = [{ type: 'web_search' }];
    }

    state.isStreaming = true;
    state.abortController = new AbortController();
    setStreamingUI(true);

    let accText = '';
    let accThinking = '';
    let thinkingStart = null;
    let thinkingDuration = 0;
    let inThinking = false;

    try {
      const res = await fetchWithCorsFallback(`${getBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getApiKey()}`
        },
        body: JSON.stringify(payload),
        signal: state.abortController.signal,
      });

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const errData = await res.json();
          errMsg = errData.error?.message || errData.message || errMsg;
        } catch {}
        throw new Error(errMsg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const chunk = JSON.parse(raw);
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Handle reasoning/thinking
            if (delta.reasoning !== undefined && delta.reasoning !== null) {
              if (!inThinking) { inThinking = true; thinkingStart = Date.now(); }
              accThinking += delta.reasoning;
              updateStreamingThinking(msgEl, accThinking);
            }

            if (delta.content) {
              if (inThinking && !thinkingDuration) {
                thinkingDuration = Date.now() - (thinkingStart || Date.now());
                inThinking = false;
              }
              accText += delta.content;
              updateStreamingContent(msgEl, accText);
            }

            // Usage data
            if (chunk.usage) {
              const finalMsgNow = conv.messages.find(m => m.id === assistantMsgId);
              if (finalMsgNow) {
                finalMsgNow.tokens = {
                  input: chunk.usage.prompt_tokens || 0,
                  output: chunk.usage.completion_tokens || 0
                };
              }
            }
          } catch {}
        }
      }

      // Finalize
      const finalMsg = conv.messages.find(m => m.id === assistantMsgId);
      if (finalMsg) {
        finalMsg.content = accText;
        finalMsg.thinking = accThinking;
        finalMsg.thinkingDuration = thinkingDuration;
        // Estimate tokens if not provided
        if (!finalMsg.tokens.output && accText) {
          finalMsg.tokens.output = Math.ceil(accText.length / 4);
        }
        saveConversations();
      }

      finalizeStreamedMessage(msgEl, accText, accThinking, thinkingDuration);
      renderSidebar();

      // Auto-title on first exchange
      const userMessages = conv.messages.filter(m => m.role === 'user');
      if (userMessages.length === 1 && state.settings.auto_title && conv.title === 'New Conversation') {
        const firstUserText = typeof userMessages[0].content === 'string'
          ? userMessages[0].content
          : (userMessages[0].content.find?.(p => p.type === 'text')?.text || '');
        autoGenerateTitle(conv.id, firstUserText);
      }

      updateDetailsPanel();

    } catch (err) {
      if (err.name === 'AbortError') {
        const finalMsg = conv.messages.find(m => m.id === assistantMsgId);
        if (finalMsg) {
          finalMsg.content = accText;
          finalMsg.thinking = accThinking;
          finalMsg.thinkingDuration = thinkingDuration;
          saveConversations();
        }
        finalizeStreamedMessage(msgEl, accText, accThinking, thinkingDuration);
        showToast('Generation stopped', 'info');
      } else {
        showErrorMessage(msgEl, err.message);
        // Remove failed placeholder from conversation
        const failedIdx = conv.messages.findIndex(m => m.id === assistantMsgId);
        if (failedIdx !== -1) conv.messages.splice(failedIdx, 1);
        saveConversations();
        showToast(`Error: ${err.message}`, 'error');
      }
    } finally {
      state.isStreaming = false;
      state.abortController = null;
      setStreamingUI(false);
    }
  }

  function setStreamingUI(streaming) {
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const input = document.getElementById('message-input');
    if (sendBtn) sendBtn.classList.toggle('hidden', streaming);
    if (stopBtn) stopBtn.classList.toggle('hidden', !streaming);
    if (input) input.disabled = streaming;
  }

  function stopGeneration() {
    if (state.abortController) state.abortController.abort();
  }

  function clearInput() {
    const input = document.getElementById('message-input');
    if (input) {
      input.value = '';
      input.style.height = 'auto';
      updateTokenCounter('');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 10: AUTO TITLE GENERATION
  // ─────────────────────────────────────────────────────────────────────────────

  async function autoGenerateTitle(convId, firstUserMessage) {
    if (!getApiKey() || !firstUserMessage.trim()) return;
    try {
      const res = await fetchWithCorsFallback(`${getBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getApiKey()}`
        },
        body: JSON.stringify({
          model: state.settings.title_model || 'openai/gpt-4o-mini',
          messages: [{
            role: 'user',
            content: `Write a short 3-6 word title for a conversation starting with: "${firstUserMessage.slice(0, 200)}". Reply with ONLY the title, no quotes, no period.`
          }],
          max_tokens: 30,
          stream: false,
          temperature: 0.5,
        })
      });
      if (!res.ok) return;
      const data = await res.json();
      const title = data.choices?.[0]?.message?.content?.trim();
      if (title && title.length < 80) {
        renameConversation(convId, title);
        renderSidebar();
        if (convId === state.activeConvId) {
          const td = document.getElementById('chat-title-display');
          if (td) td.textContent = title;
        }
        return;
      }

      const fallbackTitle = generateLocalTitle(firstUserMessage);
      renameConversation(convId, fallbackTitle);
      renderSidebar();
      if (convId === state.activeConvId) {
        const td = document.getElementById('chat-title-display');
        if (td) td.textContent = fallbackTitle;
      }
    } catch {
      const fallbackTitle = generateLocalTitle(firstUserMessage);
      renameConversation(convId, fallbackTitle);
      renderSidebar();
      if (convId === state.activeConvId) {
        const td = document.getElementById('chat-title-display');
        if (td) td.textContent = fallbackTitle;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 11: IMAGE GENERATION
  // ─────────────────────────────────────────────────────────────────────────────

  function createImageOutput(imageUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'generated-image-wrap';
    const img = document.createElement('img');
    img.src = imageUrl;
    img.className = 'generated-image';
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(imageUrl));
    const dlBtn = document.createElement('a');
    dlBtn.href = imageUrl;
    dlBtn.download = `hackclub-ai-${Date.now()}.png`;
    dlBtn.className = 'btn-secondary image-dl-btn';
    dlBtn.textContent = '⬇ Download';
    wrap.appendChild(img);
    wrap.appendChild(dlBtn);
    return wrap;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 12: INPUT HANDLING
  // ─────────────────────────────────────────────────────────────────────────────

  function setupInputHandlers() {
    const input = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const attachBtn = document.getElementById('attach-btn');
    const fileInput = document.getElementById('file-input');
    const removeImgBtn = document.getElementById('remove-image-btn');
    const emptySettingsBtn = document.getElementById('empty-settings-btn');

    if (!input) return;

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 240) + 'px';
      updateTokenCounter(input.value);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && state.settings.enter_to_send !== false && !state.isStreaming) {
        e.preventDefault();
        handleSend();
        return;
      }
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        handleSend();
        return;
      }
      if (e.key === 'ArrowUp' && !input.value.trim()) {
        e.preventDefault();
        editLastUserMessage();
      }
    });

    sendBtn?.addEventListener('click', handleSend);
    stopBtn?.addEventListener('click', stopGeneration);
    attachBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', handleFileAttach);
    removeImgBtn?.addEventListener('click', clearAttachedImage);
    emptySettingsBtn?.addEventListener('click', () => openSettings('api'));
  }

  function handleSend() {
    const input = document.getElementById('message-input');
    const text = input ? input.value : '';
    if (!text.trim() && !state.attachedImage) return;

    if (!state.activeConvId) {
      const conv = createConversation();
      state.activeConvId = conv.id;
      lsSet(LS.ACTIVE_CONV, conv.id);
      renderSidebar();
    }

    sendMessage(text, state.attachedImage?.dataUrl);
    state.attachedImage = null;
    const strip = document.getElementById('image-preview-strip');
    if (strip) strip.classList.add('hidden');
    const fileInput = document.getElementById('file-input');
    if (fileInput) fileInput.value = '';
  }

  function handleFileAttach(e) {
    const file = e.target.files[0];
    if (!file) return;

    const model = getModelById(state.settings.chat_model);
    if (!modelCan(model, 'vision')) {
      showToast('Selected model does not support image input', 'warning');
      e.target.value = '';
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      showToast('Image too large (max 10MB)', 'error');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      state.attachedImage = { dataUrl: ev.target.result, file };
      const thumb = document.getElementById('image-preview-thumb');
      if (thumb) thumb.src = ev.target.result;
      const strip = document.getElementById('image-preview-strip');
      if (strip) strip.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function clearAttachedImage() {
    state.attachedImage = null;
    const strip = document.getElementById('image-preview-strip');
    if (strip) strip.classList.add('hidden');
    const thumb = document.getElementById('image-preview-thumb');
    if (thumb) thumb.src = '';
  }

  function updateTokenCounter(text) {
    const count = Math.ceil((text || '').length / 4);
    const model = getModelById(state.settings.chat_model);
    const ctxLen = model?.context_length || 0;
    const counter = document.getElementById('token-counter');
    if (counter) {
      counter.textContent = ctxLen
        ? `~${count.toLocaleString()} / ${formatContextLength(ctxLen)} tokens`
        : `~${count.toLocaleString()} tokens`;
    }
    const contextBar = document.getElementById('context-warning');
    if (ctxLen && contextBar) {
      const pct = count / ctxLen;
      contextBar.classList.toggle('hidden', pct < 0.8);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 13: COMMAND PALETTE
  // ─────────────────────────────────────────────────────────────────────────────

  function openCommandPalette() {
    const modal = document.getElementById('command-palette');
    const input = document.getElementById('command-input');
    if (!modal) return;
    closeDropdowns();
    modal.classList.remove('hidden');
    if (input) { input.value = ''; input.focus(); }
    renderCommandResults('');
    state.commandPaletteOpen = true;
    state.commandSelectedIndex = -1;
  }

  function closeCommandPalette() {
    document.getElementById('command-palette')?.classList.add('hidden');
    state.commandPaletteOpen = false;
    state.commandSelectedIndex = -1;
  }

  function renderCommandResults(query) {
    const results = document.getElementById('command-results');
    if (!results) return;
    const q = query.toLowerCase().trim();
    const items = [];

    // Actions
    const actions = [
      { type: 'action', label: 'New Conversation', icon: '✏️', shortcut: 'Ctrl+N', fn: () => { newConversation(); closeCommandPalette(); } },
      { type: 'action', label: 'Open Settings', icon: '⚙️', shortcut: 'Ctrl+,', fn: () => { openSettings(); closeCommandPalette(); } },
      { type: 'action', label: 'Toggle Thinking Mode', icon: '🧠', shortcut: 'Ctrl+Shift+T', fn: () => { toggleThinking(); closeCommandPalette(); } },
      { type: 'action', label: 'Toggle Web Search', icon: '🔍', fn: () => { toggleWebSearch(); closeCommandPalette(); } },
      { type: 'action', label: 'Clear Current Chat', icon: '🗑️', shortcut: 'Ctrl+L', fn: () => { clearChat(); closeCommandPalette(); } },
      { type: 'action', label: 'Export Chat (Markdown)', icon: '⬇️', shortcut: 'Ctrl+Shift+E', fn: () => { exportChat('markdown-dl'); closeCommandPalette(); } },
      { type: 'action', label: 'Export Chat (JSON)', icon: '📄', fn: () => { exportChat('json'); closeCommandPalette(); } },
      { type: 'action', label: 'View Keyboard Shortcuts', icon: '⌨️', fn: () => { openSettings('shortcuts'); closeCommandPalette(); } },
    ];
    items.push(...actions.filter(a => !q || a.label.toLowerCase().includes(q)));

    // Conversations
    const convMatches = state.conversations
      .filter(c => !q || c.title.toLowerCase().includes(q))
      .slice(0, 5)
      .map(c => ({
        type: 'conversation',
        label: c.title,
        icon: '💬',
        fn: () => { setActiveConversation(c.id); closeCommandPalette(); }
      }));
    items.push(...convMatches);

    // Models
    const modelMatches = state.models
      .filter(m => !q || (m.name || m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      .slice(0, 4)
      .map(m => ({
        type: 'model',
        label: `Switch to ${m.name || m.id}`,
        icon: '🔄',
        fn: () => { switchModel(m.id); closeCommandPalette(); }
      }));
    items.push(...modelMatches);

    state.commandItems = items;
    state.commandSelectedIndex = -1;

    results.innerHTML = '';
    if (!items.length) {
      results.innerHTML = '<div class="command-empty">No results found</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    let lastType = null;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type !== lastType) {
        const label = document.createElement('div');
        label.className = 'command-section-label';
        label.textContent = { action: 'Actions', conversation: 'Conversations', model: 'Models' }[item.type] || item.type;
        frag.appendChild(label);
        lastType = item.type;
      }

      const el = document.createElement('div');
      el.className = 'command-item';
      el.dataset.index = i;

      let labelHtml = escapeHtml(item.label);
      if (q) {
        const re = new RegExp(`(${escapeRegex(q)})`, 'gi');
        labelHtml = labelHtml.replace(re, '<mark>$1</mark>');
      }

      el.innerHTML = `
        <span class="command-item-icon">${item.icon}</span>
        <span class="command-item-label">${labelHtml}</span>
        ${item.shortcut ? `<span class="command-item-shortcut">${item.shortcut.split('+').map(k => `<kbd>${k}</kbd>`).join('')}</span>` : ''}
        <span class="command-item-type">${item.type}</span>
      `;
      el.addEventListener('click', () => item.fn());
      el.addEventListener('mouseenter', () => {
        results.querySelectorAll('.command-item.focused').forEach(el => el.classList.remove('focused'));
        el.classList.add('focused');
        state.commandSelectedIndex = i;
      });
      frag.appendChild(el);
    }
    results.appendChild(frag);
  }

  function handleCommandPaletteNav(e) {
    const items = document.querySelectorAll('#command-results .command-item');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.commandSelectedIndex = Math.min(state.commandSelectedIndex + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.commandSelectedIndex = Math.max(state.commandSelectedIndex - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const idx = state.commandSelectedIndex;
      if (idx >= 0 && state.commandItems[idx]) {
        state.commandItems[idx].fn();
      } else if (items.length > 0) {
        state.commandItems[0]?.fn();
      }
      return;
    } else if (e.key === 'Escape') {
      closeCommandPalette();
      return;
    } else {
      return;
    }

    items.forEach(el => el.classList.remove('focused'));
    if (state.commandSelectedIndex >= 0 && items[state.commandSelectedIndex]) {
      items[state.commandSelectedIndex].classList.add('focused');
      items[state.commandSelectedIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 14: SETTINGS MODAL
  // ─────────────────────────────────────────────────────────────────────────────

  function openSettings(tabId) {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    loadSettingsIntoUI();
    if (tabId) switchSettingsTab(tabId);
    document.getElementById('api-key-input')?.focus();
  }

  function closeSettings() {
    document.getElementById('settings-modal')?.classList.add('hidden');
  }

  function switchSettingsTab(tabId) {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-pane').forEach(p => { p.classList.add('hidden'); p.classList.remove('active'); });
    const tab = document.querySelector(`.settings-tab[data-tab="${tabId}"]`);
    const pane = document.getElementById(`tab-${tabId}`);
    if (tab) tab.classList.add('active');
    if (pane) { pane.classList.remove('hidden'); pane.classList.add('active'); }
  }

  function setupApiKeyTest() {
    const testBtn = document.getElementById('api-key-test-btn');
    if (!testBtn) return;
    testBtn.addEventListener('click', async () => {
      const keyInput = document.getElementById('api-key-input');
      const statusEl = document.getElementById('api-key-status');
      const key = keyInput?.value.trim() || getApiKey();
      if (!key) {
        showApiKeyStatus('Enter an API key first', 'error');
        return;
      }
      testBtn.textContent = 'Testing…';
      testBtn.disabled = true;
      try {
        const baseUrl = (document.getElementById('base-url-input')?.value || state.settings.base_url).trim();
        const res = await fetchWithCorsFallback(`${baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${key}` }
        });
        if (res.ok) {
          showApiKeyStatus('✓ Connected successfully', 'success');
          setApiKey(key);
          updateApiStatus();
          updateConnStatusDisplay();
        } else {
          showApiKeyStatus(`✕ Failed (${res.status})`, 'error');
        }
      } catch (err) {
        showApiKeyStatus(`✕ ${err.message}`, 'error');
      } finally {
        testBtn.textContent = 'Test';
        testBtn.disabled = false;
      }
    });
  }

  function showApiKeyStatus(msg, type) {
    const el = document.getElementById('api-key-status');
    if (!el) return;
    el.textContent = msg;
    el.className = `status-line ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
  }

  function setupApiKeyToggle() {
    const btn = document.getElementById('api-key-show-btn');
    const input = document.getElementById('api-key-input');
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
    });
  }

  function updateApiStatus() {
    const dot = document.getElementById('api-status-dot');
    const label = document.getElementById('api-status-label');
    const hasKey = !!getApiKey();
    if (dot) dot.className = hasKey ? 'connected' : '';
    if (label) label.textContent = hasKey ? 'Connected' : 'No API Key';
  }

  function updateConnStatusDisplay() {
    const el = document.getElementById('conn-status-display');
    if (!el) return;
    if (getApiKey()) {
      el.textContent = 'Connected';
      el.className = 'status-badge connected';
    } else {
      el.textContent = 'Not connected';
      el.className = 'status-badge';
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 15: HEADER CONTROLS
  // ─────────────────────────────────────────────────────────────────────────────

  function toggleThinking() {
    state.thinkingActive = !state.thinkingActive;
    const btn = document.getElementById('thinking-btn');
    if (btn) btn.dataset.active = state.thinkingActive ? 'true' : 'false';
    showToast(`Thinking mode ${state.thinkingActive ? 'enabled' : 'disabled'}`, 'info');
  }

  function toggleWebSearch() {
    state.webSearchActive = !state.webSearchActive;
    const btn = document.getElementById('websearch-btn');
    if (btn) btn.dataset.active = state.webSearchActive ? 'true' : 'false';
    showToast(`Web search ${state.webSearchActive ? 'enabled' : 'disabled'}`, 'info');
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    if (window.innerWidth <= 768) {
      // Mobile: overlay toggle
      const isOpen = sidebar.classList.contains('open');
      if (isOpen) {
        closeMobileSidebar();
      } else {
        sidebar.classList.add('open');
        const overlay = document.getElementById('sidebar-overlay');
        if (overlay) overlay.classList.remove('hidden');
      }
    } else {
      // Desktop: hide/show sidebar entirely
      sidebar.style.display = sidebar.style.display === 'none' ? '' : 'none';
    }
  }

  function closeMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    sidebar?.classList.remove('open');
    overlay?.classList.add('hidden');
  }

  function toggleDetailsPanel() {
    const panel = document.getElementById('details-panel');
    if (!panel) return;
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) updateDetailsPanel();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 16: MODEL SELECTOR HEADER DROPDOWN
  // ─────────────────────────────────────────────────────────────────────────────

  function setupModelSelectorBtn() {
    const btn = document.getElementById('model-selector-btn');
    const dropdown = document.getElementById('model-dropdown');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !dropdown.classList.contains('hidden');
      closeDropdowns();
      if (!isOpen) {
        dropdown.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        state.currentDropdown = dropdown;
        document.getElementById('model-search')?.focus();
        // Re-render list
        renderAllModelDropdowns();
      }
    });
  }

  function closeDropdowns() {
    document.querySelectorAll('.dropdown').forEach(d => d.classList.add('hidden'));
    document.getElementById('model-selector-btn')?.setAttribute('aria-expanded', 'false');
    state.currentDropdown = null;
  }

  function setupExportDropdown() {
    const btn = document.getElementById('export-btn');
    const dropdown = document.getElementById('export-dropdown');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !dropdown.classList.contains('hidden');
      closeDropdowns();
      if (!isOpen) {
        dropdown.classList.remove('hidden');
        state.currentDropdown = dropdown;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 17: DETAILS PANEL
  // ─────────────────────────────────────────────────────────────────────────────

  function updateDetailsPanel() {
    const panel = document.getElementById('details-panel');
    if (!panel || panel.classList.contains('hidden')) return;

    const model = getModelById(state.settings.chat_model);
    const conv = getActiveConversation();

    const setEl = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text || '—';
    };

    setEl('details-model-name', model ? (model.name || model.id) : state.settings.chat_model);
    setEl('details-model-provider', model ? `Provider: ${getProviderFromId(model.id)}` : '');
    setEl('details-model-ctx', model?.context_length ? `Context: ${formatContextLength(model.context_length)} tokens` : '');

    const capsEl = document.getElementById('details-model-caps');
    if (capsEl) capsEl.innerHTML = model ? modelCapBadges(model) : '';

    // Pricing
    const pricingIn = model?.pricing?.prompt ? `Input: ${formatPrice(model.pricing.prompt)}/M` : 'Input: —';
    const pricingOut = model?.pricing?.completion ? `Output: ${formatPrice(model.pricing.completion)}/M` : 'Output: —';
    setEl('details-pricing-in', pricingIn);
    setEl('details-pricing-out', pricingOut);

    // Conversation stats
    if (conv) {
      const msgs = conv.messages.filter(m => m.role !== 'system');
      setEl('details-msg-count', `${msgs.length} messages`);

      const totalTokens = msgs.reduce((sum, m) => {
        const txt = typeof m.content === 'string' ? m.content : (m.content?.find?.(p => p.type === 'text')?.text || '');
        return sum + Math.ceil(txt.length / 4);
      }, 0);
      setEl('details-token-est', `~${totalTokens.toLocaleString()} tokens (est.)`);

      if (model?.pricing?.prompt && model?.pricing?.completion) {
        const inputCost = (totalTokens / 2 / 1_000_000) * parseFloat(model.pricing.prompt);
        const outputCost = (totalTokens / 2 / 1_000_000) * parseFloat(model.pricing.completion);
        setEl('details-cost-est', `~$${(inputCost + outputCost).toFixed(4)} (est.)`);
      } else {
        setEl('details-cost-est', 'Cost: N/A');
      }
    } else {
      setEl('details-msg-count', 'No conversation');
      setEl('details-token-est', '—');
      setEl('details-cost-est', '—');
    }

    // Parameters
    setEl('details-temp', `Temperature: ${state.settings.temperature}`);
    setEl('details-max-tokens', `Max tokens: ${state.settings.max_tokens.toLocaleString()}`);
    setEl('details-thinking-status', `Thinking: ${state.thinkingActive ? 'enabled' : 'disabled'}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 18: EXPORT & IMPORT
  // ─────────────────────────────────────────────────────────────────────────────

  function exportChat(format) {
    const conv = getActiveConversation();
    if (!conv) { showToast('No active conversation', 'warning'); return; }

    if (format === 'markdown' || format === 'markdown-dl') {
      let md = `# ${conv.title}\n\n`;
      md += `*Exported from HackClub AI · ${new Date().toLocaleString()}*\n\n---\n\n`;
      for (const m of conv.messages) {
        if (m.role === 'system') continue;
        const role = m.role === 'user' ? '**You**' : `**Assistant** *(${(m.model || '').split('/').pop() || 'AI'})*`;
        const text = typeof m.content === 'string' ? m.content
          : (m.content?.find?.(p => p.type === 'text')?.text || '');
        md += `${role}\n\n${text}\n\n---\n\n`;
      }
      if (format === 'markdown') {
        navigator.clipboard.writeText(md).then(() => showToast('Copied as Markdown', 'success'))
          .catch(() => showToast('Copy failed', 'error'));
      } else {
        downloadText(md, `${sanitizeFilename(conv.title)}.md`, 'text/markdown');
        showToast('Downloaded as Markdown', 'success');
      }
    } else if (format === 'json') {
      downloadText(JSON.stringify(conv, null, 2), `${sanitizeFilename(conv.title)}.json`, 'application/json');
      showToast('Downloaded as JSON', 'success');
    } else if (format === 'html') {
      const html = buildExportHTML(conv);
      downloadText(html, `${sanitizeFilename(conv.title)}.html`, 'text/html');
      showToast('Downloaded as HTML', 'success');
    }
  }

  function buildExportHTML(conv) {
    const messages = conv.messages.filter(m => m.role !== 'system').map(m => {
      const text = typeof m.content === 'string' ? m.content
        : (m.content?.find?.(p => p.type === 'text')?.text || '');
      return `<div class="msg ${m.role}">
        <div class="role">${m.role === 'user' ? '👤 You' : '🤖 Assistant'}</div>
        <div class="content">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
        <div class="time">${m.timestamp ? new Date(m.timestamp).toLocaleString() : ''}</div>
      </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(conv.title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#efefef;max-width:800px;margin:0 auto;padding:32px 16px;line-height:1.6}
h1{color:#e8d5b0;margin-bottom:8px}
.meta{color:#555;font-size:13px;margin-bottom:32px}
.msg{margin-bottom:24px;padding:16px;border-radius:8px;border:1px solid #242424}
.msg.user{background:#222;border-radius:12px 12px 4px 12px}
.msg.assistant{background:#111}
.role{font-size:12px;color:#888;margin-bottom:8px;font-weight:600}
.content{font-size:14px;white-space:pre-wrap;word-break:break-word}
.time{font-size:10px;color:#555;margin-top:8px}
</style>
</head>
<body>
<h1>${escapeHtml(conv.title)}</h1>
<div class="meta">Exported ${new Date().toLocaleString()}</div>
${messages}
</body>
</html>`;
  }

  function downloadText(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportAllConversations() {
    const data = {
      exported_at: new Date().toISOString(),
      conversations: state.conversations,
    };
    downloadText(JSON.stringify(data, null, 2), `hackclub-ai-export-${Date.now()}.json`, 'application/json');
    showToast(`Exported ${state.conversations.length} conversations`, 'success');
  }

  function importConversations(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        let data = JSON.parse(ev.target.result);
        let convs;
        if (Array.isArray(data)) {
          convs = data;
        } else if (data.conversations) {
          convs = data.conversations;
        } else {
          throw new Error('Invalid format');
        }
        // Merge (skip duplicates by id)
        const existingIds = new Set(state.conversations.map(c => c.id));
        const newConvs = convs.filter(c => !existingIds.has(c.id));
        state.conversations = [...newConvs, ...state.conversations];
        saveConversations();
        renderSidebar();
        showToast(`Imported ${newConvs.length} conversations`, 'success');
      } catch (err) {
        showToast('Import failed: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function sanitizeFilename(name) {
    return (name || 'conversation').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 19: TOAST SYSTEM
  // ─────────────────────────────────────────────────────────────────────────────

  function showToast(message, type = 'info') {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;

    while (stack.children.length >= 3) stack.removeChild(stack.firstChild);

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${escapeHtml(message)}</span>`;
    stack.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('removing');
      const handler = () => toast.remove();
      toast.addEventListener('animationend', handler, { once: true });
      setTimeout(handler, 300); // fallback
    }, 3500);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 20: KEYBOARD SHORTCUTS
  // ─────────────────────────────────────────────────────────────────────────────

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      const inInput = tag === 'input' || tag === 'textarea';
      const ctrlOrMeta = e.ctrlKey || e.metaKey;

      // Escape — close modals / stop generation
      if (e.key === 'Escape') {
        if (state.isStreaming) { stopGeneration(); return; }
        if (state.commandPaletteOpen) { closeCommandPalette(); return; }
        if (!document.getElementById('settings-modal')?.classList.contains('hidden')) { closeSettings(); return; }
        if (!document.getElementById('lightbox')?.classList.contains('hidden')) { closeLightbox(); return; }
        if (!document.getElementById('confirm-dialog')?.classList.contains('hidden')) {
          document.getElementById('confirm-dialog')?.classList.add('hidden'); return;
        }
        closeDropdowns();
        return;
      }

      if (ctrlOrMeta) {
        switch (e.key.toLowerCase()) {
          case 'n':
            if (!inInput) { e.preventDefault(); newConversation(); }
            break;
          case 'k':
            e.preventDefault();
            state.commandPaletteOpen ? closeCommandPalette() : openCommandPalette();
            break;
          case ',':
            e.preventDefault();
            openSettings();
            break;
          case 'l':
            e.preventDefault();
            clearChat();
            break;
          case '/':
            e.preventDefault();
            openSettings('shortcuts');
            break;
          case 't':
            if (e.shiftKey) { e.preventDefault(); toggleThinking(); }
            break;
          case 'e':
            if (e.shiftKey) { e.preventDefault(); exportChat('markdown-dl'); }
            break;
        }
      }

      // ? key — shortcuts
      if (e.key === '?' && !inInput && !ctrlOrMeta) {
        openSettings('shortcuts');
      }
    });

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dropdown') &&
          !e.target.closest('#model-selector-btn') &&
          !e.target.closest('#export-btn') &&
          !e.target.closest('.model-picker-btn')) {
        closeDropdowns();
      }
      // Close context menu
      if (!e.target.closest('#context-menu')) {
        removeContextMenu();
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 21: SCROLL MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  function scrollToBottom(smooth = true) {
    const container = document.getElementById('messages-container');
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  }

  function isNearBottom(threshold = 120) {
    const c = document.getElementById('messages-container');
    if (!c) return true;
    return c.scrollHeight - c.scrollTop - c.clientHeight < threshold;
  }

  function setupScrollHandler() {
    const c = document.getElementById('messages-container');
    const btn = document.getElementById('scroll-to-bottom-btn');
    if (!c || !btn) return;
    c.addEventListener('scroll', () => {
      btn.classList.toggle('hidden', isNearBottom(80));
    });
    btn.addEventListener('click', () => scrollToBottom());
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 22: LIGHTBOX & CONFIRM DIALOG
  // ─────────────────────────────────────────────────────────────────────────────

  function openLightbox(url) {
    const lb = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    const dl = document.getElementById('lightbox-download');
    if (!lb || !img) return;
    img.src = url;
    if (dl) dl.href = url;
    lb.classList.remove('hidden');
  }

  function closeLightbox() {
    document.getElementById('lightbox')?.classList.add('hidden');
  }

  function showConfirm(message, onConfirm) {
    const dialog = document.getElementById('confirm-dialog');
    const msgEl = document.getElementById('confirm-message');
    if (!dialog || !msgEl) { if (confirm(message)) onConfirm(); return; }
    msgEl.textContent = message;
    dialog.classList.remove('hidden');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    const cleanup = () => dialog.classList.add('hidden');
    if (okBtn) {
      const newOk = okBtn.cloneNode(true);
      okBtn.parentNode.replaceChild(newOk, okBtn);
      newOk.addEventListener('click', () => { cleanup(); onConfirm(); }, { once: true });
    }
    if (cancelBtn) {
      const newCancel = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
      newCancel.addEventListener('click', cleanup, { once: true });
    }
  }

  function closeAllModals() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    state.commandPaletteOpen = false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 23: UTILITY FUNCTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  function relativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60_000)       return 'just now';
    if (diff < 3_600_000)    return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000)   return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 604_800_000)  return `${Math.floor(diff / 86_400_000)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function formatPrice(p) {
    if (!p || p === '0') return 'Free';
    const n = parseFloat(p) * 1_000_000;
    return `$${n.toFixed(2)}`;
  }

  function debounce(fn, delay) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 24: INITIALIZATION
  // ─────────────────────────────────────────────────────────────────────────────

  function init() {
    loadSettings();
    loadConversations();

    setupMarked();
    setupKeyboardShortcuts();
    setupInputHandlers();
    setupScrollHandler();
    setupSettingsSliders();
    setupApiKeyTest();
    setupApiKeyToggle();
    setupModelSelectorBtn();
    setupExportDropdown();

    // Restore last active conversation
    const lastId = lsGet(LS.ACTIVE_CONV);
    if (lastId && state.conversations.find(c => c.id === lastId)) {
      state.activeConvId = lastId;
    } else if (state.conversations.length > 0) {
      state.activeConvId = state.conversations[0].id;
    }

    renderSidebar();
    renderMessages();
    updateHeaderForConversation();
    updateApiStatus();
    updateNoKeyBanner();

    // Fetch models async — don't block render
    fetchModels().then(() => {
      renderAllModelDropdowns();
      updateCapabilityButtons();
      updateDetailsPanel();
    }).catch(err => console.warn('Model fetch failed:', err));

    // ── Wire up static buttons ──

    document.getElementById('new-chat-btn')?.addEventListener('click', newConversation);

    document.getElementById('settings-btn')?.addEventListener('click', () => openSettings());

    document.getElementById('api-status')?.addEventListener('click', () => openSettings('api'));

    document.getElementById('thinking-btn')?.addEventListener('click', toggleThinking);

    document.getElementById('websearch-btn')?.addEventListener('click', toggleWebSearch);

    document.getElementById('clear-chat-btn')?.addEventListener('click', clearChat);

    document.getElementById('sidebar-toggle-btn')?.addEventListener('click', toggleSidebar);

    document.getElementById('sidebar-overlay')?.addEventListener('click', closeMobileSidebar);

    document.getElementById('details-toggle-btn')?.addEventListener('click', toggleDetailsPanel);

    document.getElementById('details-close-btn')?.addEventListener('click', toggleDetailsPanel);

    document.getElementById('settings-close-btn')?.addEventListener('click', closeSettings);

    document.getElementById('settings-save-btn')?.addEventListener('click', saveSettingsFromUI);

    document.getElementById('settings-modal')?.querySelector('.modal-backdrop')
      ?.addEventListener('click', closeSettings);

    document.getElementById('reload-models-btn')?.addEventListener('click', () => {
      showToast('Reloading models…', 'info');
      fetchModels(true).then(() => {
        renderAllModelDropdowns();
        const mu = document.getElementById('models-last-updated');
        if (mu) mu.textContent = `Updated just now`;
        showToast('Models reloaded', 'success');
      }).catch(() => showToast('Failed to reload models', 'error'));
    });

    document.getElementById('lightbox-close')?.addEventListener('click', closeLightbox);

    document.getElementById('lightbox')?.querySelector('.modal-backdrop')
      ?.addEventListener('click', closeLightbox);

    document.getElementById('command-palette')?.querySelector('.modal-backdrop')
      ?.addEventListener('click', closeCommandPalette);

    document.getElementById('command-input')?.addEventListener('input',
      debounce(e => renderCommandResults(e.target.value), 100));

    document.getElementById('command-input')?.addEventListener('keydown', handleCommandPaletteNav);

    document.getElementById('sidebar-search')?.addEventListener('input',
      debounce(() => renderSidebar(), 200));

    // Export dropdown
    document.getElementById('export-dropdown')?.addEventListener('click', e => {
      const fmt = e.target.dataset.export;
      if (fmt) { exportChat(fmt); closeDropdowns(); }
    });

    // Settings tab switching
    document.getElementById('settings-nav')?.addEventListener('click', e => {
      const tab = e.target.closest('[data-tab]');
      if (tab) switchSettingsTab(tab.dataset.tab);
    });

    // Suggestion cards
    document.getElementById('suggestion-grid')?.addEventListener('click', e => {
      const card = e.target.closest('.suggestion-card');
      if (card) {
        const input = document.getElementById('message-input');
        if (input) {
          input.value = card.dataset.prompt || '';
          input.dispatchEvent(new Event('input'));
        }
        handleSend();
      }
    });

    // Chat title rename
    document.getElementById('chat-title-display')?.addEventListener('click', startTitleEdit);

    // Copy code buttons (event delegation)
    document.getElementById('messages-container')?.addEventListener('click', e => {
      const btn = e.target.closest('.copy-code-btn');
      if (btn) {
        const encoded = btn.dataset.code;
        let text;
        try { text = decodeURIComponent(escape(atob(encoded))); }
        catch { try { text = atob(encoded); } catch { text = encoded; } }
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
        }).catch(() => showToast('Copy failed', 'error'));
      }
    });

    // Data tab buttons
    document.getElementById('export-all-btn')?.addEventListener('click', exportAllConversations);

    document.getElementById('import-btn')?.addEventListener('click', () =>
      document.getElementById('import-file-input')?.click());

    document.getElementById('import-file-input')?.addEventListener('change', importConversations);

    document.getElementById('clear-all-convs-btn')?.addEventListener('click', () =>
      showConfirm('Delete ALL conversations? This cannot be undone.', clearAllConversations));

    document.getElementById('clear-api-key-btn')?.addEventListener('click', () =>
      showConfirm('Remove your API key?', () => {
        lsDel(LS.API_KEY);
        updateApiStatus();
        const apiKeyInput = document.getElementById('api-key-input');
        if (apiKeyInput) apiKeyInput.value = '';
        showToast('API key removed', 'info');
      }));

    // Thinking default toggle initial state
    if (state.settings.thinking_mode) {
      state.thinkingActive = true;
      const btn = document.getElementById('thinking-btn');
      if (btn) btn.dataset.active = 'true';
    }

    // Focus input
    setTimeout(() => document.getElementById('message-input')?.focus(), 100);
  }

  // ── Start the app when DOM is ready ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();