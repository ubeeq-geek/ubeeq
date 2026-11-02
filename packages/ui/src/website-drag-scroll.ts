/** Scroll only this pane while an owned drag is held near its visible edges. */
export function attachWebsiteDragScroll(pane:HTMLElement,active:()=>boolean){
 const win=pane.ownerDocument.defaultView;let frame:number|undefined,x=0,y=0,last=0;
 const stop=()=>{if(frame!==undefined)win?.cancelAnimationFrame(frame);frame=undefined;last=0;};
 const velocity=()=>{
  if(!win||!active()||!pane.isConnected||pane.scrollHeight<=pane.clientHeight)return 0;
  const rect=pane.getBoundingClientRect(),top=Math.max(0,rect.top),bottom=Math.min(win.innerHeight,rect.bottom),edge=Math.min(48,(bottom-top)/3);
  if(x<rect.left||x>rect.right||y<top||y>bottom||edge<=0)return 0;
  if(y<top+edge&&pane.scrollTop>0)return -18*(1-(y-top)/edge);
  if(y>bottom-edge&&pane.scrollTop<pane.scrollHeight-pane.clientHeight)return 18*(1-(bottom-y)/edge);
  return 0;
 };
 const tick=(time:number)=>{frame=undefined;const speed=velocity();if(!speed){last=0;return;}pane.scrollTop+=speed*Math.min(2,last?(time-last)/16.67:1);last=time;frame=win!.requestAnimationFrame(tick);};
 const move=(event:DragEvent)=>{x=event.clientX;y=event.clientY;if(!velocity()){stop();return;}if(frame===undefined)frame=win!.requestAnimationFrame(tick);};
 const over=(event:DragEvent)=>{if(active())event.preventDefault();move(event);};
 pane.addEventListener('dragover',over);win?.addEventListener('dragover',move);win?.addEventListener('drop',stop);win?.addEventListener('dragend',stop);
 return {stop,destroy:()=>{stop();pane.removeEventListener('dragover',over);win?.removeEventListener('dragover',move);win?.removeEventListener('drop',stop);win?.removeEventListener('dragend',stop);}};
}
