import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { preparePremiumGalleryForm } from '../browser/premium-gallery-form.mjs';
const moduleName = process.env.BROWSER_TEST_PLAYWRIGHT ? pathToFileURL(process.env.BROWSER_TEST_PLAYWRIGHT).href : 'playwright-core';
const { chromium } = await import(moduleName);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  let body = '';
  await page.route('https://www.deviantart.com/**', route => route.fulfill({ body, contentType: 'text/html' }));
  const form = ({premium=true,currency=true,extraDialog=false,max='100',currencyCode=''}={}) => `<dialog open><h2>New Gallery</h2><label><input type="radio" name="kind" ${premium?'checked':''}>Premium Gallery</label><label><input type="radio" name="kind" ${premium?'':'checked'}>Regular Gallery</label><label>Gallery title<input id="title"></label><label>${currency?'Price (USD)':'Price'}<input id="price" type="number" min="1" max="${max}"></label>${currencyCode?`<label>Currency<select><option value="${currencyCode}">${currencyCode}</option></select></label>`:''}<input type="hidden" id="csrf" value="not-exported"><button id="create" onclick="window.createClicked=true">Create</button></dialog>${extraDialog?'<div role="dialog">Other dialog</div>':''}`;
  const intent = { kind: 'premium', currency: 'USD', priceCents: 550, name: 'Paid artwork', automaticCreationReady: false, account: { username: 'artist', remoteId: 'principal' } };
  body=form(); await page.goto('https://www.deviantart.com/artist/gallery');
  const ready = await page.evaluate(preparePremiumGalleryForm, intent);
  assert.equal(ready.prepared,true);assert.equal(ready.created,false);assert.equal(ready.browserAccountVerified,false);
  assert.equal(await page.locator('#title').inputValue(), 'Paid artwork');assert.equal(await page.locator('#price').inputValue(),'5.50');
  assert.equal(await page.evaluate(()=>window.createClicked),undefined);assert.equal(await page.locator('#csrf').inputValue(),'not-exported');
  for(const [options,url,changed] of [[{premium:false},'artist',{}],[{currency:false},'artist',{}],[{currencyCode:'EUR'},'artist',{}],[{extraDialog:true},'artist',{}],[{max:'3'},'artist',{}],[{},'other',{}],[{},'artist',{automaticCreationReady:true}]]) {
    body=form(options);await page.goto(`https://www.deviantart.com/${url}/gallery`);
    const result=await page.evaluate(preparePremiumGalleryForm,{...intent,...changed});assert.equal(result.prepared,false);
    assert.equal(await page.locator('#title').inputValue(),'');assert.equal(await page.evaluate(()=>window.createClicked),undefined);
  }
  console.log(`PASS Chromium ${browser.version()}: premium form prefill; exact source, type, currency and price limits; ambiguity rejection; no submit or session export. Fixtures only; live DA DOM remains unqualified.`);
} finally {await browser.close();}
