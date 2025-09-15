/* ====== Set worker source for PDF.js ====== */
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function extractFilename(url) {
    try {
        const urlObj = new URL(url, window.location.href);
        const pathname = urlObj.pathname;
        const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
        if (!filename || !filename.toLowerCase().endsWith('.pdf')) {
            const parts = url.split('/');
            return parts[parts.length - 1] || 'Document.pdf';
        }
        return decodeURIComponent(filename);
    } catch (e) {
        const parts = url.split('/');
        return parts[parts.length - 1] || 'Document.pdf';
    }
}

function getPdfUrlFromQuery() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('url');
}

function preparePdfLoadOptions(url) {
    const isCrossOrigin = new URL(url, window.location.href).origin !== window.location.origin;
    if (isCrossOrigin) {
        return {
            url: url,
            httpHeaders: {
                'Access-Control-Allow-Origin': '*'
            },
            withCredentials: false,
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
            cMapPacked: true
        };
    }
    return { url: url };
}

/* ====== CONFIG ====== */
const PDF_URL = getPdfUrlFromQuery();

const DPR = Math.max(1, window.devicePixelRatio || 1);
const BASELINE = 0.8;
const UI_MIN = 0.5;
const UI_MAX = 3.0;
const KEEP_NEIGHBOR = 1;
const PRELOAD_MARGIN_PX = 600;

/* ====== State ====== */
let pdfDoc = null, pageCount = 0;
let uiScale = 1.0;
const pagesContainer = document.getElementById('pages');
let pageShells = {};
let rendered = new Map();
let renderTasks = new Map();
let visiblePage = 1;

/* ====== UI refs ====== */
const pageCountEl = document.getElementById('page-count');
const pageNumInput = document.getElementById('page-num');
const zoomLevelEl = document.getElementById('zoom-level');
const visiblePageEl = document.getElementById('visible-page');
const container = document.getElementById('pdf-container');

