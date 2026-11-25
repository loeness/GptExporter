'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const chromiumExecutable=process.env.GPT_EXPORTER_CHROMIUM_EXECUTABLE||'';
const chromiumLaunchOptions=chromiumExecutable?{executablePath:chromiumExecutable}:{channel:'chromium'};
const bundledPython=path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe');
const pythonExecutable=process.env.GPT_EXPORTER_TEST_PYTHON||(fs.existsSync(bundledPython)?bundledPython:'python');
const output=path.join(root,'test-results','advanced-'+Date.now());
const downloadsPath=path.join(output,'downloads');
fs.mkdirSync(output,{recursive:true});
fs.mkdirSync(downloadsPath,{recursive:true});
const CID='11111111-1111-4111-8111-111111111111';
const SID='22222222-2222-4222-8222-222222222222';
const TID='33333333-3333-4333-8333-333333333333';
const denied='44444444-4444-4444-8444-444444444444';
function graph(id=CID){
  const mapping={root:{id:'root',parent:null,children:['u0'],message:null}};
  function add(id,parent,role,parts,metadata={}){
    mapping[id]={id,parent,children:[],message:{id,author:{role},create_time:1700000000+Object.keys(mapping).length,
      content:{content_type:'multimodal_text',parts},metadata}};
    if(parent)mapping[parent].children.push(id);
  }
  add('u0','root','user',['完整历史测试：请保留数学、图表和附件。']);
  const rich=String.raw`## 中文 PDF 与富内容验收

可搜索文字：精确还原测试 ABC123。citeturn0search0

行内数学 $E=mc^2$，显示公式：

$$\frac{1}{2}+\sqrt{x^2+y^2}=\int_0^1 t^2\,dt$$

~~~mermaid
flowchart LR
  A[输入数据] --> B[本地处理]
  B --> C[导出文档]
~~~

等待时间密度出现在下方。

$$f(x)=\lambda e^{-\lambda x},\qquad x\ge0$$

Rate \(\lambda\)

> **滑块**
>
> 当前值不可用。
>
> **范围：** 0.01 至 1
>
> **步长：** 0.01

---

静态曲线之后应保留此段说明 CTMC-PDF-FIXTURE。

| 项目 | 状态 |
| --- | --- |
| 历史与分支 | 完整 |
| 嵌入附件 | 保留原始字节 |

1. 父项
   - 子项甲
   - 子项乙
2. 后续父项

~~~python
if True:
    print("代码缩进仍在")
~~~`;
  add('a0','u0','assistant',[rich,{content_type:'image_asset_pointer',asset_pointer:'sediment://file-image-fixture'}],
    {attachments:[{id:'file-attachment-fixture',name:'notes.txt',mime_type:'text/plain'}]});
  add('tool-internal','a0','tool',['TOOL_SECRET_FIXTURE']);
  add('thinking-internal','tool-internal','assistant',['THINKING_SECRET_FIXTURE'],{channel:'analysis'});
  let parent='thinking-internal';
  for(let index=1;index<=8;index++){
    add('u'+index,parent,'user',[`历史问题 ${index}，此消息未出现在页面 DOM。`]);
    add('a'+index,'u'+index,'assistant',[Array.from({length:10},(_,line)=>`历史回答 ${index}.${line+1}：保留中文、标点和可搜索文本。分页后的内容也应完整。`).join('\n\n')]);
    parent='a'+index;
  }
  add('alternative','u0','assistant',['另一个分支的回答，不应混入当前路径。']);
  return {conversation_id:id,title:'完整历史与富内容测试',current_node:parent,mapping};
}
const html='<!doctype html><html><head><meta charset="utf-8"><title>Advanced fixture - ChatGPT</title></head><body><main><article data-testid="conversation-turn-1"><div data-message-author-role="assistant" data-message-id="a8"><p>页面只有最后一条。</p></div></article></main></body></html>';

