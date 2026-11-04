'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(path.join(__dirname,'../extension/src/popup.js'),'utf8');
const contentSource = fs.readFileSync(path.join(__dirname,'../extension/src/content.js'),'utf8');
const settingsKey = 'gptExporter.exportSettings';
const settingsMarkup = `
  <details><div id="custom-prefix-row"><input id="setting-custom-prefix" data-setting="customFilenamePrefix" type="text"></div>
    <input id="setting-show-toolbar" data-setting="showToolbarButton" type="checkbox">
    <input id="setting-close-reader" data-setting="closeSelectionAfterExport" type="checkbox">
    <select id="setting-filename-format" data-setting="filenameFormat"><option value="title">title</option><option value="date-title">date-title</option><option value="custom-title">custom-title</option></select>
    <input id="setting-conversation-link" data-setting="includeConversationLink" type="checkbox">
    <input id="setting-message-timestamp" data-setting="includeMessageTimestamp" type="checkbox">
    <input id="setting-include-title" data-setting="includeTitleInNonPdf" type="checkbox">
    <input id="setting-include-user-name" data-setting="includeUserName" type="checkbox"><input id="setting-user-name" data-setting="userName" type="text">
    <input id="setting-include-user-email" data-setting="includeUserEmail" type="checkbox"><input id="setting-user-email" data-setting="userEmail" type="email">
    <select id="setting-date-format" data-setting="dateFormat"><option value="YYYY-MM-DD">YYYY-MM-DD</option><option value="DD-MM-YYYY">DD-MM-YYYY</option><option value="MM-DD-YYYY">MM-DD-YYYY</option></select>
    <select id="setting-time-format" data-setting="timeFormat"><option value="24h">24h</option><option value="12h">12h</option></select>
    <input id="setting-custom-roles" data-setting="customizeRoleNames" type="checkbox"><div id="role-fields">
      <input data-role="user" value="User"><input data-role="assistant" value="Assistant"><input data-role="system" value="System"><input data-role="tool" value="Tool">
    </div>
    <input id="setting-copy-clipboard" data-setting="copyToClipboardAfterExport" type="checkbox"><button id="open-download-settings" type="button">Downloads</button>
  </details><p id="settings-status"></p>`;
function popup(options={}) {
  const dom = new JSDOM(settingsMarkup, {runScripts:'outside-only'});
  const settingsCalls = [];
  let savedSettings = options.settings;
  dom.window.chrome = {
    tabs: {
      async create(value) { settingsCalls.push(['openDownloads',value]); return {id:8}; }
    },
    storage: {local: {
      async get(key) { settingsCalls.push(['get',key]); return {[key]:savedSettings}; },
      async set(value) { settingsCalls.push(['set',value]); savedSettings=value[settingsKey]; }
    }}
  };
  dom.window.eval(source);
  return {dom,settingsCalls,get savedSettings(){return savedSettings;},
    async ready(){await new Promise(resolve=>setImmediate(resolve));}};
}

test('popup loads normalized export settings and uses the documented defaults',async()=>{
  const env=popup();await env.ready();
  const doc=env.dom.window.document;
  assert.equal(env.settingsCalls[0][0],'get');assert.equal(env.settingsCalls[0][1],settingsKey);
  assert.equal(doc.getElementById('setting-show-toolbar').checked,true);
  assert.equal(doc.getElementById('setting-close-reader').checked,false);
  assert.equal(doc.getElementById('setting-filename-format').value,'title');
  assert.equal(doc.getElementById('setting-conversation-link').checked,true);
  assert.equal(doc.getElementById('setting-message-timestamp').checked,false);
  assert.equal(doc.getElementById('custom-prefix-row').hidden,true);
  assert.equal(doc.getElementById('setting-include-title').checked,true);
  assert.equal(doc.getElementById('setting-include-user-name').checked,false);
  assert.equal(doc.getElementById('setting-user-name').disabled,true);
  assert.equal(doc.getElementById('setting-include-user-email').checked,false);
  assert.equal(doc.getElementById('setting-user-email').disabled,true);
  assert.equal(doc.getElementById('setting-date-format').value,'YYYY-MM-DD');
  assert.equal(doc.getElementById('setting-time-format').value,'24h');
  assert.equal(doc.getElementById('setting-custom-roles').checked,false);
  assert.equal(doc.getElementById('role-fields').hidden,true);
  assert.equal(doc.getElementById('setting-copy-clipboard').checked,false);
});

