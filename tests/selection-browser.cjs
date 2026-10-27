'use strict';
// Real MV3 extension in an isolated Chromium profile. ChatGPT pages are fixtures only.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'test-results','selection-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const fixture=`<!doctype html><html><head><meta charset="utf-8"><title>Selection fixture - ChatGPT</title></head><body>
<aside>sidebar must not export</aside><main>
<article data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u1"><p>First question.</p></div></article>
<article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a1"><p>First answer.</p></div></article>
<article data-testid="conversation-turn-3"><div data-message-author-role="user" data-message-id="u2"><p>Second question.</p></div></article>
</main></body></html>`;

(async()=>{
  const errors=[],unexpectedNetwork=[],checks=[];
  let context;
  try{
    context=await chromium.launchPersistentContext(path.join(output,'profile'),{
      channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1000},
      args:['--disable-extensions-except='+path.join(root,'extension'),'--load-extension='+path.join(root,'extension')]
    });
    context.on('page',page=>page.on('pageerror',error=>errors.push({url:page.url(),error:error.stack||error.message})));
    await context.route(/^https?:\/\//,async route=>{
      const url=new URL(route.request().url());
      if(url.hostname==='chatgpt.com')return route.fulfill({contentType:'text/html;charset=utf-8',body:fixture});
      unexpectedNetwork.push(url.origin);return route.abort();
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).hostname;
    const chat=await context.newPage();
    const menuToggle=chat.locator('#gpt-exporter-menu-toggle');
    const menu=chat.locator('#gpt-exporter-selection-menu');
    const selectionButton=chat.locator('#gpt-exporter-select');
    await chat.goto('https://chatgpt.com/c/selection-fixture');
    await chat.waitForSelector('#gpt-exporter-launcher');
    await chat.waitForFunction(()=>Boolean(document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-menu-toggle')));

    const menuOpen=()=>chat.evaluate(()=>{
      const menu=document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu');
      return Boolean(menu&&!menu.hidden&&getComputedStyle(menu).display!=='none'&&getComputedStyle(menu).visibility!=='hidden');
    });
    const selectionState=()=>chat.evaluate(()=>[...document.querySelectorAll('[data-gpt-exporter-selection]')].map(host=>{
      const checkbox=host.shadowRoot?.querySelector('input[type="checkbox"]');
      return checkbox?checkbox.checked:null;
    }));
    const choosePreset=async preset=>{
      if(!await menuOpen())await menuToggle.click();
      await menu.locator(`[data-preset="${preset}"]`).click();
    };
    const readerPages=()=>context.pages().filter(page=>page.url().startsWith(`chrome-extension://${extensionId}/reader.html`));

    await selectionButton.click();
    await chat.waitForFunction(()=>document.querySelectorAll('[data-gpt-exporter-selection]').length===3);
    assert.deepEqual(await selectionState(),[true,true,true],'opening selection controls defaults to All');
    await menuToggle.click();
    await chat.waitForFunction(()=>{
      const menu=document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu');
      return menu?.getAttribute('role')==='menu'&&menu.querySelectorAll('button[data-preset]').length===4;
    });
    await chat.screenshot({path:path.join(output,'selection-menu.png')});
    await chat.keyboard.press('Escape');
    await chat.waitForFunction(()=>document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu')?.hidden);
    await selectionButton.click();
    await chat.waitForFunction(()=>document.querySelectorAll('[data-gpt-exporter-selection]').length===0);
    checks.push('SELECT toggles controls with All as the default');

    await menuToggle.click();
    assert.equal(await menuOpen(),true,'the arrow opens the selection menu');
    await chat.waitForFunction(()=>{
      const menu=document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu');
      return menu?.getAttribute('role')==='menu'&&menu.querySelectorAll('button[data-preset]').length===4;
    });
    const menuState=await chat.evaluate(()=>{
      const menu=document.querySelector('#gpt-exporter-launcher').shadowRoot.querySelector('#gpt-exporter-selection-menu');
      return {role:menu.getAttribute('role'),presets:[...menu.querySelectorAll('button[data-preset]')].map(button=>button.dataset.preset).sort()};
    });
    assert.deepEqual(menuState,{role:'menu',presets:['all','answers','none','questions']});
    assert.equal(readerPages().length,0,'opening the selection menu does not export');
    checks.push('menu options and no accidental export');

    await chat.keyboard.press('Escape');
    await chat.waitForFunction(()=>{
      const menu=document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu');
      return !menu||menu.hidden||getComputedStyle(menu).display==='none';
    });
    await menuToggle.click();
    await chat.locator('aside').click();
    await chat.waitForFunction(()=>{
      const menu=document.querySelector('#gpt-exporter-launcher')?.shadowRoot?.querySelector('#gpt-exporter-selection-menu');
      return !menu||menu.hidden||getComputedStyle(menu).display==='none';
    });
    assert.equal(readerPages().length,0,'closing the menu outside does not export');
    checks.push('Escape and outside dismissal');

    await menuToggle.focus();
    await chat.keyboard.press('Enter');
    assert.equal(await menuOpen(),true,'menu opens from keyboard');
    await chat.keyboard.press('Enter');
    await chat.waitForFunction(()=>document.querySelectorAll('[data-gpt-exporter-selection]').length===3);
    assert.deepEqual(await selectionState(),[true,true,true],'All is the initial page selection');
    assert.equal(readerPages().length,0,'keyboard preset activation does not export');
    checks.push('keyboard access and default All');

    const select=async()=>selectionButton.click();
    const toggleMessage=async index=>chat.locator('[data-gpt-exporter-selection]').nth(index).locator('input[type="checkbox"]').click();
    await toggleMessage(1);
    assert.deepEqual(await selectionState(),[true,false,true],'All permits an individual message to be unchecked');
    await toggleMessage(1);
    assert.deepEqual(await selectionState(),[true,true,true]);
    await choosePreset('questions');
    assert.deepEqual(await selectionState(),[true,false,true],'Questions selects user messages');
    await menuToggle.click();
    await chat.screenshot({path:path.join(output,'questions-menu.png')});
    await chat.keyboard.press('Escape');
    await chat.evaluate(()=>{
      const main=document.querySelector('main');
      main.insertAdjacentHTML('beforeend',
        '<article data-testid="conversation-turn-4"><div data-message-author-role="user" data-message-id="u3"><p>New question.</p></div></article>'+
        '<article data-testid="conversation-turn-5"><div data-message-author-role="assistant" data-message-id="a2"><p>New answer.</p></div></article>');
    });
    await chat.waitForFunction(()=>document.querySelectorAll('[data-gpt-exporter-selection]').length===5);
    assert.deepEqual(await selectionState(),[true,false,true,true,false],'new messages inherit the active Questions preset');
    await chat.locator('[data-message-id="a2"]').evaluate(element=>element.hidden=true);
    await chat.waitForFunction(()=>document.querySelectorAll('[data-gpt-exporter-selection]').length===4);
    await chat.locator('[data-message-id="a2"]').evaluate(element=>element.hidden=false);
    await chat.waitForFunction(()=>document.querySelectorAll('[data-gpt-exporter-selection]').length===5);
    assert.deepEqual(await selectionState(),[true,false,true,true,false],'hidden messages are reconciled without changing the preset');
    checks.push('role presets, manual toggles, and streaming messages');

    await choosePreset('answers');
    assert.deepEqual(await selectionState(),[false,true,false,false,true],'Answers selects assistant messages');
    const answerReaderPromise=context.waitForEvent('page');
    await chat.locator('#gpt-exporter-export').click();
    const answerReader=await answerReaderPromise;
    await answerReader.waitForURL('**/reader.html?id=*');
    await answerReader.waitForFunction(()=>document.querySelector('#message-total')?.textContent==='5 条');
    assert.equal(await answerReader.locator('#preview-content article').count(),2);
    const answerJsonPromise=answerReader.waitForEvent('download');
    await answerReader.locator('[data-format="json"]').click();
    const answerDownload=await answerJsonPromise;
    const answerJson=JSON.parse(fs.readFileSync(await answerDownload.path(),'utf8'));
    assert.deepEqual(answerJson.messages.map(message=>message.role),['assistant','assistant']);
    assert.ok(!JSON.stringify(answerJson).includes('data-gpt-exporter-selection'));
    assert.ok(!JSON.stringify(answerJson).includes('gpt-exporter-launcher'));
    checks.push('Answers export initializes the reader and JSON with assistants only');
    await answerReader.close();

    await choosePreset('none');
    assert.deepEqual(await selectionState(),[false,false,false,false,false],'None clears all page message checkboxes');
    const emptyReaderPromise=context.waitForEvent('page');
    await chat.locator('#gpt-exporter-export').click();
    const emptyReader=await emptyReaderPromise;
    await emptyReader.waitForURL('**/reader.html?id=*');
    await emptyReader.waitForFunction(()=>document.querySelector('#preview-empty')&&!document.querySelector('#preview-empty').hidden);
    assert.equal((await emptyReader.locator('#preview-content').innerHTML()).trim(),'');
    checks.push('None opens an empty reader');
    await emptyReader.close();

    await toggleMessage(0);
    assert.deepEqual(await selectionState(),[true,false,false,false,false],'None allows an explicit manual choice');
    const userReaderPromise=context.waitForEvent('page');
    await chat.locator('#gpt-exporter-export').click();
    const userReader=await userReaderPromise;
    await userReader.waitForURL('**/reader.html?id=*');
    await userReader.waitForFunction(()=>document.querySelector('#preview-content article'));
    assert.equal(await userReader.locator('#preview-content article').count(),1);
    assert.match(await userReader.locator('#preview-content').innerText(),/First question\./);
    assert.equal(await userReader.locator('#preview-empty').isVisible(),false);
    const userJsonPromise=userReader.waitForEvent('download');
    await userReader.locator('[data-format="json"]').click();
    const userDownload=await userJsonPromise;
    const userJson=JSON.parse(fs.readFileSync(await userDownload.path(),'utf8'));
    assert.deepEqual(userJson.messages.map(message=>message.role),['user']);
    assert.ok(!JSON.stringify(userJson).includes('data-gpt-exporter-selection'));
    assert.ok(!JSON.stringify(userJson).includes('sidebar must not export'));
    checks.push('None manual override exports only the chosen user message');
    await userReader.close();

    await chat.evaluate(()=>{
      history.pushState({},'', '/c/selection-route-change');
    });
    await chat.waitForFunction(()=>document.querySelectorAll('[data-gpt-exporter-selection]').length===0);
    await select();
    await chat.waitForFunction(()=>document.querySelectorAll('[data-gpt-exporter-selection]').length===5);
    assert.deepEqual(await selectionState(),[true,true,true,true,true],'SPA route changes reset page selection to All');
    assert.equal(readerPages().length,0);
    checks.push('SPA route selection reset');

    assert.deepEqual(errors,[]);
    assert.deepEqual(unexpectedNetwork,[]);
    const report={status:'passed',chromium:context.browser()?.version()||'persistent-context',checks};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
    console.log('Local test evidence: '+output);
  }catch(error){
    fs.writeFileSync(path.join(output,'failure.txt'),error.stack||String(error));
    console.error(error);process.exitCode=1;
  }finally{if(context)await context.close();}
})();
