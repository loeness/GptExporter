'use strict';
// Real MV3 extension in isolated Chromium. ChatGPT is only a synthetic DOM/API fixture.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const chromiumExecutable=process.env.GPT_EXPORTER_CHROMIUM_EXECUTABLE||'';
const chromiumLaunchOptions=chromiumExecutable?{executablePath:chromiumExecutable}:{channel:'chromium'};
const bundledPython=path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe');
const pythonExecutable=process.env.GPT_EXPORTER_TEST_PYTHON||(fs.existsSync(bundledPython)?bundledPython:'python');
const output=path.join(root,'test-results','selection-'+Date.now());
const downloadsPath=path.join(output,'downloads');
fs.mkdirSync(downloadsPath,{recursive:true});
const fixture=[
  '<!doctype html><html><head><meta charset="utf-8"><title>Quick export fixture - ChatGPT</title></head><body>',
  '<aside>sidebar must not export</aside><main>',
  '<article data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u1"><p>First question.</p></div></article>',
  '<article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a1"><p>First answer.</p></div></article>',
  '<article data-testid="conversation-turn-3"><div data-message-author-role="user" data-message-id="u2"><p>Second question.</p></div></article>',
  '</main></body></html>'
].join('');
const graph={
  conversation_id:'selection-fixture',title:'Quick export fixture',current_node:'u2',
  mapping:{
    root:{id:'root',parent:null,children:['u1'],message:null},
    u1:{id:'u1',parent:'root',children:['a1'],message:{id:'u1',author:{role:'user'},create_time:1700000001,content:{content_type:'text',parts:['First question.']},metadata:{}}},
    a1:{id:'a1',parent:'u1',children:['u2'],message:{id:'a1',author:{role:'assistant'},create_time:1700000002,content:{content_type:'text',parts:['First answer.']},metadata:{}}},
    u2:{id:'u2',parent:'a1',children:[],message:{id:'u2',author:{role:'user'},create_time:1700000003,content:{content_type:'text',parts:['Second question.']},metadata:{}}}
  }
};

function readPdfText(file){
  const source="import sys,json; from pypdf import PdfReader; print(json.dumps('\\n'.join(page.extract_text() or '' for page in PdfReader(sys.argv[1]).pages),ensure_ascii=False))";
  return JSON.parse(execFileSync(pythonExecutable,['-c',source,file],{encoding:'utf8'}));
}
function isPdfFile(file){
  try{return fs.readFileSync(file).subarray(0,5).toString()==='%PDF-';}catch{return false;}
}