test('popup saves settings with a safe custom filename prefix and reveals its field',async()=>{
  const env=popup({settings:{filenameFormat:'custom-title',customFilenamePrefix:'Old'}});await env.ready();
  const doc=env.dom.window.document;
  assert.equal(doc.getElementById('custom-prefix-row').hidden,false);
  const format=doc.getElementById('setting-filename-format');format.value='custom-title';
  const prefix=doc.getElementById('setting-custom-prefix');prefix.value='Research/ weekly..';
  prefix.dispatchEvent(new env.dom.window.Event('input',{bubbles:true}));
  doc.getElementById('setting-show-toolbar').checked=false;
  doc.getElementById('setting-show-toolbar').dispatchEvent(new env.dom.window.Event('change',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(env.savedSettings.showToolbarButton,false);
  assert.equal(env.savedSettings.filenameFormat,'custom-title');
  assert.equal(env.savedSettings.customFilenamePrefix,'Research- weekly');
  assert.equal(env.savedSettings.closeSelectionAfterExport,false);
  assert.equal(env.savedSettings.includeConversationLink,true);
  assert.equal(env.savedSettings.includeMessageTimestamp,false);
});

test('popup validates and only persists identity details while their options are enabled',async()=>{
  const env=popup();await env.ready();
  const doc=env.dom.window.document;
  const nameToggle=doc.getElementById('setting-include-user-name');
  const emailToggle=doc.getElementById('setting-include-user-email');
  nameToggle.checked=true;nameToggle.dispatchEvent(new env.dom.window.Event('change',{bubbles:true}));
  emailToggle.checked=true;emailToggle.dispatchEvent(new env.dom.window.Event('change',{bubbles:true}));
  doc.getElementById('setting-user-name').value='  Ada   Lovelace  ';
  doc.getElementById('setting-user-name').dispatchEvent(new env.dom.window.Event('input',{bubbles:true}));
  doc.getElementById('setting-user-email').value='ada@example.org';
  doc.getElementById('setting-user-email').dispatchEvent(new env.dom.window.Event('input',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(env.savedSettings.userName,'Ada Lovelace');
  assert.equal(env.savedSettings.userEmail,'ada@example.org');
  nameToggle.checked=false;nameToggle.dispatchEvent(new env.dom.window.Event('change',{bubbles:true}));
  emailToggle.checked=false;emailToggle.dispatchEvent(new env.dom.window.Event('change',{bubbles:true}));
  await env.ready();
  assert.equal(env.savedSettings.userName,'');
  assert.equal(env.savedSettings.userEmail,'');
  assert.equal(env.savedSettings.includeUserName,false);
  assert.equal(env.savedSettings.includeUserEmail,false);
});

test('popup rejects an invalid enabled email and opens browser download settings',async()=>{
  const env=popup();await env.ready();
  const doc=env.dom.window.document;
  doc.getElementById('setting-include-user-email').checked=true;
  doc.getElementById('setting-user-email').value='not-an-email';
  doc.getElementById('setting-include-user-email').dispatchEvent(new env.dom.window.Event('change',{bubbles:true}));
  await env.ready();
  assert.equal(env.savedSettings,undefined);
  assert.match(doc.getElementById('settings-status').textContent,/有效的邮箱地址/);
  doc.getElementById('open-download-settings').click();
  await env.ready();
  assert.ok(env.settingsCalls.some(call=>call[0]==='openDownloads'&&call[1].url==='chrome://settings/downloads'));
});

test('content toolbar follows saved visibility and reacts to settings changes',async()=>{
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://chatgpt.com/c/test',runScripts:'outside-only'});
  const listeners={changed:null,message:null};
  dom.window.chrome={
    runtime:{id:'extension-id',sendMessage:async()=>({ok:true}),onMessage:{addListener(listener){listeners.message=listener;}}},
    storage:{local:{async get(){return {[settingsKey]:{showToolbarButton:false}};}},
      onChanged:{addListener(listener){listeners.changed=listener;}}}
  };
  dom.window.GptExporter={};dom.window.eval(contentSource);
  await new Promise(resolve=>setImmediate(resolve));
  const host=dom.window.document.getElementById('gpt-exporter-launcher');
  assert.equal(host.hidden,true);
  listeners.changed({[settingsKey]:{newValue:{showToolbarButton:true}}},'local');
  assert.equal(host.hidden,false);
  listeners.changed({[settingsKey]:{newValue:{showToolbarButton:false}}},'local');
  assert.equal(host.hidden,true);
});
