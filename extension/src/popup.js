'use strict';
const SETTINGS_KEY = 'gptExporter.exportSettings';
const DEFAULT_SETTINGS = Object.freeze({
  showToolbarButton: true,
  closeSelectionAfterExport: false,
  filenameFormat: 'title',
  customFilenamePrefix: '',
  includeConversationLink: true,
  includeMessageTimestamp: false,
  includeTitleInNonPdf: true,
  includeUserName: false,
  userName: '',
  includeUserEmail: false,
  userEmail: '',
  dateFormat: 'YYYY-MM-DD',
  timeFormat: '24h',
  customizeRoleNames: false,
  roleNames: {user:'User',assistant:'Assistant',system:'System',tool:'Tool'},
  copyToClipboardAfterExport: false
});

const settingsStatus = document.getElementById('settings-status');
const customPrefixRow = document.getElementById('custom-prefix-row');
const filenameFormatInput = document.getElementById('setting-filename-format');
const roleFields = document.getElementById('role-fields');
let settings = {...DEFAULT_SETTINGS};
let saveQueue = Promise.resolve();
let inputSaveTimer = 0;
let settingsStatusTimer = 0;

function storageArea() {
  try { return globalThis.chrome?.storage?.local || null; }
  catch (_) { return null; }
}

function sanitizeFilenamePrefix(value) {
  return String(value == null ? '' : value)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 50);
}

function sanitizePersonName(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
}

function sanitizeRoleName(value, fallback) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 40) || fallback;
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value);
}

function normalizeSettings(value) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const includeUserName = saved.includeUserName === true;
  const includeUserEmail = saved.includeUserEmail === true;
  const roleNames = saved.roleNames && typeof saved.roleNames === 'object' && !Array.isArray(saved.roleNames) ? saved.roleNames : {};
  return {
    showToolbarButton: saved.showToolbarButton !== false,
    closeSelectionAfterExport: saved.closeSelectionAfterExport === true,
    filenameFormat: ['title', 'date-title', 'custom-title'].includes(saved.filenameFormat) ? saved.filenameFormat : 'title',
    customFilenamePrefix: sanitizeFilenamePrefix(saved.customFilenamePrefix),
    includeConversationLink: saved.includeConversationLink !== false,
    includeMessageTimestamp: saved.includeMessageTimestamp === true,
    includeTitleInNonPdf: saved.includeTitleInNonPdf !== false,
    includeUserName,
    userName: includeUserName ? sanitizePersonName(saved.userName) : '',
    includeUserEmail,
    userEmail: includeUserEmail ? String(saved.userEmail == null ? '' : saved.userEmail).trim().slice(0, 254) : '',
    dateFormat: ['YYYY-MM-DD', 'DD-MM-YYYY', 'MM-DD-YYYY'].includes(saved.dateFormat) ? saved.dateFormat : 'YYYY-MM-DD',
    timeFormat: ['12h', '24h'].includes(saved.timeFormat) ? saved.timeFormat : '24h',
    customizeRoleNames: saved.customizeRoleNames === true,
    roleNames: {
      user: sanitizeRoleName(roleNames.user, 'User'),
      assistant: sanitizeRoleName(roleNames.assistant, 'Assistant'),
      system: sanitizeRoleName(roleNames.system, 'System'),
      tool: sanitizeRoleName(roleNames.tool, 'Tool')
    },
    copyToClipboardAfterExport: saved.copyToClipboardAfterExport === true
  };
}

function setSettingsStatus(message, kind = 'success') {
  if (!settingsStatus) return;
  globalThis.clearTimeout(settingsStatusTimer);
  settingsStatus.textContent = message;
  settingsStatus.dataset.kind = kind;
  settingsStatusTimer = globalThis.setTimeout(() => { settingsStatus.textContent = ''; }, kind === 'error' ? 6500 : 1800);
}

