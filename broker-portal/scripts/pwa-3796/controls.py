"""BACKLOG-3796 mutation controls. Applies each mutation by exact-string replace
(exits 2 if it does not match), prints MUTATION APPLIED + the changed lines, runs
the pwa-3796 suites, prints the red test names, then restores the file with
git checkout. Commit your work before running it.
Usage: python3 broker-portal/scripts/pwa-3796/controls.py [M1 M2 ...]
"""
import os, subprocess, re, sys
W=subprocess.run(['git','-C',os.path.dirname(os.path.abspath(__file__)),'rev-parse','--show-toplevel'],capture_output=True,text=True,check=True).stdout.strip()
BP=W+'/broker-portal/'
M=[
 ('M1 network-first+cache fallback','public/sw.js',
  "    fetch(request).catch(function () {\n      return offlineResponse();\n    })",
  "    fetch(request).then(function (res) { var c = res.clone(); caches.open('pages').then(function (cache) { cache.put(request, c); }); return res; }).catch(function () {\n      return caches.match(request).then(function (hit) { return hit || offlineResponse(); });\n    })"),
 ('M2 intercept all GETs','public/sw.js',"if (request.mode !== 'navigate' || request.method !== 'GET') {","if (request.method !== 'GET') {"),
 ('M3 precache /dashboard','public/sw.js',"self.addEventListener('install', function () {\n  self.skipWaiting();","self.addEventListener('install', function (event) {\n  self.skipWaiting();\n  event.waitUntil(caches.open('shell').then(function (c) { return c.addAll(['/dashboard']); }));"),
 ('M4 activate no longer deletes caches','public/sw.js',"            return caches.delete(key);","            return key;"),
 ('M5 offline copy claims nothing stored','public/sw.js',"Reconnect and tap Retry.</p>","Nothing from your account is stored on this device.</p>"),
 ('M6 unanchored matcher','middleware.ts',"sw\\\\.js$|manifest\\\\.webmanifest$|","sw\\\\.js|manifest\\\\.webmanifest|"),
 ('M7 pre-change matcher','middleware.ts',"sw\\\\.js$|manifest\\\\.webmanifest$|",""),
 ('M8 512 file declared 192','app/manifest.ts',"{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }","{ src: '/icons/icon-512.png', sizes: '192x192', type: 'image/png', purpose: 'any' }"),
 ('M9 registers in dev','components/pwa/ServiceWorkerRegister.tsx',"if (process.env.NODE_ENV !== 'production') {","if (false) {"),
 ('M10 drops updateViaCache','components/pwa/ServiceWorkerRegister.tsx',"{ scope: '/', updateViaCache: 'none' }","{ scope: '/' }"),
 # Part 2: root layout + next.config.mjs
 ('M11 ServiceWorkerRegister not mounted','app/layout.tsx',"        <ServiceWorkerRegister />\n",""),
 ('M12 themeColor in metadata, not viewport','app/layout.tsx',"  appleWebApp: { capable: true, title: 'Keepr', statusBarStyle: 'black' },\n};\n\n// Next 15: themeColor belongs in the viewport export, not metadata (BACKLOG-3796).\nexport const viewport: Viewport = { themeColor: '#111827' };","  appleWebApp: { capable: true, title: 'Keepr', statusBarStyle: 'black' },\n  themeColor: '#111827',\n} as Metadata;\n\nexport const viewport: Viewport = {};"),
 ('M13 iOS title is the long page title','app/layout.tsx',"title: 'Keepr', statusBarStyle","title: 'Keepr - Broker Portal', statusBarStyle"),
 ('M14 CSP manifest-src removed','next.config.mjs',"      \"manifest-src 'self'\",\n",""),
 ('M15 /sw.js no-cache header removed','next.config.mjs',"        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],","        headers: [],"),
]
sel=sys.argv[1:] 
for name,f,old,new in M:
  if sel and name.split()[0] not in sel: continue
  p=BP+f; s=open(p).read()
  if s.count(old)!=1: print('MUTATION NOT APPLIED', name, s.count(old)); sys.exit(2)
  open(p,'w').write(s.replace(old,new))
  num=subprocess.run(['git','-C',W,'diff','--numstat','--',p],capture_output=True,text=True).stdout.strip()
  print('==',name,'| MUTATION APPLIED |',num); 
  for l in subprocess.run(['git','-C',W,'diff','-U0','--',p],capture_output=True,text=True).stdout.splitlines():
    if l.startswith('+') and not l.startswith('+++'): print('   ',l[:160])
  r=subprocess.run(['npx','jest','-c','broker-portal/jest.config.js','broker-portal/__tests__/pwa-3796','--bail=0'],cwd=W,capture_output=True,text=True)
  out=r.stdout+r.stderr
  print('   exit',r.returncode,'|',(re.findall(r'Tests:.*',out) or ['NO COUNT'])[0])
  for l in out.splitlines():
    if l.strip().startswith('● ') and '›' in l: print('   RED',l.strip()[:150])
  subprocess.run(['git','-C',W,'checkout','--',p])
print('final diff:',subprocess.run(['git','-C',W,'status','--short','broker-portal'],capture_output=True,text=True).stdout or 'clean')