(async()=>{
  const errors=[],unexpectedNetwork=[],checks=[];
  let context;
  try{
    if(chromiumExecutable)assert.ok(fs.existsSync(chromiumExecutable),'configured test Chromium executable is missing: '+chromiumExecutable);
    context=await chromium.launchPersistentContext(path.join(output,'profile'),{
      ...chromiumLaunchOptions,downloadsPath,headless:true,hasTouch:true,acceptDownloads:true,
      viewport:{width:1440,height:1000},args:['--disable-extensions-except='+path.join(root,'extension'),'--load-extension='+path.join(root,'extension')]
    });
    context.on('page',page=>page.on('pageerror',error=>errors.push({url:page.url(),error:error.stack||error.message})));
    await context.route(/^https?:\/\//,async route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='chatgpt.com'){unexpectedNetwork.push(url.origin);return route.abort();}
      if(url.pathname==='/api/auth/session')return route.fulfill({contentType:'application/json',body:JSON.stringify({accessToken:'fixture-only-token'})});
      if(url.pathname==='/backend-api/conversation/selection-fixture')return route.fulfill({contentType:'application/json',body:JSON.stringify(graph)});
      return route.fulfill({contentType:'text/html;charset=utf-8',body:fixture});
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).hostname;
    const chat=await context.newPage();
    await chat.goto('https://chatgpt.com/c/selection-fixture');
    await chat.waitForSelector('#gpt-exporter-launcher');
    await chat.waitForFunction(()=>Boolean(document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-menu-toggle')));

    const menuToggle=chat.locator('#gpt-exporter-menu-toggle');
    const menu=chat.locator('#gpt-exporter-selection-menu');
    const menuOpen=()=>chat.evaluate(()=>{
      const current=document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu');
      return Boolean(current&&!current.hidden&&getComputedStyle(current).display!=='none'&&getComputedStyle(current).visibility!=='hidden');
    });
    const menuItems=()=>chat.evaluate(()=>{
      const shadow=document.querySelector('#gpt-exporter-launcher')?.shadowRoot;
      const current=shadow?.querySelector('#gpt-exporter-selection-menu');
      return current?{role:current.getAttribute('role'),items:[...current.querySelectorAll('button[data-preset]')].map(button=>({preset:button.dataset.preset,text:button.textContent.trim()}))}:null;
    });
    const downloads=()=>worker.evaluate(()=>chrome.downloads.search({}));
    const waitForNewPdf=async beforeIds=>{
      const deadline=Date.now()+90000;
      while(Date.now()<deadline){
        const items=await downloads();
        const created=items.filter(item=>!beforeIds.has(item.id));
        const interrupted=created.find(item=>item.state==='interrupted');
        if(interrupted)throw new Error('PDF download was interrupted: '+(interrupted.error||interrupted.filename));
        const completed=created.find(item=>item.state==='complete'&&fs.existsSync(item.filename)&&isPdfFile(item.filename));
        if(completed)return completed;
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      throw new Error('Timed out waiting for a completed chrome.downloads PDF.');
    };
    const pageUrls=()=>context.pages().map(page=>page.url()).sort();
    const readerPages=()=>context.pages().filter(page=>page.url().startsWith('chrome-extension://'+extensionId+'/reader.html'));
    const noPageSelections=async()=>{
      const controls=await chat.locator('[data-gpt-exporter-selection]').count();
      assert.equal(controls,0,'the ChatGPT page must not contain per-message selection controls');
    };

    await noPageSelections();
    assert.equal(await chat.locator('#gpt-exporter-export').count(),0,'the old separate Export button is removed');
    const mainSelect=chat.locator('#gpt-exporter-select');
    const readerPromise=context.waitForEvent('page');
    await mainSelect.click();
    const reader=await readerPromise;
    await reader.waitForURL('**/reader.html?id=*');
    await reader.waitForFunction(()=>document.querySelector('#message-total')?.textContent==='3 条');
    assert.equal(await reader.locator('#preview-content article').count(),3,'main SELECT opens the ordinary full reader');
    assert.deepEqual(await downloads(),[],'main SELECT opens the reader without starting a direct download');
    await reader.close();
    await noPageSelections();
    checks.push('main SELECT opens the normal reader without page checkboxes');

    await menuToggle.hover();
    assert.equal(await menuOpen(),true,'hovering the menu arrow opens the quick-export menu');
    const initialMenu=await menuItems();
    assert.equal(initialMenu.role,'menu');
    assert.deepEqual(initialMenu.items.map(item=>item.preset),['all','questions','answers']);
    assert.deepEqual(initialMenu.items.map(item=>item.text.replace(/\s+\(default\)$/,'')),['All','Questions','Answers']);
    await chat.screenshot({path:path.join(output,'quick-export-menu.png')});
    assert.deepEqual(await downloads(),[],'hovering the arrow only opens the menu; it does not download');
    assert.equal(readerPages().length,0,'hovering the menu does not open a reader page');
    const menuBox=await menu.boundingBox();
    await chat.mouse.move(menuBox.x+24,menuBox.y+24,{steps:10});
    await chat.waitForTimeout(100);
    assert.equal(await menuOpen(),true,'the menu remains open while the pointer crosses the gap');
    await noPageSelections();
    checks.push('hover menu, three presets, no hover download, and pointer travel across gap');

    await chat.keyboard.press('Escape');
    await chat.waitForFunction(()=>document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu')?.hidden);
    await menuToggle.hover();
    await chat.locator('aside').click();
    await chat.waitForFunction(()=>document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu')?.hidden);
    assert.deepEqual(await downloads(),[],'Escape and outside dismissal do not download');
    checks.push('Escape and outside dismissal');

    await menuToggle.focus();
    await chat.keyboard.press('Enter');
    assert.equal(await menuOpen(),true,'the menu opens from keyboard');
    await chat.keyboard.press('Escape');
    await chat.waitForFunction(()=>document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu')?.hidden);
    const toggleBox=await menuToggle.boundingBox();
    await chat.touchscreen.tap(toggleBox.x+toggleBox.width/2,toggleBox.y+toggleBox.height/2);
    assert.equal(await menuOpen(),true,'the menu opens from touch');
    await chat.keyboard.press('Escape');
    checks.push('keyboard and touch can open and dismiss the menu');

    const originalPages=pageUrls();
    const exportPreset=async(preset,expectedCount)=>{
      const beforeIds=new Set((await downloads()).map(item=>item.id));
      await menuToggle.click();
      assert.equal(await menuOpen(),true);
      await menu.locator('[data-preset="'+preset+'"]').click();
      const item=await waitForNewPdf(beforeIds);
      assert.deepEqual(pageUrls(),originalPages,'quick export must not open a tab or reader page');
      assert.equal(readerPages().length,0);
      assert.equal(await menuOpen(),false,'choosing a preset closes the menu');
      await chat.waitForFunction(expected=>{
        const shadow=document.querySelector('#gpt-exporter-launcher')?.shadowRoot;
        return shadow?.querySelector('.status')?.textContent.includes('已导出 '+expected+' 条消息为 PDF') &&
          !shadow?.querySelector('#gpt-exporter-select')?.disabled;
      },expectedCount);
      await noPageSelections();
      return {item,text:readPdfText(item.filename)};
    };

    const all=await exportPreset('all',3);
    assert.match(all.text,/First question\./);
    assert.match(all.text,/First answer\./);
    assert.match(all.text,/Second question\./);
    checks.push('All preset downloads a searchable PDF containing every role');

    const questions=await exportPreset('questions',2);
    assert.match(questions.text,/First question\./);
    assert.match(questions.text,/Second question\./);
    assert.doesNotMatch(questions.text,/First answer\./,'Questions PDF excludes assistant messages');
    checks.push('Questions preset downloads a PDF containing user messages only');

    const answers=await exportPreset('answers',1);
    assert.match(answers.text,/First answer\./);
    assert.doesNotMatch(answers.text,/First question\.|Second question\./,'Answers PDF excludes user messages');
    checks.push('Answers preset downloads a PDF containing assistant messages only');

    assert.deepEqual(errors,[]);
    assert.deepEqual(unexpectedNetwork,[]);
    const report={status:'passed',chromium:context.browser()?.version()||'isolated Chromium',checks,downloads:[all.item.filename,questions.item.filename,answers.item.filename]};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
    console.log('Local test evidence: '+output);
  }catch(error){
    fs.writeFileSync(path.join(output,'failure.txt'),error.stack||String(error));
    console.error(error);process.exitCode=1;
  }finally{if(context)await context.close();}
})();
