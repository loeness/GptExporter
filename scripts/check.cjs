'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
if (manifest.manifest_version !== 3) throw new Error('Manifest V3 required');
function exists(relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep) || !fs.statSync(target).isFile()) throw new Error('Invalid resource: ' + relative);
}
const files = [manifest.background.service_worker, manifest.action.default_popup, 'direct-export.html',
  ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(item => item.js)];
files.forEach(exists);
function walk(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(item => {
    const target = path.join(directory, item.name);
    return item.isDirectory() ? walk(target) : [target];
  });
}
for (const file of walk(root)) {
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file], {stdio: 'pipe'});
  if (file.endsWith('.html')) {
    const html = fs.readFileSync(file, 'utf8');
    if (/<script\b(?![^>]*\bsrc=)[^>]*>|\bon\w+\s*=|<style\b/i.test(html)) throw new Error('Inline code violates CSP: ' + file);
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      if (!match[1].startsWith('#')) exists(match[1]);
    }
  }
}
const allowedHosts=['https://chatgpt.com/*','https://chat.openai.com/*','https://*.oaiusercontent.com/*','https://*.blob.core.windows.net/*'];
if (JSON.stringify(manifest.host_permissions)!==JSON.stringify(allowedHosts)||manifest.externally_connectable) throw new Error('Unexpected host permissions');
if (JSON.stringify([...manifest.permissions].sort()) !== JSON.stringify(['activeTab', 'downloads', 'offscreen', 'scripting', 'storage'])) throw new Error('Unexpected permissions');
console.log('Manifest resources, JavaScript syntax, local HTML references and CSP: OK');
