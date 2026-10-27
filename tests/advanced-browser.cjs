'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'test-results','advanced-'+Date.now());
fs.mkdirSync(output,{recursive:true});
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

可搜索文字：精确还原测试 ABC123。

行内数学 $E=mc^2$，显示公式：

$$\frac{1}{2}+\sqrt{x^2+y^2}=\int_0^1 t^2\,dt$$

~~~mermaid
flowchart LR
  A[输入数据] --> B[本地处理]
  B --> C[导出文档]
~~~

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
  let parent='a0';
  for(let index=1;index<=8;index++){
    add('u'+index,parent,'user',[`历史问题 ${index}，此消息未出现在页面 DOM。`]);
    add('a'+index,'u'+index,'assistant',[Array.from({length:10},(_,line)=>`历史回答 ${index}.${line+1}：保留中文、标点和可搜索文本。分页后的内容也应完整。`).join('\n\n')]);
    parent='a'+index;
  }
  add('alternative','u0','assistant',['另一个分支的回答，不应混入当前路径。']);
  return {conversation_id:id,title:'完整历史与富内容测试',current_node:parent,mapping};
}
const html='<!doctype html><html><head><meta charset="utf-8"><title>Advanced fixture - ChatGPT</title></head><body><main><article data-testid="conversation-turn-1"><div data-message-author-role="assistant" data-message-id="a8"><p>页面只有最后一条。</p></div></article></main></body></html>';

