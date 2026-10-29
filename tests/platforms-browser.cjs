'use strict';
// Real unpacked MV3 extension in isolated Chromium. Other AI sites are synthetic DOM fixtures.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const extensionPath=path.join(root,'extension');
const output=path.join(root,'test-results','platforms-'+Date.now());
const downloadsPath=path.join(output,'downloads');
const bundledPython=path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe');
const pythonExecutable=process.env.GPT_EXPORTER_TEST_PYTHON||(fs.existsSync(bundledPython)?bundledPython:'python');
const providers=[
  {id:'claude',label:/Claude|克劳德/i,origin:'https://claude.ai',path:'/chat/multiplatform-fixture'},
  {id:'qwen',label:/Qwen|通义千问/i,origin:'https://chat.qwen.ai',path:'/chat/multiplatform-fixture',quickPreset:'questions'},
  {id:'deepseek',label:/DeepSeek/i,origin:'https://chat.deepseek.com',path:'/a/chat/multiplatform-fixture',quickPreset:'answers'},
  {id:'kimi',label:/Kimi/i,origin:'https://www.kimi.com',path:'/chat/multiplatform-fixture'},
  {id:'kimi',label:/Kimi/i,origin:'https://www.kimi.ai',path:'/en/chat/multiplatform-fixture',quickPreset:'questions'},
  {id:'kimi',label:/Kimi/i,origin:'https://kimi.ai',path:'/en/chat/multiplatform-fixture'},
  {id:'gemini',label:/Gemini/i,origin:'https://gemini.google.com',path:'/app/multiplatform-fixture'},
  {id:'doubao',label:/Doubao|豆包/i,origin:'https://www.doubao.com',path:'/chat/multiplatform-fixture'},
  {id:'grok',label:/Grok/i,origin:'https://grok.com',path:'/c/multiplatform-fixture'}
];

const questionOne=id=>`PLATFORM_${id.toUpperCase()}_QUESTION_ONE`;
const answerLead=id=>`PLATFORM_${id.toUpperCase()}_ANSWER_WITH_CODE`;
const questionTwo=id=>`PLATFORM_${id.toUpperCase()}_QUESTION_TWO`;
const codeText='const result = 42;\nconsole.log(result);';

function messageBodies(id){
  const question=(text,bodyClass='message-content')=>`<div class="${bodyClass}"><p>${text}</p></div>`;
  const answer=`<div class="message-content"><p>${answerLead(id)}</p><pre><code class="language-js">${codeText}</code></pre></div>`;
  return [question(questionOne(id)),answer,question(questionTwo(id))];
}

