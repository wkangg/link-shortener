// The page served instead of a 30x on links with device tracking on. It reads
// what only the browser knows, posts it to SIGNALS_PATH with the click's token,
// then replaces itself with the destination. Never waits more than ~0.5 s for
// slow APIs, and a meta refresh forwards anyway if the script fails or JS is off.

import { CODECS, FONTS } from '../shared/probes.ts';

/** Where the page posts its signals. Not a valid slug, so it can't shadow a link. */
export const SIGNALS_PATH = '/_/signals';

/** Largest signals body accepted, in bytes. Voices and WebGL extensions are the big ones. */
export const MAX_SIGNALS_BODY = 16_384;

/** Key positions read from the keyboard layout map, in US QWERTY order. */
const KEY_CODES = [
    ...[...'QWERTYUIOP'].map(k => `Key${k}`),
    'BracketLeft',
    'BracketRight',
    ...[...'ASDFGHJKL'].map(k => `Key${k}`),
    'Semicolon',
    'Quote',
    ...[...'ZXCVBNM'].map(k => `Key${k}`),
    'Comma',
    'Period',
    'Slash'
];

// Runs in the visitor's browser. `D` is the destination, `T` the click token.
// Every probe is optional: an API that's missing or throws just leaves its field out.
const SCRIPT = String.raw`(function(){
var CODECS=${JSON.stringify(CODECS.map(([mime]) => mime))},FONTS=${JSON.stringify(FONTS)},KEYS=${JSON.stringify(KEY_CODES)};
var n=navigator,s={t:T},done=false;
function go(){if(!done){done=true;location.replace(D)}}
function tryit(f){try{return f()}catch(e){}}
function hash(t){var h=0x811c9dc5;for(var i=0;i<t.length;i++){h^=t.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(16)}
setTimeout(go,1500);
s.screen=screen.width+'x'+screen.height+'@'+(Math.round(devicePixelRatio*100)/100);
s.display=screen.availWidth+'x'+screen.availHeight+'x'+screen.colorDepth;
s.orientation=tryit(function(){return screen.orientation.type});
s.timezone=tryit(function(){return Intl.DateTimeFormat().resolvedOptions().timeZone});
s.language=n.language;
s.memory=n.deviceMemory;
s.cores=n.hardwareConcurrency;
s.touch=n.maxTouchPoints;
if(typeof n.webdriver==='boolean')s.webdriver=n.webdriver;
var c=n.connection;
if(c){
  s.connection=c.type&&c.type!=='unknown'?c.type:c.effectiveType;
  s.downlink=c.downlink;
  s.rtt=c.rtt;
  if(typeof c.saveData==='boolean')s.saveData=c.saveData;
}
s.gpu=tryit(function(){
  var g=document.createElement('canvas').getContext('webgl');
  var x=g.getExtension('WEBGL_debug_renderer_info');
  return g.getParameter(x?x.UNMASKED_RENDERER_WEBGL:g.RENDERER);
});
s.codecs=tryit(function(){
  var v=document.createElement('video'),a=document.createElement('audio'),M=window.MediaSource;
  return CODECS.map(function(t){
    var p=(t.indexOf('audio/')===0?a:v).canPlayType(t);
    return (p==='probably'?2:p==='maybe'?1:0)+(M&&M.isTypeSupported&&M.isTypeSupported(t)?3:0);
  }).join('');
});
s.fonts=tryit(function(){
  var x=document.createElement('canvas').getContext('2d'),base=['monospace','sans-serif','serif'],w={};
  function m(f){x.font='72px '+f;return x.measureText('mmmmmmmmmmlli10OQ@#').width}
  base.forEach(function(b){w[b]=m(b)});
  return FONTS.map(function(f){
    return base.some(function(b){return m("'"+f+"',"+b)!==w[b]})?1:0;
  }).join('');
});
// Dark mode is reported on its own, outside the fingerprint: auto dark mode flips it by time of day.
s.darkMode=tryit(function(){return matchMedia('(prefers-color-scheme: dark)').matches});
s.settings=tryit(function(){
  function q(m){return matchMedia(m).matches?1:0}
  return [
    n.cookieEnabled?1:0,
    n.doNotTrack==='1'||window.doNotTrack==='1'?1:0,
    n.globalPrivacyControl?1:0,
    n.pdfViewerEnabled?1:0,
    q('(prefers-reduced-motion: reduce)'),
    q('(prefers-contrast: more)'),
    q('(forced-colors: active)'),
    q('(prefers-reduced-transparency: reduce)'),
    q('(inverted-colors: inverted)')
  ].join('');
});
s.viewport=innerWidth+'x'+innerHeight;
if(n.languages)s.languages=Array.prototype.slice.call(n.languages,0,20);
if(typeof screen.isExtended==='boolean')s.multiMonitor=screen.isExtended;
// Regional formats. The sample date is formatted in UTC so the timezone isn't counted twice.
s.intl=tryit(function(){
  var o=Intl.DateTimeFormat().resolvedOptions();
  return {
    locale:o.locale,
    calendar:o.calendar,
    numbering:o.numberingSystem,
    hourCycle:Intl.DateTimeFormat(undefined,{hour:'numeric'}).resolvedOptions().hourCycle,
    date:new Date(Date.UTC(2001,1,3,16,5,6)).toLocaleString(undefined,{timeZone:'UTC'}),
    number:(1234567.891).toLocaleString()
  };
});
s.webgl=tryit(function(){
  var g=document.createElement('canvas').getContext('webgl');
  if(!g)return;
  function p(k){return g.getParameter(g[k])}
  function pair(k){var v=p(k);return v[0]+'-'+v[1]}
  var x=g.getExtension('WEBGL_debug_renderer_info'),f=g.getShaderPrecisionFormat(g.FRAGMENT_SHADER,g.HIGH_FLOAT);
  return {
    version:p('VERSION'),
    shading:p('SHADING_LANGUAGE_VERSION'),
    vendor:x?g.getParameter(x.UNMASKED_VENDOR_WEBGL):p('VENDOR'),
    maxTexture:p('MAX_TEXTURE_SIZE'),
    maxCubeMap:p('MAX_CUBE_MAP_TEXTURE_SIZE'),
    maxRenderbuffer:p('MAX_RENDERBUFFER_SIZE'),
    maxViewport:pair('MAX_VIEWPORT_DIMS'),
    textureUnits:p('MAX_TEXTURE_IMAGE_UNITS'),
    vertexTextureUnits:p('MAX_VERTEX_TEXTURE_IMAGE_UNITS'),
    combinedTextureUnits:p('MAX_COMBINED_TEXTURE_IMAGE_UNITS'),
    vertexAttribs:p('MAX_VERTEX_ATTRIBS'),
    varyingVectors:p('MAX_VARYING_VECTORS'),
    vertexUniforms:p('MAX_VERTEX_UNIFORM_VECTORS'),
    fragmentUniforms:p('MAX_FRAGMENT_UNIFORM_VECTORS'),
    lineWidth:pair('ALIASED_LINE_WIDTH_RANGE'),
    pointSize:pair('ALIASED_POINT_SIZE_RANGE'),
    precision:f.precision+','+f.rangeMin+','+f.rangeMax,
    antialias:g.getContextAttributes().antialias,
    extensions:g.getSupportedExtensions()
  };
});
s.mediaFeatures=tryit(function(){
  function q(m){return matchMedia(m).matches}
  function pick(f,vals){for(var i=0;i<vals.length;i++)if(q('('+f+': '+vals[i]+')'))return vals[i]}
  return {
    gamut:pick('color-gamut',['rec2020','p3','srgb']),
    hdr:q('(dynamic-range: high)'),
    pointer:pick('pointer',['fine','coarse','none']),
    anyPointer:pick('any-pointer',['fine','coarse','none']),
    hover:q('(hover: hover)'),
    anyHover:q('(any-hover: hover)'),
    monochrome:q('(monochrome)')
  };
});
// Drawn twice: browsers that add noise to canvas reads (Brave, Firefox, Safari private) differ.
s.canvas=tryit(function(){
  function draw(){
    var c=document.createElement('canvas');c.width=240;c.height=60;
    var x=c.getContext('2d'),t='Cwm fjordbank glyphs vext quiz \u{1F603}';
    x.textBaseline='top';x.font='14px Arial';
    x.fillStyle='#f60';x.fillRect(100,1,62,20);
    x.fillStyle='#069';x.fillText(t,2,15);
    x.fillStyle='rgba(102,204,0,0.7)';x.fillText(t,4,17);
    x.globalCompositeOperation='multiply';x.fillStyle='#f0f';
    x.beginPath();x.arc(50,50,50,0,Math.PI*2,true);x.closePath();x.fill();
    return hash(c.toDataURL());
  }
  var a=draw();
  return a===draw()?a:'randomized';
});
// Floating-point quirks of the JS engine and the OS math library.
s.math=tryit(function(){
  var M=Math;
  return hash([M.acos(0.123),M.acosh(1e308),M.asinh(1),M.atanh(0.5),M.cbrt(100),M.cosh(1),
    M.expm1(1),M.log1p(10),M.sinh(1),M.tan(-1e300),M.tanh(1),M.pow(M.PI,-100)].join(','));
});
// The newest emoji version the system font draws: a supported emoji has colored pixels.
s.emoji=tryit(function(){
  var c=document.createElement('canvas');c.width=c.height=20;
  var x=c.getContext('2d',{willReadFrequently:true}),v=0;
  x.font='16px sans-serif';x.textBaseline='top';
  [[11,'\u{1F970}'],[12,'\u{1F971}'],[13,'\u{1F972}'],[14,'\u{1FAE0}'],[15,'\u{1FAE8}'],[16,'\u{1FAE9}']].forEach(function(e){
    x.clearRect(0,0,20,20);x.fillStyle='#000';x.fillText(e[1],0,0);
    var d=x.getImageData(0,0,20,20).data;
    for(var i=0;i<d.length;i+=4)if(d[i+3]&&(d[i]!==d[i+1]||d[i+1]!==d[i+2])){v=e[0];break}
  });
  return v;
});
var bait=document.createElement('div');
// Each class needs a generic EasyList hiding rule (##.ad_banner etc.); filter lists drop old bait names.
bait.className='ad_banner ad-slot ad-unit';
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
function hints(){
  var u=n.userAgentData;
  if(!u||!u.getHighEntropyValues)return null;
  return u.getHighEntropyValues(['platformVersion','fullVersionList','model','architecture','bitness','wow64','formFactors']).then(function(h){
    var v=parseInt(h.platformVersion,10)||0;
    // Windows reports 13+ for Windows 11 and 1-10 for Windows 10.
    var p=u.platform==='Windows'?(v>=13?'Windows 11':'Windows 10'):u.platform+(h.platformVersion?' '+h.platformVersion:'');
    if(p)s.platform=p;
    // The User-Agent header only has the major version; this has the full one.
    var b=(h.fullVersionList||[]).filter(function(x){return !/Not.?A.?Brand/i.test(x.brand)});
    if(b.length)s.browserVersion=b.map(function(x){return x.brand+' '+x.version}).join(', ');
    // The User-Agent header no longer names Android phones; client hints still do.
    if(h.model)s.model=h.model;
    s.architecture=h.architecture;
    s.bitness=h.bitness;
    s.wow64=h.wow64;
    s.formFactors=h.formFactors;
  });
}
function keyboard(){
  var k=n.keyboard;
  if(!k||!k.getLayoutMap)return null;
  return k.getLayoutMap().then(function(m){s.keyboard=KEYS.map(function(c){return m.get(c)||'?'}).join('')});
}
function audio(){
  var A=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(!A)return null;
  var ctx=new A(1,5000,44100),o=ctx.createOscillator(),k=ctx.createDynamicsCompressor();
  o.type='triangle';o.frequency.value=10000;
  k.threshold.value=-50;k.knee.value=40;k.ratio.value=12;k.attack.value=0;k.release.value=0.25;
  o.connect(k);k.connect(ctx.destination);o.start(0);
  return ctx.startRendering().then(function(b){
    var d=b.getChannelData(0),sum=0;
    for(var i=4500;i<5000;i++)sum+=Math.abs(d[i]);
    s.audio=String(sum);
  });
}
function voices(){
  var sy=window.speechSynthesis;
  if(!sy)return null;
  function take(){
    var v=sy.getVoices();
    if(v.length)s.voices=v.slice(0,100).map(function(x){return x.name+(x.lang?' ('+x.lang+')':'')});
    return v.length;
  }
  // Some browsers load the list asynchronously.
  if(take())return null;
  return new Promise(function(r){sy.addEventListener('voiceschanged',function(){take();r()})});
}
function devices(){
  var m=n.mediaDevices;
  if(!m||!m.enumerateDevices)return null;
  return m.enumerateDevices().then(function(l){
    var c={cameras:0,microphones:0,speakers:0},kinds={videoinput:'cameras',audioinput:'microphones',audiooutput:'speakers'};
    l.forEach(function(d){if(kinds[d.kind])c[kinds[d.kind]]++});
    s.mediaDevices=c;
  });
}
function permissions(){
  var p=n.permissions;
  if(!p||!p.query)return null;
  var out={},names=['geolocation','notifications','camera','microphone','persistent-storage','midi','clipboard-read'];
  return Promise.all(names.map(function(name){
    return p.query({name:name}).then(function(r){out[name]=r.state},function(){});
  })).then(function(){s.permissions=out});
}
function webgpu(){
  var g=n.gpu;
  if(!g)return null;
  return g.requestAdapter().then(function(a){
    if(!a)return;
    return Promise.resolve(a.info||(a.requestAdapterInfo&&a.requestAdapterInfo())).then(function(i){
      if(i)s.webgpu={vendor:i.vendor,architecture:i.architecture,device:i.device,description:i.description};
    });
  });
}
var tasks=[
  hints(),
  tryit(keyboard),
  tryit(audio),
  tryit(voices),
  tryit(devices),
  tryit(permissions),
  tryit(webgpu),
  n.getBattery?n.getBattery().then(function(b){s.battery=Math.round(b.level*100);s.charging=b.charging}):0,
  incognito().then(function(v){if(v!==null)s.incognito=v}),
  n.storage&&n.storage.estimate?n.storage.estimate().then(function(e){s.quota=e.quota}):0,
  new Promise(function(r){setTimeout(r,30)}).then(function(){
    var cs=getComputedStyle(bait);
    s.adBlocker=!bait.offsetHeight||cs.display==='none'||cs.visibility==='hidden';
  })
];
Promise.race([
  Promise.all(tasks.map(function(p){return Promise.resolve(p).catch(function(){})})),
  new Promise(function(r){setTimeout(r,500)})
]).then(function(){
  // Compared with the server's clock when the report arrives.
  s.clock=Date.now();
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
