import test from 'node:test';
import assert from 'node:assert/strict';
import {attachWebsiteDragScroll} from '../dist/website-drag-scroll.js';
function fixture(){
 const frames=new Map();let id=0,active=true;const win=new EventTarget();Object.assign(win,{innerHeight:600,requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)});
 const pane=new EventTarget();Object.assign(pane,{ownerDocument:{defaultView:win},isConnected:true,scrollHeight:1200,clientHeight:400,scrollTop:200,getBoundingClientRect:()=>({top:100,bottom:500,left:100,right:400})});
 const control=attachWebsiteDragScroll(pane,()=>active),move=(x,y)=>pane.dispatchEvent(Object.assign(new Event('dragover',{cancelable:true}),{clientX:x,clientY:y}));
 const tick=()=>{const pending=[...frames];frames.clear();for(const [,fn] of pending)fn(100);};
 return {pane,win,frames,control,move,tick,deactivate:()=>{active=false;}};
}
test('held drags scroll the pane in either direction and stop in the middle or outside it',()=>{
 const f=fixture();try{
  f.move(200,495);f.tick();assert.ok(f.pane.scrollTop>200);assert.equal(f.frames.size,1);
  f.move(200,300);assert.equal(f.frames.size,0);const at=f.pane.scrollTop;
  f.move(200,105);f.tick();assert.ok(f.pane.scrollTop<at);
  f.win.dispatchEvent(Object.assign(new Event('dragover'),{clientX:500,clientY:105}));assert.equal(f.frames.size,0);
 }finally{f.control.destroy();}
});
test('drag completion, disposal and non-gallery drags cannot leave scrolling running',()=>{
 const f=fixture();f.move(200,495);f.win.dispatchEvent(new Event('drop'));assert.equal(f.frames.size,0);
 f.move(200,495);f.deactivate();f.tick();assert.equal(f.frames.size,0);
 f.move(200,495);assert.equal(f.frames.size,0);f.control.destroy();f.move(200,495);assert.equal(f.frames.size,0);
});
