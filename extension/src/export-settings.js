(function attachExportSettings(root) {
  'use strict';
  const api = root.GptExporter || (root.GptExporter = {});
  const KEY = 'gptExporter.exportSettings';
  const defaults = Object.freeze({
    showToolbarButton: true, closeSelectionAfterExport: false,
    filenameFormat: 'title', customFilenamePrefix: '',
    includeConversationLink: true, includeMessageTimestamp: false,
    includeTitleInNonPdf: true, includeUserName: false, userName: '', includeUserEmail: false, userEmail: '',
    dateFormat: 'YYYY-MM-DD', timeFormat: '24h', customizeRoleNames: false,
    roleNames: {user:'User', assistant:'Assistant', system:'System', tool:'Tool'}, copyToClipboardAfterExport: false
  });

  function normalize(value) {
    const input = value && typeof value === 'object' ? value : {};
    const roleDefaults = defaults.roleNames;
    const roleInput = input.roleNames && typeof input.roleNames === 'object' ? input.roleNames : {};
    const roles = Object.fromEntries(Object.entries(roleDefaults).map(([role, label]) =>
      [role, typeof roleInput[role] === 'string' ? roleInput[role].replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || label : label]));
    const userName = typeof input.userName === 'string' ? input.userName.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const email = typeof input.userEmail === 'string' ? input.userEmail.trim().slice(0, 254) : '';
    return {
      showToolbarButton: input.showToolbarButton !== false,
      closeSelectionAfterExport: input.closeSelectionAfterExport === true,
      filenameFormat: ['title', 'date-title', 'custom-title'].includes(input.filenameFormat) ? input.filenameFormat : 'title',
      customFilenamePrefix: typeof input.customFilenamePrefix === 'string' ? input.customFilenamePrefix.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 50) : '',
      includeConversationLink: input.includeConversationLink !== false,
      includeMessageTimestamp: input.includeMessageTimestamp === true,
      includeTitleInNonPdf: input.includeTitleInNonPdf !== false,
      includeUserName: input.includeUserName === true, userName: input.includeUserName === true ? userName : '',
      includeUserEmail: input.includeUserEmail === true, userEmail: input.includeUserEmail === true && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) ? email : '',
      dateFormat: ['YYYY-MM-DD', 'DD-MM-YYYY', 'MM-DD-YYYY'].includes(input.dateFormat) ? input.dateFormat : 'YYYY-MM-DD',
      timeFormat: input.timeFormat === '12h' ? '12h' : '24h',
      customizeRoleNames: input.customizeRoleNames === true, roleNames: roles,
      copyToClipboardAfterExport: input.copyToClipboardAfterExport === true
    };
  }

  async function read() {
    try { return normalize((await root.chrome.storage.local.get(KEY))[KEY]); }
    catch (_) { return normalize(defaults); }
  }

  function filename(title, extension, settings) {
    const options = normalize(settings);
    const safe = value => String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
      .replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim();
    const base = safe(title) || '对话导出';
    const prefix = options.filenameFormat === 'date-title' ? new Date().toISOString().slice(0, 10) :
      options.filenameFormat === 'custom-title' ? safe(options.customFilenamePrefix) : '';
    const cleanExtension = /^[a-z0-9]{1,8}$/i.test(String(extension)) ? String(extension).toLowerCase() : 'txt';
    return (safe(prefix ? `${prefix}-${base}` : base).slice(0, 100).replace(/[. ]+$/g, '') || '对话导出') + '.' + cleanExtension;
  }

  function formatTimestamp(value, settings) {
    if (value == null || value === '') return '';
    const numeric = typeof value === 'number' ? value : /^\d{10,13}$/.test(String(value)) ? Number(value) : null;
    const date = new Date(numeric == null ? value : numeric < 1e12 ? numeric * 1000 : numeric);
    if (!Number.isFinite(date.getTime())) return '';
    const options = normalize(settings);
    const pad = number => String(number).padStart(2, '0');
    const yyyy = date.getFullYear(), mm = pad(date.getMonth() + 1), dd = pad(date.getDate());
    const day = options.dateFormat === 'DD-MM-YYYY' ? `${dd}-${mm}-${yyyy}` :
      options.dateFormat === 'MM-DD-YYYY' ? `${mm}-${dd}-${yyyy}` : `${yyyy}-${mm}-${dd}`;
    const hours = date.getHours(), minutes = pad(date.getMinutes()), seconds = pad(date.getSeconds());
    const clock = options.timeFormat === '12h' ? `${pad(hours % 12 || 12)}:${minutes}:${seconds} ${hours < 12 ? 'AM' : 'PM'}` :
      `${pad(hours)}:${minutes}:${seconds}`;
    return `${day} ${clock}`;
  }

  api.exportSettings = {KEY, defaults, normalize, read, filename, formatTimestamp};
})(globalThis);