function renderSettings() {
  for (const [field, value] of Object.entries(settings)) {
    const input = document.querySelector(`[data-setting="${field}"]`);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
  }
  if (customPrefixRow && filenameFormatInput) customPrefixRow.hidden = filenameFormatInput.value !== 'custom-title';
  const nameInput = document.getElementById('setting-user-name');
  const emailInput = document.getElementById('setting-user-email');
  const roleToggle = document.getElementById('setting-custom-roles');
  if (nameInput) nameInput.disabled = !settings.includeUserName;
  if (emailInput) emailInput.disabled = !settings.includeUserEmail;
  if (roleFields && roleToggle) roleFields.hidden = !roleToggle.checked;
  for (const input of document.querySelectorAll('[data-role]')) input.value = settings.roleNames[input.dataset.role] || input.dataset.role;
}

async function loadSettings() {
  const local = storageArea();
  if (!local) {
    renderSettings();
    return;
  }
  try {
    const result = await local.get(SETTINGS_KEY);
    settings = normalizeSettings(result?.[SETTINGS_KEY]);
    renderSettings();
    if (settings.includeUserEmail && settings.userEmail && !validEmail(settings.userEmail)) {
      setSettingsStatus('已保存的邮箱格式无效，请修正后再保存。', 'error');
    }
  } catch (_) {
    settings = {...DEFAULT_SETTINGS};
    renderSettings();
    setSettingsStatus('设置读取失败，当前使用默认值。', 'error');
  }
}

function readSettingsFromForm() {
  const next = {...settings};
  for (const input of document.querySelectorAll('[data-setting]')) {
    const field = input.dataset.setting;
    next[field] = input.type === 'checkbox' ? input.checked : input.value;
  }
  next.roleNames = {...settings.roleNames};
  for (const input of document.querySelectorAll('[data-role]')) next.roleNames[input.dataset.role] = input.value;
  return normalizeSettings(next);
}

function persistSettings() {
  settings = readSettingsFromForm();
  renderSettings();
  if (settings.includeUserEmail && settings.userEmail && !validEmail(settings.userEmail)) {
    setSettingsStatus('请输入有效的邮箱地址，或关闭邮箱选项。', 'error');
    return Promise.resolve();
  }
  const local = storageArea();
  if (!local) return Promise.resolve();
  const snapshot = {...settings};
  saveQueue = saveQueue.then(() => local.set({[SETTINGS_KEY]: snapshot})).then(() => {
    setSettingsStatus('设置已保存。');
  }).catch(() => {
    setSettingsStatus('设置未能保存，请重试。', 'error');
  });
  return saveQueue;
}

const settingsReady = loadSettings();
for (const input of document.querySelectorAll('[data-setting]')) {
  input.addEventListener('change', () => { void settingsReady.then(persistSettings); });
  if (['customFilenamePrefix', 'userName', 'userEmail'].includes(input.dataset.setting)) {
    input.addEventListener('input', () => {
      globalThis.clearTimeout(inputSaveTimer);
      inputSaveTimer = globalThis.setTimeout(() => { void settingsReady.then(persistSettings); }, 250);
    });
  }
}
for (const input of document.querySelectorAll('[data-role]')) {
  input.addEventListener('change', () => { void settingsReady.then(persistSettings); });
  input.addEventListener('input', () => {
    globalThis.clearTimeout(inputSaveTimer);
    inputSaveTimer = globalThis.setTimeout(() => { void settingsReady.then(persistSettings); }, 250);
  });
}

document.getElementById('start-visual-capture')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  const status = document.getElementById('visual-capture-status');
  status.textContent = '';
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab?.id == null) {
      status.textContent = '请先打开受支持的对话。';
      return;
    }
    const result = await chrome.tabs.sendMessage(tab.id, {type: 'GPT_EXPORTER_START_VISUAL_CAPTURE'}, {frameId: 0});
    if (result?.ok === true) {
      window.close();
      return;
    }
    status.textContent = '无法开始采集。请确认已打开受支持的对话，然后刷新页面重试。';
  } catch (_) {
    status.textContent = '请先打开受支持的对话。如果已打开，请刷新页面后重试。';
  } finally {
    button.disabled = false;
  }
});

document.getElementById('open-download-settings')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await chrome.tabs.create({url:'chrome://settings/downloads'});
    setSettingsStatus('已打开浏览器下载设置。');
  } catch (_) {
    setSettingsStatus('无法打开下载设置，请从浏览器菜单进入“设置 → 下载内容”。', 'error');
  } finally { button.disabled = false; }
});
