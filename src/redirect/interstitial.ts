// The page served instead of a 30x on links with device tracking on. It reads
// what only the browser knows, posts it to SIGNALS_PATH with the click's token,
// then replaces itself with the destination. Never waits more than ~0.5 s for
// slow APIs, and a meta refresh forwards anyway if the script fails or JS is off.

/** Where the page posts its signals. Not a valid slug, so it can't shadow a link. */
export const SIGNALS_PATH = '/_/signals';

/** Largest signals body accepted, in bytes. */
export const MAX_SIGNALS_BODY = 4096;

// Runs in the visitor's browser. `D` is the destination, `T` the click token.
// Every probe is optional: an API that's missing or throws just leaves its field out.
const SCRIPT = String.raw`(function(){
var n=navigator,s={t:T},done=false;
function go(){if(!done){done=true;location.replace(D)}}
function tryit(f){try{return f()}catch(e){}}
setTimeout(go,1500);
s.screen=screen.width+'x'+screen.height+'@'+(Math.round(devicePixelRatio*100)/100);
s.orientation=tryit(function(){return screen.orientation.type});
s.timezone=tryit(function(){return Intl.DateTimeFormat().resolvedOptions().timeZone});
s.language=n.language;
s.memory=n.deviceMemory;
s.touch=n.maxTouchPoints;
if(typeof n.webdriver==='boolean')s.webdriver=n.webdriver;
var c=n.connection;
if(c)s.connection=c.type&&c.type!=='unknown'?c.type:c.effectiveType;
s.gpu=tryit(function(){
  var g=document.createElement('canvas').getContext('webgl');
  var x=g.getExtension('WEBGL_debug_renderer_info');
  return g.getParameter(x?x.UNMASKED_RENDERER_WEBGL:g.RENDERER);
});
var bait=document.createElement('div');
bait.className='adsbox ad-banner pub_300x250 textads';
bait.style.cssText='position:absolute;left:-999px;width:1px;height:1px';
bait.innerHTML='&nbsp;';
document.body.appendChild(bait);
function incognito(){
  var st=n.storage;
  if(!st)return Promise.resolve(null);
  if(/Chrom/.test(n.userAgent)&&st.estimate){
    var heap=(performance.memory&&performance.memory.jsHeapSizeLimit)||536870912;
    return st.estimate().then(function(e){return e.quota<heap*2});
  }
  if(st.getDirectory)return st.getDirectory().then(function(){return false},function(){return true});
  return Promise.resolve(null);
}
function platform(){
  var u=n.userAgentData;
  if(!u||!u.getHighEntropyValues)return Promise.resolve(null);
  return u.getHighEntropyValues(['platformVersion']).then(function(h){
    var v=parseInt(h.platformVersion,10)||0;
    // Windows reports 13+ for Windows 11 and 1-10 for Windows 10.
    if(u.platform==='Windows')return v>=13?'Windows 11':'Windows 10';
    return u.platform+(h.platformVersion?' '+h.platformVersion:'');
  });
}
var tasks=[
  platform().then(function(v){if(v)s.platform=v}),
  n.getBattery?n.getBattery().then(function(b){s.battery=Math.round(b.level*100);s.charging=b.charging}):0,
  incognito().then(function(v){if(v!==null)s.incognito=v}),
  new Promise(function(r){setTimeout(r,50)}).then(function(){
    var cs=getComputedStyle(bait);
    s.adBlocker=!bait.offsetHeight||cs.display==='none'||cs.visibility==='hidden';
  })
];
Promise.race([
  Promise.all(tasks.map(function(p){return Promise.resolve(p).catch(function(){})})),
  new Promise(function(r){setTimeout(r,500)})
]).then(function(){
  var body=JSON.stringify(s);
  if(!(n.sendBeacon&&n.sendBeacon(P,body)))fetch(P,{method:'POST',body:body,keepalive:true}).catch(function(){});
  go();
});
})();`;

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

/** A JS string literal that can't close the surrounding <script>. */
function jsString(value: string): string {
    // `<` becomes its JSON escape, so a destination can't close the script tag.
    return JSON.stringify(value).replaceAll('<', `${String.fromCodePoint(92)}u003c`);
}

export function interstitialHtml(destination: string, token: string): string {
    const href = escapeHtml(destination);
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer-when-downgrade">
<meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="3;url=${href}">
<title>Redirecting…</title>
<style>body{font:15px system-ui,sans-serif;color:#666;display:grid;place-items:center;min-height:90vh;margin:0}a{color:inherit}</style>
</head><body>
<p>Redirecting to <a href="${href}">${escapeHtml(hostOf(destination))}</a>…</p>
<script>var D=${jsString(destination)},T=${jsString(token)},P=${jsString(SIGNALS_PATH)};${SCRIPT}</script>
</body></html>`;
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}