function readPdfContent(file){
  const source=[
    'import sys,json,base64',
    'from pypdf import PdfReader',
    'reader=PdfReader(sys.argv[1])',
    'bodyFontSizes=[]',
    "text='\\n'.join(page.extract_text(visitor_text=lambda text,cm,tm,font,size: bodyFontSizes.append(size) if 'ABC123' in text else None) or '' for page in reader.pages)",
    "attachments={name:[base64.b64encode(data).decode('ascii') for data in files] for name,files in reader.attachments.items()}",
    'images=[entry.image.convert("RGB") for page in reader.pages for entry in page.images]',
    "chartColors=[dict((color,count) for count,color in image.getcolors(image.width*image.height)) for image in images if image.size==(1440,800)]",
    "chartCurvePixels=[[colors.get(color,0) for color in [(21,101,168),(115,63,153),(178,77,21)]] for colors in chartColors]",
    "print(json.dumps({'text':text,'images':len(images),'chartCurvePixels':chartCurvePixels,'attachments':attachments,'pages':len(reader.pages),'bodyFontSizes':bodyFontSizes},ensure_ascii=False))"
  ].join(';');
  return JSON.parse(execFileSync(pythonExecutable,['-c',source,file],{encoding:'utf8'}));
}
function assertStaticChart(pdf){
  assert.match(pdf.text,/等待时间密度出现在下方/);
  assert.match(pdf.text,/指数分布概率密度（静态图）/);
  assert.match(pdf.text,/示例速率/);
  assert.match(pdf.text,/静态曲线之后应保留此段说明 CTMC-PDF-FIXTURE/);
  assert.doesNotMatch(pdf.text,/滑块|当前值不可用|范围：|步长：/,'obsolete slider controls are excluded');
  assert.doesNotMatch(pdf.text,/输入数据|本地处理|导出文档/,'Mermaid remains excluded from PDF');
  assert.equal(pdf.images,5,'PDF embeds the original image, three formulas and one static chart');
  assert.equal(pdf.chartCurvePixels.length,1,'PDF embeds one chart-sized raster image');
  assert.ok(pdf.chartCurvePixels[0].every(count=>count>300),'embedded chart must include all three colored curves');
}
function renderPdfFirstPage(file,png){
  const source="import sys; import pypdfium2 as pdfium; document=pdfium.PdfDocument(sys.argv[1]); document[0].render(scale=1.6).to_pil().save(sys.argv[2])";
  execFileSync(pythonExecutable,['-c',source,file,png]);
  return png;
}
function isPdfFile(file){
  try{return fs.readFileSync(file).subarray(0,5).toString()==='%PDF-';}catch{return false;}
}