function providerMarkup(provider){
  const [first,answer,last]=messageBodies(provider.id);
  const id=provider.id;
  let messages='';
  switch(id){
    case 'claude':
      messages=`<div data-testid="transcript-row" data-index="0" data-rs-index="0"><div data-testid="user-message" data-message-id="${id}-u1">${first}</div></div>
        <div data-testid="transcript-row" data-index="1" data-rs-index="1"><div data-testid="assistant-message" data-message-id="${id}-a1">${answer}</div></div>
        <div data-testid="transcript-row" data-index="2" data-rs-index="2"><div data-testid="user-message" data-message-id="${id}-u2">${last}</div></div>`;
      break;
    case 'qwen':
      messages=`<div class="qwen-chat-message-user" data-message-id="${id}-u1">${first}</div>
        <div class="qwen-chat-message-assistant" data-message-id="${id}-a1">${answer}</div>
        <div class="qwen-chat-message-user" data-message-id="${id}-u2">${last}</div>`;
      break;
    case 'deepseek':
      messages=`<div class="_9663006"><div class="ds-message" data-message-id="${id}-u1"><div class="fbb737a4"><p>${questionOne(id)}</p></div></div></div>
        <div class="ds-message" data-message-id="${id}-a1"><div class="ds-assistant-message-main-content"><p>${answerLead(id)}</p><pre><code class="language-js">${codeText}</code></pre></div></div>
        <div class="_9663006"><div class="ds-message" data-message-id="${id}-u2"><div class="fbb737a4"><p>${questionTwo(id)}</p></div></div></div>`;
      break;
    case 'kimi':
      messages=`<div class="chat-content-item-user" data-message-id="${id}-u1"><div class="segment-content">${first}</div></div>
        <div class="chat-content-item-assistant" data-message-id="${id}-a1"><div class="segment-content">${answer}</div></div>
        <div class="chat-content-item-user" data-message-id="${id}-u2"><div class="segment-content">${last}</div></div>`;
      break;
    case 'gemini':
      messages=`<user-query data-message-id="${id}-u1"><div class="query-text">${questionOne(id)}</div></user-query>
        <model-response data-message-id="${id}-a1"><structured-content-container class="model-response-text"><p>${answerLead(id)}</p><pre><code class="language-js">${codeText}</code></pre></structured-content-container></model-response>
        <user-query data-message-id="${id}-u2"><div class="query-text">${questionTwo(id)}</div></user-query>`;
      break;
    case 'doubao':
      messages=`<div class="bg-g-send-msg-bubble" data-message-id="${id}-u1">${first}</div>
        <div class="bg-g-receive-msg-bubble" data-message-id="${id}-a1">${answer}</div>
        <div class="bg-g-send-msg-bubble" data-message-id="${id}-u2">${last}</div>`;
      break;
    case 'grok':
      messages=`<div data-testid="user-message" data-message-id="${id}-u1">${first}</div>
        <div data-testid="assistant-message" data-message-id="${id}-a1">${answer}</div>
        <div data-testid="user-message" data-message-id="${id}-u2">${last}</div>`;
      break;
    default: throw new Error('Unknown synthetic platform: '+id);
  }

  const transcript=id==='doubao'?`<div data-testid="message-list">${messages}</div>`:
    id==='kimi'?`<div class="chat-content-list">${messages}</div>`:
    `<section class="conversation-transcript">${messages}</section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${id} conversation fixture</title></head><body>
    <aside>SIDEBAR_MUST_NOT_EXPORT</aside><main>${transcript}</main></body></html>`;
}

function spoofMarkup(){
  return '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Unsupported spoof fixture</title></head><body><main>Not a supported AI conversation.</main></body></html>';
}

function readPdfText(file){
  const source="import sys,json; from pypdf import PdfReader; print(json.dumps('\\n'.join(page.extract_text() or '' for page in PdfReader(sys.argv[1]).pages),ensure_ascii=False))";
  return JSON.parse(execFileSync(pythonExecutable,['-c',source,file],{encoding:'utf8'}));
}

function isPdfFile(file){
  try{return fs.readFileSync(file).subarray(0,5).toString()==='%PDF-';}catch{return false;}
}

function sleep(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}

async function downloadItems(worker){
  return worker.evaluate(()=>chrome.downloads.search({}));
}

async function waitForNewPdf(worker,beforeIds,chat){
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    const items=await downloadItems(worker);
    const created=items.filter(item=>!beforeIds.has(item.id));
    const interrupted=created.find(item=>item.state==='interrupted');
    if(interrupted)throw new Error('PDF download was interrupted: '+(interrupted.error||interrupted.filename));
    const completed=created.find(item=>item.state==='complete'&&fs.existsSync(item.filename)&&isPdfFile(item.filename));
    if(completed)return completed;
    const status=await chat.evaluate(()=>document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('.status')?.textContent||'');
    if(/失败|错误|未授权|超时|无法/i.test(status))throw new Error('Quick PDF reported an error: '+status);
    await sleep(200);
  }
  throw new Error('Timed out waiting for a completed PDF download.');
}

function readerPages(context,extensionId){
  return context.pages().filter(page=>page.url().startsWith(`chrome-extension://${extensionId}/reader.html`));
}

