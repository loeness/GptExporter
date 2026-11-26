(function attachGptExporterVendorLoader(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const bundles = new Map([
    ['mermaid', {path: 'vendor/mermaid.js', exports: ['mermaid']}],
    ['pdf', {path: 'vendor/pdf-engine.js', exports: ['pdfMake']}],
    ['math', {path: 'vendor/pdf-formulas.js', exports: ['renderMathSvg', 'html2canvas']}]
  ]);
  const pending = new Map();

  function ready(bundle) {
    return bundle.exports.every(name => root.GptExporterVendors?.[name]);
  }

  function insertScript(bundle) {
    return new Promise((resolve, reject) => {
      const script = root.document.createElement('script');
      script.src = bundle.path;
      script.addEventListener('load', () => {
        script.remove();
        if (ready(bundle)) {
          resolve(root.GptExporterVendors);
        } else {
          reject(new Error(`Vendor bundle did not initialize: ${bundle.path}`));
        }
      }, {once: true});
      script.addEventListener('error', () => {
        script.remove();
        reject(new Error(`Unable to load vendor bundle: ${bundle.path}`));
      }, {once: true});
      root.document.head.append(script);
    });
  }

  api.loadVendor = function loadVendor(name) {
    const bundle = bundles.get(name);
    if (!bundle) return Promise.reject(new Error('Unknown vendor bundle'));
    if (pending.has(name)) return pending.get(name);
    if (ready(bundle)) return Promise.resolve(root.GptExporterVendors);

    const load = Promise.resolve().then(() => insertScript(bundle)).finally(() => pending.delete(name));
    pending.set(name, load);
    return load;
  };
})(globalThis);
