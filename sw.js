/* 蛇杖二号 · Service Worker
   策略：只缓存「应用外壳」（页面 + 图标），文库密文与索引一律走网络。
   —— 文库 105 MB 且是密文，缓存下来既占手机空间又没意义；壳缓存好就能离线打开界面。 */

/* v3：index.html 换了引用 agent.js 的版本号，外壳必须抬级，
   否则同学端吃到的还是缓存里的旧 index.html（那份引用的是不带版本号的旧内核）。
   注：agent.js 故意【不】进 SHELL —— 它靠 ?v= 版本号破 CDN 缓存，
      这样每次只改一个版本号就能让全网拿到新内核，不必动 sw.js。 */
const CACHE = "sz2-shell-v3";
const SHELL = [
  "./", "./index.html", "./manifest.json",
  "./icon-192.png", "./icon-512.png", "./icon-180.png", "./icon-32.png"
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;          // 跨域（CDN / LLM 接口）完全不插手
  if (/\/(lib|data)\//.test(url.pathname)) return;          // 文库密文 / 索引：始终走网络

  const isDoc = req.mode === "navigate" || /\/$|index\.html$/.test(url.pathname);
  if (isDoc) {
    // 页面：网络优先（保证拿到最新版），断网时回落上次缓存
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", cp));
        }
        return res;
      } catch (_) {
        return (await caches.match("./index.html")) || Response.error();
      }
    })());
    return;
  }

  // 其他同源静态资源（图标等）：缓存优先
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    } catch (_) {
      return Response.error();
    }
  })());
});