function actualScaleFromUi(ui){ return ui * BASELINE; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function updateZoomUI(){ zoomLevelEl.textContent = Math.round(uiScale * 100) + '%'; }

/* ====== Build shells ====== */
function buildShells(n){
  pagesContainer.innerHTML = '';
  pageShells = {};
  for(let i=1;i<=n;i++){
    const s = document.createElement('div');
    s.className = 'page-shell';
    s.id = 'page-' + i;
    s.dataset.pnum = i;
    s.innerHTML = `<div class="page-loading">Page ${i}</div>`;
    pagesContainer.appendChild(s);
    pageShells[i] = s;
  }
}

/* ====== Render page ====== */
function renderPage(num, scale = actualScaleFromUi(uiScale), preserveFocus = null){
  if(!pdfDoc) return Promise.resolve();
  if(num < 1 || num > pageCount) return Promise.resolve();

  const existing = rendered.get(num);
  if(existing && Math.abs(existing.scale - scale) < 0.001) return Promise.resolve(existing.canvas);

  if(renderTasks.has(num)){ try{ renderTasks.get(num).cancel(); }catch(e){} renderTasks.delete(num); }

  const shell = pageShells[num];
  if(!shell) return Promise.resolve();

  return pdfDoc.getPage(num).then(page => {
    const vpBase = page.getViewport({ scale: 1 });
    const cssW = Math.round(vpBase.width * (scale));
    const viewport = page.getViewport({ scale: scale });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    canvas.style.width = cssW + 'px';
    canvas.style.height = Math.round(viewport.height) + 'px';
    canvas.width = Math.floor(cssW * DPR);
    canvas.height = Math.floor(viewport.height * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const task = page.render({ canvasContext: ctx, viewport });
    renderTasks.set(num, task);

    return task.promise.then(() => {
      try{
        shell.innerHTML = '';
        const inner = document.createElement('div');
        inner.className = 'page-inner';
        inner.appendChild(canvas);
        shell.appendChild(inner);

        const shellRect = shell.getBoundingClientRect();
        const innerRect = inner.getBoundingClientRect();
        if(innerRect.width > shellRect.width + 1 || innerRect.height > shellRect.height + 1){
          shell.classList.add('canvas-scroll');
        } else {
          shell.classList.remove('canvas-scroll');
          shell.scrollLeft = 0; shell.scrollTop = 0;
        }
        rendered.set(num, { canvas, scale });

        if(preserveFocus && preserveFocus.page === num && typeof preserveFocus.fraction === 'number'){
          const oldHeight = (preserveFocus.oldHeight || null);
          const newH = inner.getBoundingClientRect().height;
          if(oldHeight && oldHeight > 0){
            const oldLocal = preserveFocus.fraction * oldHeight;
            const newLocal = preserveFocus.fraction * newH;
            const delta = newLocal - oldLocal;
            container.scrollTop += delta;
          } else {
            shell.scrollIntoView({ behavior: 'auto', block: 'center' });
          }
        }
      } catch(e){ console.error('swap error', e); }
      renderTasks.delete(num);
      return canvas;
    }).catch(err=>{ if(!err.message.includes('cancelled')) console.error(err); });
  });
}

/* ====== Unload far ====== */
function unloadFar(center){
  for(const [num, info] of rendered){
    if(Math.abs(num - center) > KEEP_NEIGHBOR){
      try{ pageShells[num].innerHTML = `<div class="page-loading">Page ${num}</div>`; }catch(e){}
      rendered.delete(num);
      if(renderTasks.has(num)){ try{ renderTasks.get(num).cancel(); }catch(e){} renderTasks.delete(num); }
    }
  }
}

/* ====== Ensure neighbors ====== */
function ensureAround(center, preserveFocus=null){
  const start = Math.max(1, center - KEEP_NEIGHBOR);
  const end = Math.min(pageCount, center + KEEP_NEIGHBOR);
  const promises=[];
  for(let i=start;i<=end;i++){
    const info=rendered.get(i);
    const desired=actualScaleFromUi(uiScale);
    if(info && Math.abs(info.scale - desired) < 0.001) continue;
    let pf=null;
    if(preserveFocus && preserveFocus.page===i){
      pf={page:i,fraction:preserveFocus.fraction,oldHeight:preserveFocus.oldHeight};
    }
    promises.push(renderPage(i,desired,pf));
  }
  unloadFar(center);
  return Promise.all(promises);
}

/* ====== Visible page detect (rAF) ====== */
let rafScroll=null;
container.addEventListener('scroll', ()=>{
  if(rafScroll) cancelAnimationFrame(rafScroll);
  rafScroll=requestAnimationFrame(()=>{
    rafScroll=null;
    const crect=container.getBoundingClientRect();
    const centerY=crect.top+crect.height/2;
    let best=visiblePage,bestDist=Infinity;
    for(let i=1;i<=pageCount;i++){
      const r=pageShells[i].getBoundingClientRect();
      if(r.top<=centerY && r.bottom>=centerY){ best=i;break; }
      const dist=Math.min(Math.abs(r.top-centerY),Math.abs(r.bottom-centerY));
      if(dist<bestDist){bestDist=dist;best=i;}
    }
    if(best!==visiblePage){
      visiblePage=best;
      pageNumInput.value=visiblePage;
      visiblePageEl.textContent=visiblePage;
      ensureAround(visiblePage);
    }
  });
});

/* ====== Scroll to page helper ====== */
function scrollToPage(n){
  if(n<1||n>pageCount) return;
  ensureAround(n).then(()=>{ pageShells[n].scrollIntoView({behavior:'smooth',block:'center'}); });
}

/* ====== Smooth zoom ====== */
let smoothZoomTimer=null;
function smoothZoom(newUi,focalPage=null,focalFraction=0.5){
  newUi=clamp(newUi,UI_MIN,UI_MAX);
  const targetActual=actualScaleFromUi(newUi);
  rendered.forEach((info)=>{
    const factor = info.scale ? (targetActual / info.scale) : 1;
    info.canvas.style.transformOrigin='0 0';
    info.canvas.style.transform=`scale(${factor})`;
  });
  zoomLevelEl.textContent = Math.round(newUi*100) + '%';

  clearTimeout(smoothZoomTimer);
  smoothZoomTimer=setTimeout(()=>{
    uiScale=newUi;
    updateZoomUI();
    ensureAround(focalPage||visiblePage,{page:focalPage||visiblePage,fraction:focalFraction});
    rendered.forEach((info)=>{ info.canvas.style.transform=''; });
  }, 50);
}

/* ====== Pinch-to-zoom ====== */
let pinch = { active:false, startDist:0, startUi:1, focalPage:null, focalFraction:0, lastUi:1, oldHeights:{} };
function getDist(t1,t2){ const dx=t1.clientX-t2.clientX, dy=t1.clientY-t2.clientY; return Math.hypot(dx,dy); }
function getMid(t1,t2){ return { x:(t1.clientX+t2.clientX)/2, y:(t1.clientY+t2.clientY)/2 }; }

container.addEventListener('touchstart', (e) => {
  if(e.touches.length === 2){
    pinch.active = true;
    pinch.startDist = getDist(e.touches[0], e.touches[1]);
    pinch.startUi = uiScale; pinch.lastUi = uiScale;
    const mid = getMid(e.touches[0], e.touches[1]);
    let found = null;
    for(let i=1;i<=pageCount;i++){
      const r = pageShells[i].getBoundingClientRect();
      if(mid.y >= r.top && mid.y <= r.bottom){ found = { page:i, local: mid.y - r.top, h: r.height }; break; }
    }
    if(found){ pinch.focalPage = found.page; pinch.focalFraction = clamp(found.local / Math.max(1, found.h), 0, 1); }
    else { pinch.focalPage = visiblePage; pinch.focalFraction = 0.5; }
    pinch.oldHeights[pinch.focalPage] = pageShells[pinch.focalPage] ? pageShells[pinch.focalPage].getBoundingClientRect().height : null;
    e.preventDefault();
  }
}, { passive:false });

container.addEventListener('touchmove', (e) => {
  if(pinch.active && e.touches.length === 2){
    const d = getDist(e.touches[0], e.touches[1]);
    let newUi = clamp(pinch.startUi * (d / pinch.startDist), UI_MIN, UI_MAX);
    pinch.lastUi = newUi;
    smoothZoom(newUi, pinch.focalPage, pinch.focalFraction);
    e.preventDefault();
  }
}, { passive:false });

container.addEventListener('touchend', (e) => {
  if(pinch.active && e.touches.length < 2){
    uiScale = pinch.lastUi || uiScale;
    updateZoomUI();
    ensureAround(pinch.focalPage || visiblePage, { page: pinch.focalPage || visiblePage, fraction: pinch.focalFraction, oldHeight: pinch.oldHeights[pinch.focalPage || visiblePage] });
    pinch.active = false; pinch.focalPage = null; pinch.focalFraction = 0; pinch.oldHeights = {};
  }
}, { passive:true });

/* ====== Buttons ====== */
document.getElementById('zoom-in').addEventListener('click', ()=> { smoothZoom(uiScale + 0.25, visiblePage, 0.5); });
document.getElementById('zoom-out').addEventListener('click', ()=> { smoothZoom(uiScale - 0.25, visiblePage, 0.5); });

document.getElementById('fit-width').addEventListener('click', ()=>{
  if(!pdfDoc) return;
  pdfDoc.getPage(1).then(page=>{
    const vp = page.getViewport({ scale: 1 });
    const containerStyle = window.getComputedStyle(container);
    const padLeft = parseFloat(containerStyle.paddingLeft) || 0;
    const padRight = parseFloat(containerStyle.paddingRight) || 0;
    const avail = Math.min(900, container.clientWidth - padLeft - padRight);
    const actualDesired = avail / vp.width;
    uiScale = clamp( +(actualDesired / BASELINE).toFixed(3), UI_MIN, UI_MAX );
    updateZoomUI();
    ensureAround(visiblePage);
  }).catch(err => console.error(err));
});

pageNumInput.addEventListener('change', ()=>{
  let v = parseInt(pageNumInput.value) || visiblePage;
  v = clamp(v, 1, pageCount);
  scrollToPage(v);
});

/* ====== Dark mode toggle ====== */
let isDarkMode = false;
const darkModeBtn = document.getElementById('dark-mode');
darkModeBtn.addEventListener('click', ()=>{
  isDarkMode = !isDarkMode;
  document.body.classList.toggle('dark-mode');
  darkModeBtn.innerHTML = isDarkMode ? '☀️' : '🌙';
});

/* ====== Load PDF ====== */
function init(){
  pdfjsLib.getDocument({
    ...preparePdfLoadOptions(PDF_URL),
    enableXfa: true
  }).promise.then(pdf => {
    pdfDoc = pdf;
    pageCount = pdf.numPages;
    pageCountEl.textContent = pageCount;
    pageNumInput.max = pageCount;
    buildShells(pageCount);
    updateZoomUI();
    ensureAround(1);
  }).catch(err => {
    pagesContainer.innerHTML = `<div style="padding:20px;color:#ff6b6b">PDF load failed: ${err && err.message ? err.message : err}</div>`;
    console.error('PDF load failed:', err);
  });
}
init();

/* ====== Resize handling ====== */
let resizeTimer = null;
window.addEventListener('resize', ()=> {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(()=> { ensureAround(visiblePage); }, 200);
});