(async()=>{
  let context;const errors=[],outbound=[],checks=[];
  try{
    if(chromiumExecutable)assert.ok(fs.existsSync(chromiumExecutable),'configured test Chromium executable is missing: '+chromiumExecutable);
    context=await chromium.launchPersistentContext(path.join(output,'profile'),{...chromiumLaunchOptions,downloadsPath,headless:true,acceptDownloads:true,
      viewport:{width:1440,height:1000},args:['--disable-extensions-except='+path.join(root,'extension'),'--load-extension='+path.join(root,'extension')]});
    context.on('page',page=>page.on('pageerror',error=>errors.push({url:page.url(),error:error.stack||error.message})));
    await context.route(/^https?:\/\//,async route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='chatgpt.com'){outbound.push(url.origin);return route.abort();}
      const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname==='/api/auth/session')return json({accessToken:'fixture-only-token'});
      if(url.pathname==='/backend-api/conversation/'+denied)return route.fulfill({status:403,body:'denied'});
      if(url.pathname.startsWith('/backend-api/conversation/'))return json(graph(url.pathname.split('/').at(-1)));
      if(url.pathname.startsWith('/backend-api/share/'))return json({data:graph(SID)});
      if(url.pathname.startsWith('/backend-api/files/download/')){
        const image=url.pathname.includes('image');return json({download_url:'https://files.oaiusercontent.com/fixture/'+(image?'image':'notes'),file_name:image?'diagram.png':'notes.txt',mime_type:image?'image/png':'text/plain'});
      }
      if(url.pathname==='/backend-api/f/conversation')return route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({conversation_id:TID})+'\n\ndata: [DONE]\n\n'});
      return route.fulfill({contentType:'text/html;charset=utf-8',body:html});
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const base='chrome-extension://'+new URL(worker.url()).hostname+'/';
    const scratch=await context.newPage();
    const imageData=await scratch.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=240;canvas.height=100;const g=canvas.getContext('2d');g.fillStyle='#e7f2ec';g.fillRect(0,0,240,100);g.fillStyle='#286852';g.fillRect(20,20,90,60);g.fillStyle='#89ad7e';g.fillRect(130,20,90,60);return canvas.toDataURL('image/png');});
    await scratch.close();
    await worker.evaluate(({imageData})=>{
      globalThis.fetch=async url=>{
        if(url==='https://files.oaiusercontent.com/fixture/image')return new Response(Uint8Array.from(atob(imageData.split(',')[1]),ch=>ch.charCodeAt(0)),{headers:{'content-type':'image/png'}});
        if(url==='https://files.oaiusercontent.com/fixture/notes')return new Response('附件原始内容：保留字节。\nfixture attachment\n',{headers:{'content-type':'text/plain'}});
        throw new Error('Unexpected network request blocked by test');
      };
    },{imageData});
    async function collect(url){
      const page=await context.newPage();await page.goto(url);await page.waitForSelector('#gpt-exporter-launcher');
      const response=await worker.evaluate(async url=>{const [tab]=await chrome.tabs.query({url});return chrome.tabs.sendMessage(tab.id,{type:'GPT_EXPORTER_COLLECT'});},url);
      assert.equal(response.ok,true);return {page,model:response.conversation};
    }
    const {page:chat,model}=await collect('https://chatgpt.com/c/'+CID);
    assert.equal(model.messages.length,21);assert.equal(model.branches.length,2);assert.equal(model.source.complete,true);
    assert.equal(model.assets.length,2);assert.ok(!JSON.stringify(model).includes('fixture-only-token'));
    checks.push('full API graph beyond mounted DOM','all branches','no token in exported model');
    const [tab]=await worker.evaluate(async url=>chrome.tabs.query({url}),'https://chatgpt.com/c/'+CID);
    const popup=await context.newPage();await popup.goto(base+'popup.html');
    await popup.locator('#setting-show-toolbar').uncheck();
    await chat.waitForFunction(()=>document.getElementById('gpt-exporter-launcher')?.hidden === true);
    await popup.locator('#setting-show-toolbar').check();
    await chat.waitForFunction(()=>document.getElementById('gpt-exporter-launcher')?.hidden === false);
    checks.push('popup switch hides and restores the page launcher');
    await popup.locator('#setting-message-timestamp').check();
    await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),tab.id);
    const readerPromise=context.waitForEvent('page');await chat.locator('#gpt-exporter-select').click();
    const reader=await readerPromise;reader.setDefaultTimeout(30000);await reader.waitForSelector('#message-list input');
    assert.equal(await reader.locator('#message-list input').count(),18);
    await reader.waitForSelector('.katex');await reader.waitForSelector('svg.ge-mermaid-diagram');
    assert.ok(await reader.locator('.katex svg path').count()>0,'KaTeX radical SVG must survive sanitization');
    const diagramText=await reader.locator('svg.ge-mermaid-diagram').textContent();
    for(const label of ['输入数据','本地处理','导出文档'])assert.ok(diagramText.includes(label),'Mermaid label missing: '+label);
    assert.equal(await reader.locator('svg.ge-mermaid-diagram foreignObject').count(),0);
    checks.push('page SELECT to full reader','KaTeX rendering','Mermaid rendering');
    const uploadedImage='#preview-content img[src^="data:image/"]:not(.ge-static-demo-image)';
    await reader.waitForSelector(uploadedImage);
    await reader.waitForSelector('#preview-content figure.ge-static-demo img.ge-static-demo-image');
    assert.doesNotMatch(await reader.locator('#preview-content').innerText(), /TOOL_SECRET_FIXTURE|THINKING_SECRET_FIXTURE|turn0search0/);
    assert.equal(await reader.locator('#preview-content article[data-role="user"]').count(),9);
    assert.equal(await reader.locator('#preview-content article[data-role="assistant"]').count(),9);
    checks.push('automatic image preview and filtering of internal messages and citations');
    await reader.locator('#load-media').click();
    await reader.waitForFunction(()=>!document.getElementById('load-media').disabled);
    const assetResponses=await reader.evaluate(async ids=>{const exportId=new URL(location.href).searchParams.get('id');return Promise.all(ids.map(assetId=>chrome.runtime.sendMessage({type:'GPT_EXPORTER_ASSET',exportId,assetId})));},model.assets.map(asset=>asset.id));
    fs.writeFileSync(path.join(output,'media-debug.json'),JSON.stringify({assets:model.assets,assetResponses,status:await reader.locator('#status-line').innerText(),preview:await reader.locator('#preview-content').innerHTML()},null,2));
    assert.equal(await reader.locator(uploadedImage).count(),1);
    await reader.waitForSelector('#preview-content a[download="notes.txt"]');
    checks.push('signed raster media via approved background transport','attachment original bytes in memory');
    await reader.screenshot({path:path.join(output,'rich-reader.png'),fullPage:false});
    await reader.evaluate(()=>{
      const vector=GptExporterVendors.renderMathSvg;window.__vectorMathCalls=0;window.__htmlMathCalls=0;
      GptExporterVendors.renderMathSvg=(...args)=>{window.__vectorMathCalls++;return vector(...args);};
      const original=GptExporterVendors.html2canvas;
      GptExporterVendors.html2canvas=async function(node,options){
        window.__htmlMathCalls++;
        try{return await original(node,options);}catch(error){
          (window.__mathRenderFailures||(window.__mathRenderFailures=[])).push({message:error.message,rect:{width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height},tex:node.getAttribute('data-ge-tex')});throw error;
        }
      };
    });
    const htmlPromise=reader.waitForEvent('download');await reader.locator('[data-format="html"]').click();
    const htmlDownload=await htmlPromise;const htmlPath=path.join(output,'rich.html');await htmlDownload.saveAs(htmlPath);
    const exported=fs.readFileSync(htmlPath,'utf8');
    fs.writeFileSync(path.join(output,'math-debug.json'),JSON.stringify(await reader.evaluate(()=>window.__mathRenderFailures||[]),null,2));
    const mathCalls=await reader.evaluate(()=>({vector:window.__vectorMathCalls,html:window.__htmlMathCalls}));
    assert.ok(mathCalls.vector>=2);assert.equal(mathCalls.html,0,'test formulas must use complete vector paths rather than HTML fallback');
    assert.match(exported,/data:image\/png;base64,/);assert.doesNotMatch(exported,/<script\b|<iframe\b|<svg\b|src="https?:/i);
    const offline=await context.newPage();await offline.goto('file:///'+htmlPath.replace(/\\/g,'/'));
    assert.ok(await offline.locator('img').count()>=3,'HTML should embed image, equation snapshots and diagram');
    assert.equal(await offline.locator('img[alt^="TeX:"]').count(),3,'inline and display formulas must be preserved visually');
    const attachmentPromise=offline.waitForEvent('download');await offline.locator('a[download="notes.txt"]').click();
    const attachmentDownload=await attachmentPromise;
    assert.equal(fs.readFileSync(await attachmentDownload.path(),'utf8'),'附件原始内容：保留字节。\nfixture attachment\n');
    await offline.screenshot({path:path.join(output,'offline-html.png'),fullPage:false});await offline.close();
    checks.push('standalone rich HTML without external resources');
    const pdfDialog=reader.locator('#pdf-preview-dialog');
    const readerTimestamp=await reader.locator('#preview-content article h2 time').first().innerText();
    assert.ok(readerTimestamp,'Reader displays enabled message timestamps before PDF export');
    const pdfViewerErrors=[];
    reader.on('console',message=>{
      if(message.type()==='error' && /blob:|pdf-viewer|Content Security Policy/i.test(message.text())){
        pdfViewerErrors.push(message.text());
      }
    });
    let observedDownloads=0;
    const countDownload=()=>observedDownloads++;
    reader.on('download',countDownload);
    await reader.locator('[data-format="pdf"]').click();
    await pdfDialog.waitFor({state:'visible'});
    let explicitDownloads=0;
    const downloadPreview=async (name,previousUrl='')=>{
      const frameUrl=await reader.waitForFunction(previous=>{
        const frame=document.querySelector('#pdf-preview-frame');
        const download=document.querySelector('#pdf-preview-download');
        return frame?.src.startsWith('blob:') && frame.src!==previous && !download?.disabled && frame.src;
      },previousUrl,{timeout:60000});
      await reader.locator('#pdf-preview-frame').waitFor({state:'visible'});
      const url=await frameUrl.jsonValue();
      const previewHash=await reader.evaluate(async url=>{
        const response=await fetch(url);
        const digest=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
        return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      },url);
      assert.equal(observedDownloads,explicitDownloads,'opening or updating the preview does not automatically download the PDF');
      const pending=reader.waitForEvent('download',{timeout:60000});
      explicitDownloads++;
      await reader.locator('#pdf-preview-download').click();
      const file=path.join(output,name);
      await (await pending).saveAs(file);
      const bytes=fs.readFileSync(file);
      assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
      assert.equal(createHash('sha256').update(bytes).digest('hex'),previewHash,'the download uses the PDF displayed in the preview');
      return {file,url,content:readPdfContent(file)};
    };
    const initialPdf=await downloadPreview('rich.pdf');
    const pdfPath=initialPdf.file;
    const nativeFrame=await reader.locator('#pdf-preview-frame').elementHandle();
    const pdfFrame=await nativeFrame.contentFrame();
    assert.ok(pdfFrame,'the PDF is loaded in a browser frame');
    await pdfFrame.waitForURL(initialPdf.url);
    await reader.screenshot({path:path.join(output,'reader-pdf-preview.png')});
    assert.deepEqual(pdfViewerErrors,[],'the browser permits the PDF viewer to load');
    renderPdfFirstPage(pdfPath,path.join(output,'reader-pdf-page-1.png'));
    assert.match(initialPdf.content.text,/精确还原测试 ABC123/);
    assert.match(initialPdf.content.text,/历史回答 8\.10/);
    assert.doesNotMatch(initialPdf.content.text,/TOOL_SECRET_FIXTURE|THINKING_SECRET_FIXTURE|turn0search0|另一个分支的回答/);
    assert.ok(!initialPdf.content.text.replace(/\s/g,'').includes(readerTimestamp.replace(/\s/g,'')),'Reader PDF excludes message timestamps');
    assert.doesNotMatch(initialPdf.content.text,/整理消息|搜索消息内容|复制 Markdown|系统打印|下载到本地设备/,'Reader controls are excluded from the PDF');
    assertStaticChart(initialPdf.content);
    assert.doesNotMatch(initialPdf.content.text,/notes\.txt/,'assistant attachment notices are excluded from the Reader PDF');
    assert.deepEqual(initialPdf.content.attachments,{},'the Reader PDF excludes files attached to assistant messages');
    const fontSize=reader.locator('#pdf-font-size');
    assert.deepEqual(await fontSize.evaluate(input=>[input.min,input.max,input.step]),['8','13','1']);
    const density=reader.locator('#pdf-density');
    assert.deepEqual(await density.locator('option').evaluateAll(options=>options.map(option=>option.value)),['compact','standard','roomy']);
    const previousDensity=await density.inputValue();
    await density.selectOption('roomy');
    const roomy=previousDensity==='roomy'?initialPdf:await downloadPreview('rich-roomy.pdf',initialPdf.url);
    await density.selectOption('compact');
    const compact=await downloadPreview('rich-compact.pdf',roomy.url);
    assert.ok(compact.content.pages<roomy.content.pages,
      `Compact density should reduce pagination at the same font size (${compact.content.pages} vs ${roomy.content.pages})`);
    assert.match(compact.content.text,/精确还原测试 ABC123/);
    assert.equal((compact.content.text.match(/历史回答 \d+\.\d+：/g)||[]).length,80);
    assert.equal(compact.content.images,roomy.content.images);
    const originalFontSize=await fontSize.inputValue();
    const alternateSize=originalFontSize==='13'?'8':'13';
    await fontSize.press(alternateSize==='8'?'Home':'End');
    const resized=await downloadPreview('rich-resized.pdf',compact.url);
    assert.match(resized.content.text,/精确还原测试 ABC123/);
    assert.deepEqual(compact.content.bodyFontSizes,[Number(originalFontSize)]);
    assert.deepEqual(resized.content.bodyFontSizes,[Number(alternateSize)],'the selected size changes body text in the PDF itself');
    await reader.keyboard.press('Escape');
    await pdfDialog.waitFor({state:'hidden'});
    reader.off('download',countDownload);
    checks.push('Reader PDF preview and download share bytes, retain rich content, and respect density');
    const options=await reader.locator('#branch-select option').allTextContents();
    assert.equal(options.length,3);await reader.locator('#branch-select').selectOption('__all');
    assert.equal(await reader.locator('#message-list input').count(),19);
    const alternativeOption=await reader.locator('#branch-select option').evaluateAll(items=>items.find(item=>/2 条/.test(item.textContent))?.value);
    assert.ok(alternativeOption);await reader.locator('#branch-select').selectOption(alternativeOption);
    assert.equal(await reader.locator('#preview-content article').count(),2);
    assert.doesNotMatch(await reader.locator('#preview-content').innerText(),/历史回答 8/);
    checks.push('branch switching and deduplicated all-branch selection');
    // Quick presets must filter the complete active API branch, even though only a8 is mounted.
    const pageUrlsBeforeQuick=context.pages().map(page=>page.url()).sort();
    const sessionKeysBeforeQuick=await worker.evaluate(async()=>Object.keys(await chrome.storage.session.get(null)).filter(key=>key.startsWith('export:')).sort());
    const chromeDownloads=()=>worker.evaluate(()=>chrome.downloads.search({}));
    const quickStatus=()=>chat.evaluate(()=>{
      const shadow=document.querySelector('#gpt-exporter-launcher')?.shadowRoot;
      const status=shadow?.querySelector('.status');
      return {text:status?.textContent||'',phase:status?.dataset.phase||status?.getAttribute('data-phase')||'',
        selectDisabled:Boolean(shadow?.querySelector('#gpt-exporter-select')?.disabled)};
    });
    const waitForQuickPdf=async beforeIds=>{
      const deadline=Date.now()+180000;
      let nextProgress=0;
      while(Date.now()<deadline){
        const items=await chromeDownloads();
        const created=items.filter(item=>!beforeIds.has(item.id));
        const interrupted=created.find(item=>item.state==='interrupted');
        if(interrupted)throw new Error('Quick PDF download was interrupted: '+(interrupted.error||interrupted.filename));
        const completed=created.find(item=>item.state==='complete'&&fs.existsSync(item.filename)&&isPdfFile(item.filename));
        if(completed)return completed;
        if(Date.now()>=nextProgress){
          const status=await quickStatus();
          const snapshot={updatedAt:new Date().toISOString(),status};
          fs.writeFileSync(path.join(output,'quick-export-status.json'),JSON.stringify(snapshot,null,2));
          console.log('Quick export progress: '+JSON.stringify(status));
          nextProgress=Date.now()+10000;
          if(status.text&&!status.text.startsWith('正在')&&!status.text.startsWith('已导出'))throw new Error('Quick export reported an error before downloading: '+JSON.stringify(status));
        }
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      throw new Error('Timed out waiting for a completed quick PDF download; page status: '+JSON.stringify(await quickStatus()));
    };
    const quickPdf=async(preset,count)=>{
      await chat.bringToFront();
      const beforeIds=new Set((await chromeDownloads()).map(item=>item.id));
      await chat.locator('#gpt-exporter-menu-toggle').click();
      await chat.locator('#gpt-exporter-selection-menu [data-preset="'+preset+'"]').click();
      const item=await waitForQuickPdf(beforeIds);
      assert.deepEqual(context.pages().map(page=>page.url()).sort(),pageUrlsBeforeQuick,'quick PDF export must not open tabs or a reader page');
      assert.equal(await chat.locator('[data-gpt-exporter-selection]').count(),0,'quick export must not add message selection controls');
      await chat.waitForFunction(expected=>{
        const shadow=document.querySelector('#gpt-exporter-launcher')?.shadowRoot;
        return shadow?.querySelector('.status')?.textContent.includes('已导出 '+expected+' 条消息为 PDF') &&
          !shadow?.querySelector('#gpt-exporter-select')?.disabled;
      },count);
      const status=await chat.evaluate(()=>document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('.status')?.textContent||'');
      assert.match(status,new RegExp('已导出 '+count+' 条消息为 PDF'));
      const sessionKeys=await worker.evaluate(async()=>Object.keys(await chrome.storage.session.get(null)).filter(key=>key.startsWith('export:')).sort());
      assert.deepEqual(sessionKeys,sessionKeysBeforeQuick,'quick export session data is removed after download');
      const offscreen=await worker.evaluate(async()=>{
        const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
        return contexts.filter(context=>context.documentUrl===chrome.runtime.getURL('direct-export.html')).length;
      });
      assert.equal(offscreen,0,'quick export closes its offscreen document after download');
      return {file:item.filename,...readPdfContent(item.filename)};
    };
    const allQuick=await quickPdf('all',18);const allQuickText=allQuick.text;
    assert.doesNotMatch(allQuickText,/TOOL_SECRET_FIXTURE|THINKING_SECRET_FIXTURE|turn0search0/);
    assert.match(allQuickText,/完整历史测试：请保留数学、图表和附件/);
    assert.match(allQuickText,/历史问题 8/);
    assert.match(allQuickText,/历史回答 8\.10/);
    assert.doesNotMatch(allQuickText,/另一个分支的回答/,'All must not include the alternative branch');
    assert.equal((allQuickText.match(/历史问题 \d+，/g)||[]).length,8,'All includes the eight historical user turns');
    assert.equal((allQuickText.match(/历史回答 \d+\.\d+：/g)||[]).length,80,'All includes all eight numbered historical assistant answers');
    assertStaticChart(allQuick);
    assert.doesNotMatch(allQuickText,/notes\.txt/,'assistant attachment notices are excluded from the quick PDF');
    assert.deepEqual(allQuick.attachments,{},'All quick PDF excludes files attached to assistant messages');
    const quickPdfPreviewPath=renderPdfFirstPage(allQuick.file,path.join(output,'quick-all-page-1.png'));
    checks.push('Reader preview and All quick PDF retain complete history, image, formulas and a nonblank static chart');
    const questionsQuick=await quickPdf('questions',9);const questionsQuickText=questionsQuick.text;
    assert.match(questionsQuickText,/完整历史测试：请保留数学、图表和附件/);
    for(let index=1;index<=8;index++)assert.match(questionsQuickText,new RegExp('历史问题 '+index));
    assert.doesNotMatch(questionsQuickText,/历史回答 \d+\./,'Questions quick PDF contains user messages only');
    assert.doesNotMatch(questionsQuickText,/另一个分支的回答/);
    checks.push('Questions quick PDF contains all nine user messages beyond mounted DOM only');
    const answersQuick=await quickPdf('answers',9);const answersQuickText=answersQuick.text;
    assert.match(answersQuickText,/可搜索文字：精确还原测试 ABC123/);
    assert.match(answersQuickText,/历史回答 8\.10/);
    assert.doesNotMatch(answersQuickText,/完整历史测试：请保留数学、图表和附件|历史问题 \d+/,'Answers quick PDF contains assistant messages only');
    assert.doesNotMatch(answersQuickText,/另一个分支的回答/);
    assert.equal((answersQuickText.match(/历史回答 \d+\.\d+：/g)||[]).length,80,'Answers contains all eight numbered historical assistant answers');
    checks.push('Answers quick PDF contains assistant history only');
    await worker.evaluate(async()=>chrome.storage.local.set({'gptExporter.exportSettings':{
      showToolbarButton:true,closeSelectionAfterExport:true,filenameFormat:'custom-title',customFilenamePrefix:'课程',
      includeConversationLink:false,includeMessageTimestamp:true,includeTitleInNonPdf:false,
      includeUserName:true,userName:'测试用户',dateFormat:'YYYY-MM-DD',timeFormat:'24h',
      customizeRoleNames:true,roleNames:{user:'提问',assistant:'回答'},copyToClipboardAfterExport:true
    }}));
    const settingsPopup=await context.newPage();await settingsPopup.goto(base+'popup.html');
    await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),tab.id);
    const secondReaderPromise=context.waitForEvent('page');await chat.locator('#gpt-exporter-select').click();
    const secondReader=await secondReaderPromise;secondReader.setDefaultTimeout(30000);await secondReader.waitForSelector('#message-list input');
    let requestedFilename='', clipboardCopied=false;
    secondReader.on('console',message=>{if(message.text().startsWith('fixture filename:'))requestedFilename=message.text().slice('fixture filename:'.length);if(message.text()==='fixture clipboard:ok')clipboardCopied=true;});
    await secondReader.evaluate(()=>{const download=chrome.downloads.download.bind(chrome.downloads);chrome.downloads.download=options=>{console.log('fixture filename:'+options.filename);return download(options);};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){if(text.includes('测试用户')&&text.includes('## 提问'))console.log('fixture clipboard:ok');}}});});
    const closePromise=secondReader.waitForEvent('close',{timeout:30000});
    const configuredDownloadPromise=secondReader.waitForEvent('download',{timeout:30000});
    await secondReader.locator('[data-format="markdown"]').click();
    const configuredDownload=await configuredDownloadPromise;
    const configuredText=fs.readFileSync(await configuredDownload.path(),'utf8');
    await closePromise;
    assert.match(requestedFilename,/^课程-/);
    assert.equal(clipboardCopied,true,'configured non-PDF export copies the generated contents before closing');
    assert.match(configuredText,/测试用户/);assert.match(configuredText,/## 提问/);assert.match(configuredText,/## 回答/);
    assert.doesNotMatch(configuredText,/完整历史与富内容测试|https:\/\/chatgpt\.com\/c\//);
    assert.match(configuredText,/2023\\?-11\\?-\d\d/);
    checks.push('stored preferences apply to actual download and close the reader after completion');
    await worker.evaluate(async()=>chrome.storage.local.remove('gptExporter.exportSettings'));
    const shared=await collect('https://chatgpt.com/share/'+SID);assert.equal(shared.model.source.kind,'shared');assert.equal(shared.model.messages.length,21);await shared.page.close();
    checks.push('shared conversation API');
    const loaderPage=await context.newPage();
    await loaderPage.addInitScript(raw=>{window.__reactRouterContext={state:{loaderData:{'routes/share.$shareId.($action)':{serverResponse:{data:raw}}}}};},graph(SID));
    await loaderPage.goto('https://chatgpt.com/share/e/'+SID);await loaderPage.waitForSelector('#gpt-exporter-launcher');
    const loaderModel=await worker.evaluate(async url=>{const [tab]=await chrome.tabs.query({url});return chrome.tabs.sendMessage(tab.id,{type:'GPT_EXPORTER_COLLECT'});},loaderPage.url());
    assert.equal(loaderModel.ok,true);assert.equal(loaderModel.conversation.source.kind,'shared');assert.equal(loaderModel.conversation.messages.length,21);await loaderPage.close();
    checks.push('shared React Router loader snapshot');
    const temp=await context.newPage();await temp.goto('https://chatgpt.com/?temporary-chat=true');await temp.waitForSelector('#gpt-exporter-launcher');
    await temp.evaluate(async()=>{await (await fetch('/backend-api/f/conversation',{method:'POST',headers:{Accept:'text/event-stream'}})).text();});
    const temporary=await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({url:'https://chatgpt.com/?temporary-chat=true'});return chrome.tabs.sendMessage(tab.id,{type:'GPT_EXPORTER_COLLECT'});});
    assert.equal(temporary.ok,true);assert.equal(temporary.conversation.source.kind,'temporary');assert.equal(temporary.conversation.messages.length,21);assert.equal(temporary.conversation.source.complete,true);
    checks.push('temporary SSE ID to complete conversation API');await temp.close();
    const partial=await collect('https://chatgpt.com/c/'+denied);assert.equal(partial.model.source.complete,false);assert.equal(partial.model.messages.length,1);await partial.page.close();
    checks.push('403 fallback visibly marked partial');
    assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);
    const report={status:'passed',chromium:context.browser().version(),checks,pdfPath,htmlPath,quickPdfPreviewPath,
      quickPdfPaths:{all:allQuick.file,questions:questionsQuick.file,answers:answersQuick.file}};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }catch(error){fs.writeFileSync(path.join(output,'failure.txt'),error.stack||String(error));console.error(error);process.exitCode=1;}
  finally{if(context)await context.close();}
})();