(async()=>{
  let context;const errors=[],outbound=[],checks=[];
  try{
    context=await chromium.launchPersistentContext(path.join(output,'profile'),{channel:'chromium',headless:true,acceptDownloads:true,
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
    assert.equal(model.messages.length,19);assert.equal(model.branches.length,2);assert.equal(model.source.complete,true);
    assert.equal(model.assets.length,2);assert.ok(!JSON.stringify(model).includes('fixture-only-token'));
    checks.push('full API graph beyond mounted DOM','all branches','no token in exported model');
    const [tab]=await worker.evaluate(async url=>chrome.tabs.query({url}),'https://chatgpt.com/c/'+CID);
    const popup=await context.newPage();await popup.goto(base+'popup.html');
    await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),tab.id);
    const readerPromise=context.waitForEvent('page');await popup.evaluate(()=>document.getElementById('open').click());
    const reader=await readerPromise;reader.setDefaultTimeout(30000);await reader.waitForSelector('#message-list input');
    assert.equal(await reader.locator('#message-list input').count(),18);
    await reader.waitForSelector('.katex');await reader.waitForSelector('svg.ge-mermaid-diagram');
    assert.ok(await reader.locator('.katex svg path').count()>0,'KaTeX radical SVG must survive sanitization');
    const diagramText=await reader.locator('svg.ge-mermaid-diagram').textContent();
    for(const label of ['输入数据','本地处理','导出文档'])assert.ok(diagramText.includes(label),'Mermaid label missing: '+label);
    assert.equal(await reader.locator('svg.ge-mermaid-diagram foreignObject').count(),0);
    checks.push('real popup to full reader','KaTeX rendering','Mermaid rendering');
    await reader.locator('#load-media').click();
    await reader.waitForFunction(()=>!document.getElementById('load-media').disabled);
    const assetResponses=await reader.evaluate(async ids=>{const exportId=new URL(location.href).searchParams.get('id');return Promise.all(ids.map(assetId=>chrome.runtime.sendMessage({type:'GPT_EXPORTER_ASSET',exportId,assetId})));},model.assets.map(asset=>asset.id));
    fs.writeFileSync(path.join(output,'media-debug.json'),JSON.stringify({assets:model.assets,assetResponses,status:await reader.locator('#status-line').innerText(),preview:await reader.locator('#preview-content').innerHTML()},null,2));
    assert.equal(await reader.locator('#preview-content img[src^="data:image/"]').count(),1);
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
    assert.equal(await offline.locator('img[alt^="TeX:"]').count(),2,'both inline and display formulas must be preserved visually');
    const attachmentPromise=offline.waitForEvent('download');await offline.locator('a[download="notes.txt"]').click();
    const attachmentDownload=await attachmentPromise;
    assert.equal(fs.readFileSync(await attachmentDownload.path(),'utf8'),'附件原始内容：保留字节。\nfixture attachment\n');
    await offline.screenshot({path:path.join(output,'offline-html.png'),fullPage:false});await offline.close();
    checks.push('standalone rich HTML without external resources');
    const pdfPromise=reader.waitForEvent('download',{timeout:60000});await reader.locator('[data-format="pdf"]').click();
    const pdfDownload=await pdfPromise;const pdfPath=path.join(output,'rich.pdf');await pdfDownload.saveAs(pdfPath);
    assert.match(fs.readFileSync(pdfPath).subarray(0,8).toString(),/^%PDF-/);checks.push('direct local PDF download');
    const options=await reader.locator('#branch-select option').allTextContents();
    assert.equal(options.length,3);await reader.locator('#branch-select').selectOption('__all');
    assert.equal(await reader.locator('#message-list input').count(),19);
    const alternativeOption=await reader.locator('#branch-select option').evaluateAll(items=>items.find(item=>/2 条/.test(item.textContent))?.value);
    assert.ok(alternativeOption);await reader.locator('#branch-select').selectOption(alternativeOption);
    assert.equal(await reader.locator('#preview-content article').count(),2);
    assert.doesNotMatch(await reader.locator('#preview-content').innerText(),/历史回答 8/);
    checks.push('branch switching and deduplicated all-branch selection');
    const shared=await collect('https://chatgpt.com/share/'+SID);assert.equal(shared.model.source.kind,'shared');assert.equal(shared.model.messages.length,19);await shared.page.close();
    checks.push('shared conversation API');
    const loaderPage=await context.newPage();
    await loaderPage.addInitScript(raw=>{window.__reactRouterContext={state:{loaderData:{'routes/share.$shareId.($action)':{serverResponse:{data:raw}}}}};},graph(SID));
    await loaderPage.goto('https://chatgpt.com/share/e/'+SID);await loaderPage.waitForSelector('#gpt-exporter-launcher');
    const loaderModel=await worker.evaluate(async url=>{const [tab]=await chrome.tabs.query({url});return chrome.tabs.sendMessage(tab.id,{type:'GPT_EXPORTER_COLLECT'});},loaderPage.url());
    assert.equal(loaderModel.ok,true);assert.equal(loaderModel.conversation.source.kind,'shared');assert.equal(loaderModel.conversation.messages.length,19);await loaderPage.close();
    checks.push('shared React Router loader snapshot');
    const temp=await context.newPage();await temp.goto('https://chatgpt.com/?temporary-chat=true');await temp.waitForSelector('#gpt-exporter-launcher');
    await temp.evaluate(async()=>{await (await fetch('/backend-api/f/conversation',{method:'POST',headers:{Accept:'text/event-stream'}})).text();});
    const temporary=await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({url:'https://chatgpt.com/?temporary-chat=true'});return chrome.tabs.sendMessage(tab.id,{type:'GPT_EXPORTER_COLLECT'});});
    assert.equal(temporary.ok,true);assert.equal(temporary.conversation.source.kind,'temporary');assert.equal(temporary.conversation.messages.length,19);assert.equal(temporary.conversation.source.complete,true);
    checks.push('temporary SSE ID to complete conversation API');await temp.close();
    const partial=await collect('https://chatgpt.com/c/'+denied);assert.equal(partial.model.source.complete,false);assert.equal(partial.model.messages.length,1);await partial.page.close();
    checks.push('403 fallback visibly marked partial');
    assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);
    const report={status:'passed',chromium:context.browser().version(),checks,pdfPath,htmlPath};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }catch(error){fs.writeFileSync(path.join(output,'failure.txt'),error.stack||String(error));console.error(error);process.exitCode=1;}
  finally{if(context)await context.close();}
})();
