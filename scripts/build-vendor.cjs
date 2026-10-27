'use strict';
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'extension/vendor');
const dependencies = ['pdfmake', 'mermaid', 'katex', 'markdown-it', 'dompurify', 'html2canvas','mathjax-full'];
function packageRoot(name) {
  let current = path.dirname(require.resolve(name));
  for (;;) {
    const file = path.join(current, 'package.json');
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).name === name) return current;
    const parent = path.dirname(current); if (parent === current) throw new Error('Package root unavailable: ' + name); current = parent;
  }
}
(async () => {
  fs.mkdirSync(path.join(out, 'licenses'), {recursive: true});
  fs.mkdirSync(path.join(out, 'fonts'), {recursive: true});
  const build=await esbuild.build({entryPoints:[path.join(__dirname,'vendor-entry.mjs')], outfile:path.join(out,'libraries.js'),
    bundle:true, platform:'browser', format:'iife', target:['chrome114'], minify:true, legalComments:'linked',metafile:true});
  const katexRoot = packageRoot('katex');
  fs.copyFileSync(path.join(katexRoot,'dist/katex.min.css'), path.join(out,'katex.min.css'));
  for (const name of fs.readdirSync(path.join(katexRoot,'dist/fonts'))) {
    fs.copyFileSync(path.join(katexRoot,'dist/fonts',name),path.join(out,'fonts',name));
  }
  const packages = dependencies.map(name => {
    const directory = packageRoot(name), pkg = JSON.parse(fs.readFileSync(path.join(directory,'package.json')));
    const license = ['LICENSE','LICENSE.md','LICENSE.txt','LICENSE-MIT','license','LICENSE-MIT.txt'].find(file=>fs.existsSync(path.join(directory,file)));
    if (license) fs.copyFileSync(path.join(directory,license),path.join(out,'licenses',name+'.txt'));
    return {name,version:pkg.version,license:pkg.license,source:typeof pkg.repository==='object'?pkg.repository.url:pkg.repository};
  });
  const bundledPackages=new Map();
  for(const input of Object.keys(build.metafile.inputs)){
    if(!input.includes('node_modules'))continue;
    let directory=path.dirname(path.resolve(repo,input));
    while(directory.startsWith(repo+path.sep)){
      const manifest=path.join(directory,'package.json');
      if(fs.existsSync(manifest)){
        const pkg=JSON.parse(fs.readFileSync(manifest));
        if(pkg.name){
          const key=pkg.name+'@'+pkg.version;
          if(!bundledPackages.has(key)){
            const license=['LICENSE','LICENSE.md','LICENSE.txt','LICENSE-MIT','license','license.md','license.txt'].find(file=>fs.existsSync(path.join(directory,file)));
            bundledPackages.set(key,{name:pkg.name,version:pkg.version,license:pkg.license,
              notice:license?fs.readFileSync(path.join(directory,license),'utf8'):'See linked bundle legal notices and upstream package.'});
          }
          break;
        }
      }
      directory=path.dirname(directory);
    }
  }
  const notices=[...bundledPackages.values()].sort((a,b)=>a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(out,'licenses','BUNDLED-NOTICES.txt'),notices.map(pkg=>`${pkg.name}@${pkg.version}\nLicense: ${pkg.license}\n\n${pkg.notice}`).join('\n\n========================================\n\n'));
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(out,file))).digest('hex');
  fs.writeFileSync(path.join(out,'provenance.json'),JSON.stringify({packages,bundledPackages:notices.map(({notice,...pkg})=>pkg),bundleSha256:hash('libraries.js'),
    font:{name:'NotoSansCJKsc-Regular.otf',source:'https://github.com/notofonts/noto-cjk/blob/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',license:'OFL-1.1',sha256:hash('fonts/NotoSansCJKsc-Regular.otf')}},null,2)+'\n');
  console.log('Local vendor bundle and font provenance updated.');
})();
