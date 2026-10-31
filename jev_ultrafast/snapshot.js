(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    const full=referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
    // A container with no more specific name (no aria-label, no
    // labelledby, no title) falls through to concatenating every
    // descendant's text with no bound at all. Observed live on
    // MakeMyTrip: a From/To/Departure wrapper's computed name ran to 1247
    // characters, and a results-dropdown wrapper's to 952, both offered as
    // candidates alongside the real, cleanly-labeled "To" input sitting
    // right underneath them. Capped the same way text is already sliced
    // elsewhere in this file; the text-gathering priority above is
    // unchanged; only how much of the result survives into the label the
    // model actually sees.
    return full.length>160 ? full.slice(0,160).trim()+'…' : full;
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const actions=[];
  let occluded=false;
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    // visible() only checks this element's own CSS visibility, not whether
    // something else is drawn on top of it. A modal that doesn't mark the
    // page behind it aria-hidden (observed live on ClearTrip: an
    // auto-opened login dialog) leaves the covered field passing every
    // check above while a real click/fill would land on the modal instead.
    // Confirm this element is still the actual topmost thing at its own
    // center before offering it.
    const top=document.elementFromPoint(x,y);
    if (!top || !(e.contains(top) || top.contains(e))) { occluded=true; continue; }
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  // Non-native clickable rows (bare li/div/span/td/dd/p whose only sign of
  // interactivity is cursor:pointer, e.g. an autocomplete dropdown's own
  // suggestion rows) are invisible to the selector loop above, which only
  // matches native controls and elements with an explicit ARIA role. Once
  // such a dropdown is open, CLICK has no supported target inside it at
  // all, so the policy can only retype the same field forever. Observed
  // live on ClearTrip's city autocomplete: zero of "Mumbai", "Bengaluru",
  // etc. were ever offered as candidates, burning the full decision
  // budget retyping "Where to". Matches
  // github.com/browser-use/jev-ultrafast#23.
  const nonNativeTags=new Set(['LI','DIV','SPAN','TD','DD','P']);
  const seenPointer=new Set(), claimedClickable=new Set();
  let addedPointer=0;
  for (const start of document.querySelectorAll('li,div,span,td,dd,p')) {
    if (addedPointer>=40) break;
    if (!nonNativeTags.has(start.tagName) || !visible(start)) continue;
    if (start.closest('a[href],button,input,textarea,select,summary,[contenteditable="true"]')) continue;
    if (getComputedStyle(start).cursor!=='pointer') continue;
    // Climb to the outermost ancestor still styled cursor:pointer, so a
    // row's own text spans (which inherit the cursor) don't each become a
    // separate candidate alongside the row itself.
    let e=start;
    while (e.parentElement && e.parentElement!==document.body &&
      getComputedStyle(e.parentElement).cursor==='pointer') {
      e=e.parentElement;
    }
    if (seenPointer.has(e) || e.querySelector(selector)) continue;
    seenPointer.add(e);
    claimedClickable.add(e);
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    if (r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    const top=document.elementFromPoint(x,y);
    if (!top || !(e.contains(top) || top.contains(e))) { occluded=true; continue; }
    const label=name(e)||e.innerText.trim().slice(0,160);
    if (!label) continue;
    actions.push({node:identity(e),role:'button',label,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height},kind:'click',value:''});
    addedPointer++;
  }
  // A compound ARIA container (listbox/menu/tree/grid/radiogroup) implies
  // its children carry a matching typed role (option/menuitem/treeitem/
  // gridcell/radio), but a site can role-tag the container correctly and
  // never role-tag the repeated rows themselves. Checked directly via CDP's
  // getEventListeners on ClearTrip's city autocomplete: the `role="listbox"`
  // suggestion rows have no cursor:pointer AND no element-level click
  // listener at all (React's root-level delegated click handler is
  // invisible to both per-element signals), so neither the pass above nor
  // an own-listener check could ever find them. The row is still a normal,
  // real click target once offered -- a synthetic click dispatched at its
  // coordinates reaches the same delegated handler a real user click would.
  const rowParentRoles={listbox:'option',menu:'menuitem',tree:'treeitem',grid:'gridcell',radiogroup:'radio'};
  let addedRow=0;
  for (const container of document.querySelectorAll(Object.keys(rowParentRoles).map(r=>'[role="'+r+'"]').join(','))) {
    if (addedRow>=40 || !visible(container)) continue;
    const rowRole=rowParentRoles[container.getAttribute('role')];
    for (const row of container.querySelectorAll('li,tr')) {
      if (addedRow>=40) break;
      if (claimedClickable.has(row) || row.matches(selector) || row.querySelector(selector)) continue;
      let p=row.parentElement, nested=false;
      while (p && p!==container) { if (p.tagName==='LI' || p.tagName==='TR') { nested=true; break; } p=p.parentElement; }
      if (nested || !visible(row)) continue;
      claimedClickable.add(row);
      const r=row.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
      if (r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
      const top=document.elementFromPoint(x,y);
      if (!top || !(row.contains(top) || top.contains(row))) { occluded=true; continue; }
      const label=name(row)||row.innerText.trim().slice(0,160);
      if (!label) continue;
      actions.push({node:identity(row),role:rowRole,label,
        rect:{x:r.x,y:r.y,w:r.width,h:r.height},kind:'click',value:''});
      addedRow++;
    }
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  // document.documentElement.scrollHeight can equal innerHeight -- nothing
  // left to scroll by this page-level measure -- while the real content
  // lives inside one inner container using its own overflow-y:auto scroll
  // instead of document scroll, a common SPA app-shell pattern (a fixed
  // h-screen root div). Observed live on district.in: an artist page's
  // entire show-card list sat inside such a container (1827px of real
  // content against a 780px viewport, document scrollHeight reporting
  // 780), so scroll_down was never offered and the agent had no way to
  // reach anything below the hero section, previously misread as
  // site-side flakiness rather than this. Only a fallback: checked, and
  // offered under the same scroll_down/scroll_up ids, exactly when the
  // page itself truly has nothing left to scroll in that direction, so
  // it never competes with or shadows a real page-level scroll.
  if (scrollY+innerHeight>=height-2 || scrollY<=0) {
    let vscroll=null, vscrollArea=0;
    for (const el of document.querySelectorAll('*')) {
      if (el===document.documentElement || el===document.body) continue;
      const style=getComputedStyle(el);
      if (!['auto','scroll'].includes(style.overflowY)) continue;
      if (el.scrollHeight<=el.clientHeight+4) continue;
      const r=el.getBoundingClientRect();
      if (r.width<=0 || r.height<=0 || r.bottom<=0 || r.top>=innerHeight) continue;
      const area=r.width*r.height;
      if (area>vscrollArea) { vscrollArea=area; vscroll={el,r}; }
    }
    if (vscroll) {
      const cx=Math.max(0,Math.min(innerWidth-1,vscroll.r.x+vscroll.r.width/2));
      const cy=Math.max(0,Math.min(innerHeight-1,vscroll.r.y+vscroll.r.height/2));
      if (scrollY+innerHeight>=height-2 && vscroll.el.scrollTop<vscroll.el.scrollHeight-vscroll.el.clientHeight-2)
        actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560,x:cx,y:cy});
      if (scrollY<=0 && vscroll.el.scrollTop>0)
        actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560,x:cx,y:cy});
    }
  }
  // Page-level scroll is vertical only. A horizontally-scrolling carousel
  // (observed live on district.in: an artist page whose bookable show
  // cards sit in an overflow-x region with nothing below the fold at all,
  // scrollHeight === innerHeight) is invisible to it, so the agent had no
  // supported action to reach them and correctly, but unhelpfully, ended
  // BLOCKED. Offer the single largest visible overflow-x:auto|scroll
  // region on screen, the same way page scroll is already offered, bound
  // to its own element and center point so the wheel event actually lands
  // on it instead of the page.
  let hscroll=null, hscrollArea=0;
  for (const el of document.querySelectorAll('*')) {
    const style=getComputedStyle(el);
    if (!['auto','scroll'].includes(style.overflowX)) continue;
    if (el.scrollWidth<=el.clientWidth+4) continue;
    const r=el.getBoundingClientRect();
    if (r.width<=0 || r.height<=0 || r.bottom<=0 || r.top>=innerHeight) continue;
    const area=r.width*r.height;
    if (area>hscrollArea) { hscrollArea=area; hscroll={el,r}; }
  }
  if (hscroll) {
    const cx=Math.max(0,Math.min(innerWidth-1,hscroll.r.x+hscroll.r.width/2));
    const cy=Math.max(0,Math.min(innerHeight-1,hscroll.r.y+hscroll.r.height/2));
    if (hscroll.el.scrollLeft<hscroll.el.scrollWidth-hscroll.el.clientWidth-2)
      actions.push({id:'scroll_right',kind:'hscroll',label:'Scroll right to see more',deltaX:360,x:cx,y:cy});
    if (hscroll.el.scrollLeft>0)
      actions.push({id:'scroll_left',kind:'hscroll',label:'Scroll left',deltaX:-360,x:cx,y:cy});
  }
  // Offered only when this scan actually excluded a covered element (the
  // occlusion check above), not unconditionally: a real, measured signal
  // that something is drawn over the page, not a guess from ARIA markup
  // that a site may not set correctly (observed live on ClearTrip, whose
  // login modal left the page behind it with no aria-hidden at all). A
  // dialog with no visible close control, or one that only exposes an
  // unwanted call-to-action, has nothing else a policy could safely choose.
  if (occluded) actions.push({id:'dismiss',kind:'dismiss',label:'Press Escape to dismiss a covering overlay'});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()