async function assertReaderModel(reader,worker,provider){
  await reader.waitForFunction(()=>document.querySelector('#preview-content')?.querySelectorAll('article').length===3);
  const id=new URL(reader.url()).searchParams.get('id');
  assert.ok(id,'reader URL contains the isolated export ID');
  const model=await worker.evaluate(async key=>(await chrome.storage.session.get(key))[key],'export:'+id);
  assert.ok(model,'reader data is stored for this export');
  assert.equal(model.source?.kind,'dom');
  assert.equal(model.source?.complete,false);
  assert.equal(model.source?.platform,provider.id);
  assert.deepEqual(model.messages.map(message=>message.role),['user','assistant','user']);
  assert.deepEqual(model.messages.map(message=>message.id),[`${provider.id}:${provider.id}-u1`,`${provider.id}:${provider.id}-a1`,`${provider.id}:${provider.id}-u2`]);
  assert.ok(model.messages[0].text.includes(questionOne(provider.id)),'first user message is preserved');
  assert.ok(model.messages[1].text.includes(answerLead(provider.id)),'assistant answer is preserved');
  assert.ok(model.messages[1].markdown.includes('```js\n'+codeText+'\n```'),'assistant code block and language are preserved');
  assert.ok(model.messages[2].text.includes(questionTwo(provider.id)),'last user message is preserved in DOM order');
  assert.equal(JSON.stringify(model).includes('SIDEBAR_MUST_NOT_EXPORT'),false,'sidebar text is excluded from the conversation');
  assert.equal(model.activeBranchId,'current','DOM capture defaults to the current mounted conversation');
  assert.deepEqual(model.branches.map(branch=>branch.id),['current'],'DOM capture has no synthetic alternate branches');
  assert.ok(model.branches[0].messageIds.length===3,'current branch contains the three mounted messages');
  assert.ok(model.warnings.some(warning=>/loaded|加载|挂载|DOM|取得/i.test(warning)),'the source warns that only loaded DOM content is available');

  const quality=await reader.locator('#source-quality').innerText();
  const caption=await reader.locator('#source-caption').innerText();
  assert.match(quality,provider.label,'reader identifies the provider that supplied the DOM');
  assert.match(quality,/部分|DOM|页面|loaded|加载/i,'reader shows the incomplete DOM source quality');
  assert.match(caption,/仅导出|实际取得|加载|DOM|loaded/i,'reader explains that this export contains available page content');
  const branch=reader.locator('#branch-select');
  assert.equal(await branch.inputValue(),'current','reader initially selects the current DOM branch');
  const branchValues=await branch.locator('option').evaluateAll(options=>options.map(option=>option.value));
  assert.ok(branchValues.includes('current'),'reader exposes the current DOM branch');
  assert.equal(branchValues.filter(value=>value!=='__all').length,1,'reader has no alternate DOM branches');

  return {model,quality,caption};
}

async function quickExport(chat,worker,context,extensionId,platform,preset,expectedCount,expectInclude,expectExclude,saveMenuScreenshot){
  const beforeIds=new Set((await downloadItems(worker)).map(item=>item.id));
  const sessionBefore=await worker.evaluate(async()=>Object.keys(await chrome.storage.session.get(null)).filter(key=>key.startsWith('export:')).sort());
  const urlsBefore=context.pages().map(page=>page.url()).sort();
  const toggle=chat.locator('#gpt-exporter-menu-toggle');
  await toggle.click();
  const menu=chat.locator('#gpt-exporter-selection-menu');
  await chat.waitForFunction(()=>{
    const menu=document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu');
    return Boolean(menu&&!menu.hidden&&getComputedStyle(menu).display!=='none');
  });
  if(saveMenuScreenshot)await chat.screenshot({path:saveMenuScreenshot});
  const items=await menu.locator('button[data-preset]').evaluateAll(buttons=>buttons.map(button=>button.dataset.preset));
  assert.deepEqual(items,['all','questions','answers'],'quick menu exposes All, Questions, and Answers');
  await menu.locator(`[data-preset="${preset}"]`).click();
  const item=await waitForNewPdf(worker,beforeIds,chat);
  assert.deepEqual(context.pages().map(page=>page.url()).sort(),urlsBefore,'quick PDF does not open a reader or another browser tab');
  assert.equal(readerPages(context,extensionId).length,0,'quick PDF does not open the normal reader');
  assert.equal(await chat.locator('[data-gpt-exporter-selection]').count(),0,'quick PDF does not add per-message page controls');

  const text=readPdfText(item.filename);
  assert.match(text,expectInclude,'quick PDF contains the requested role content');
  assert.doesNotMatch(text,expectExclude,'quick PDF excludes the other role');
  const status=await chat.evaluate(()=>document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('.status')?.textContent||'');
  assert.match(status,new RegExp('已导出\\s*'+expectedCount+'\\s*条消息为 PDF'),'quick PDF status reports the selected message count');
  const sessionAfter=await worker.evaluate(async()=>Object.keys(await chrome.storage.session.get(null)).filter(key=>key.startsWith('export:')).sort());
  assert.deepEqual(sessionAfter,sessionBefore,'quick export removes its temporary session record');
  const offscreen=await worker.evaluate(async()=>{
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
    return contexts.filter(item=>item.documentUrl===chrome.runtime.getURL('direct-export.html')).length;
  });
  assert.equal(offscreen,0,'quick export closes its temporary offscreen document');
  return {platform,preset,downloadId:item.id,filename:item.filename,text};
}

