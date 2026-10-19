import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockEditor, WebsiteWorkspace } from '../dist/react.js';

test('the existing editor exposes website controls while preserving its ordinary block format',()=>{
  const value=[{blockId:'preview',type:'premium_promotion',payload:{publicationIds:['intended']}},{blockId:'query',type:'gallery_list',payload:{tags:['landscape'],pageSize:6}}];
  const html=renderToStaticMarkup(React.createElement(BlockEditor,{value,onChange:()=>{},allowStructured:true,websiteOptions:{pages:[{id:'about',title:'About'}],publications:[{id:'intended',title:'Intended public preview'}]}}));
  assert.match(html,/Intended public preview/);assert.match(html,/Only approved public previews/);assert.match(html,/Page size/);assert.match(html,/Add website block/);assert.match(html,/landscape/);
  assert.equal(typeof WebsiteWorkspace,'function');
});
