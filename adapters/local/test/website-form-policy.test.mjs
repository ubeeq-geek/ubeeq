import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeWebsiteFormActionPolicy} from '../dist/website-hosting.js';
const form=url=>Buffer.from(`<form class="website-mailing-form" data-website-mailing="true" method="post" action="${url}">`);
test('native form policy permits only exact generated platform signup endpoints',()=>{
 assert.equal(nativeWebsiteFormActionPolicy(form('https://api.example/api/public/mailing-list/creator/subscribe-form')),'https://api.example/api/public/mailing-list/creator/subscribe-form');
 for(const input of [undefined,Buffer.from('<p>No form</p>'),Buffer.from('<form action="https://evil.example/steal">'),form('https://api.example/steal'),form('https://user:password@api.example/public/mailing-list/creator/subscribe-form'),form('https://api.example/public/mailing-list/creator/subscribe-form?redirect=evil'),form("https://api.example/public/mailing-list/creator/subscribe-form#'unsafe")])assert.equal(nativeWebsiteFormActionPolicy(input),"'none'");
});