(async()=>{
  fs.mkdirSync(downloadsPath,{recursive:true});
  const errors=[];
  const blockedRequests=[];
  const providerByOrigin=new Map(providers.map(provider=>[provider.origin,provider]));
  const extensionManifest=JSON.parse(fs.readFileSync(path.join(extensionPath,'manifest.json'),'utf8'));
  let context;
  try{
    const hostPermissions=extensionManifest.host_permissions||[];
    for(const provider of providers){
      assert.ok(hostPermissions.includes(provider.origin+'/*'),`manifest grants the exact ${provider.id} host`);
      assert.ok((extensionManifest.content_scripts||[]).some(script=>(script.matches||[]).includes(provider.origin+'/*')),
        `manifest injects the isolated collector on ${provider.id}`);
    }
    const mainBridgeMatches=(extensionManifest.content_scripts||[])
      .filter(script=>script.world==='MAIN'&&(script.js||[]).includes('src/page-bridge.js'))
      .flatMap(script=>script.matches||[]).sort();
    assert.deepEqual(mainBridgeMatches,['https://chat.openai.com/*','https://chatgpt.com/*'],
      'the ChatGPT page bridge remains limited to ChatGPT origins');

    context=await chromium.launchPersistentContext(path.join(output,'profile'),{
      channel:'chromium',downloadsPath,headless:true,acceptDownloads:true,
      viewport:{width:1440,height:1000},
      args:['--disable-extensions-except='+extensionPath,'--load-extension='+extensionPath]
    });
    context.on('page',page=>page.on('pageerror',error=>errors.push({url:page.url(),error:error.stack||error.message})));
    await context.route(/^https?:\/\//,async route=>{
      const request=route.request();
      const url=new URL(request.url());
      const provider=providerByOrigin.get(url.origin);
      if(request.isNavigationRequest()&&url.origin==='https://www.kimi.ai'&&url.pathname==='/en'){
        return route.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><html><head><meta charset="utf-8"><title>Kimi</title></head><body><main><p>New chat</p><textarea placeholder="Ask anything"></textarea></main></body></html>'});
      }
      if(request.isNavigationRequest()&&provider){
        return route.fulfill({contentType:'text/html;charset=utf-8',headers:{'cache-control':'no-store'},body:providerMarkup(provider)});
      }
      if(request.isNavigationRequest()&&['claude.ai.attacker.invalid','www.kimi.ai.attacker.invalid'].includes(url.hostname)){
        return route.fulfill({contentType:'text/html;charset=utf-8',body:spoofMarkup()});
      }
      blockedRequests.push({url:url.href,method:request.method(),resourceType:request.resourceType()});
      return route.abort();
    });

    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).hostname;
    const screenshotPaths={reader:path.join(output,'reader-claude.png'),quickMenu:path.join(output,'quick-menu-claude.png')};
    const quickResults=[];
    const readerSummaries=[];

    for(const [index,provider] of providers.entries()){
      const chat=await context.newPage();
      await chat.goto(provider.origin+provider.path);
      await chat.waitForSelector('#gpt-exporter-launcher');
      await chat.waitForFunction(()=>Boolean(document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-select')));
      const pageBridge=await chat.evaluate(()=>({
        marker:Boolean(window.__gptExporterPageBridgeV2),
        fetchSource:Function.prototype.toString.call(window.fetch)
      }));
      assert.equal(pageBridge.marker,false,`${provider.id} does not receive the ChatGPT page bridge marker`);
      assert.doesNotMatch(pageBridge.fetchSource,/routeFor|observedUrl|GPT_EXPORTER_PAGE_SNAPSHOT/,
        `${provider.id} page fetch remains free of the ChatGPT bridge wrapper`);

      const readerPromise=context.waitForEvent('page');
      await chat.locator('#gpt-exporter-select').click();
      const reader=await readerPromise;
      await reader.waitForURL(`chrome-extension://${extensionId}/reader.html?id=*`);
      const summary=await assertReaderModel(reader,worker,provider);
      readerSummaries.push({platform:provider.id,sourcePlatform:summary.model.source.platform,roles:summary.model.messages.map(message=>message.role)});
      if(index===0)await reader.screenshot({path:screenshotPaths.reader,fullPage:true});
      await reader.close();

      if(provider.quickPreset){
        const isQuestion=provider.quickPreset==='questions';
        quickResults.push(await quickExport(chat,worker,context,extensionId,provider.id,provider.quickPreset,
          isQuestion?2:1,
          isQuestion?new RegExp(questionOne(provider.id)+'[\\s\\S]*'+questionTwo(provider.id)):new RegExp(answerLead(provider.id)+'[\\s\\S]*const result = 42;'),
          isQuestion?new RegExp(answerLead(provider.id)+'|const result = 42;'):new RegExp(questionOne(provider.id)+'|'+questionTwo(provider.id)),
          null));
      }else if(provider.id==='claude'){
        quickResults.push(await quickExport(chat,worker,context,extensionId,provider.id,'all',3,
          /PLATFORM_CLAUDE_QUESTION_ONE[\s\S]*PLATFORM_CLAUDE_ANSWER_WITH_CODE[\s\S]*PLATFORM_CLAUDE_QUESTION_TWO/,
          /SIDEBAR_MUST_NOT_EXPORT/,
          screenshotPaths.quickMenu));
      }
      await chat.close();
    }

    const kimiHome=await context.newPage();
    await kimiHome.goto('https://www.kimi.ai/en');
    await kimiHome.locator('#gpt-exporter-select').waitFor({state:'visible'});
    assert.equal(await kimiHome.locator('#gpt-exporter-select').innerText(),'SELECT','the reported Kimi landing URL receives a visible launcher even without messages');
    await kimiHome.locator('#gpt-exporter-select').click();
    await kimiHome.waitForFunction(()=>document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('.status')?.textContent.includes('未识别到 Kimi 对话消息'));
    await kimiHome.screenshot({path:path.join(output,'kimi-ai-en-launcher.png')});
    await kimiHome.close();

    for(const hostname of ['claude.ai.attacker.invalid','www.kimi.ai.attacker.invalid']){
    const spoof=await context.newPage();
    await spoof.goto('https://'+hostname+'/chat/fixture');
    await spoof.waitForLoadState('domcontentloaded');
    await sleep(300);
    assert.equal(await spoof.locator('#gpt-exporter-launcher').count(),0,'unsupported lookalike host does not receive the extension');
    const spoofBridge=await spoof.evaluate(()=>({marker:Boolean(window.__gptExporterPageBridgeV2),fetchSource:Function.prototype.toString.call(window.fetch)}));
    assert.equal(spoofBridge.marker,false,'unsupported lookalike host does not receive the ChatGPT page bridge');
    assert.doesNotMatch(spoofBridge.fetchSource,/routeFor|observedUrl|GPT_EXPORTER_PAGE_SNAPSHOT/);
    await spoof.close();
    }

    assert.deepEqual(errors,[],'synthetic pages and extension pages have no uncaught page errors');
    assert.deepEqual(blockedRequests,[],'no API, media, or other remote network request leaves the synthetic provider pages');
    const report={
      status:'passed',
      chromium:context.browser()?.version()||'isolated Chromium',
      caseCounts:{providerOrigins:providers.length,readerDomCaptures:readerSummaries.length,branchDefaults:readerSummaries.length,
        quickPdfPresets:quickResults.length,quickPdfOrigins:new Set(quickResults.map(result=>result.platform)).size,
        unsupportedSpoofHosts:2,chatGptBridgeIsolation:providers.length,kimiLandingLauncher:1},
      providers:readerSummaries,
      quickPdfs:quickResults.map(({platform,preset,downloadId,filename})=>({platform,preset,downloadId,filename})),
      screenshots:Object.fromEntries(Object.entries(screenshotPaths).map(([name,file])=>[name,path.relative(output,file)])),
      networkRequests:blockedRequests,
      output
    };
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
    console.log('Local test evidence: '+output);
  }catch(error){
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'failure.txt'),error.stack||String(error));
    console.error(error);
    process.exitCode=1;
  }finally{if(context)await context.close();}
})();
