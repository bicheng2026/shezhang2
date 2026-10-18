/* 2026-10-18 修复项验收：密码锁 / 历史截断 / PDF 打开速度 / 联网一开即用
   用法：先 `node web/_static_server.mjs 8777`，再 `node web/_cdp_fix_check.mjs` */
import { spawn } from 'child_process'
import http from 'http'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9228
const TARGET = process.env.TARGET || 'http://127.0.0.1:8777/index.html'
const sleep = ms => new Promise(r => setTimeout(r, ms))

function httpGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => res(s))
    }).on('error', rej)
  })
}
let pass = 0, fail = 0
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n + (e ? '  → ' + e : '')) } else { fail++; console.log('  ✗ ' + n + (e ? '  → ' + e : '')) } }

async function main() {
  const args = ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + process.cwd() + '/.cdp-tmp-fix',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', 'about:blank']
  const ch = spawn(CHROME, args, { stdio: 'ignore', detached: false })
  let up = false
  for (let i = 0; i < 40; i++) { await sleep(500); try { await httpGet('/json/version'); up = true; break } catch (e) {} }
  if (!up) { console.log('✗ Chrome 调试端口没起来'); ch.kill(); process.exit(1) }
  const ver = JSON.parse(await httpGet('/json/version'))
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let seq = 0; const pending = new Map(); const exceps = []
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown')
      exceps.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '')
  }
  const send = (method, params, sessionId) => new Promise(res => {
    const id = ++seq; pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }))
  })
  const t = await send('Target.createTarget', { url: 'about:blank' })
  const att = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })
  const sid = att.result.sessionId
  await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid)
  await send('Network.enable', {}, sid); await send('Network.setCacheDisabled', { cacheDisabled: true }, sid)
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)
    if (r.result?.exceptionDetails) return 'EVALERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  console.log('打开', TARGET)
  await send('Page.navigate', { url: TARGET }, sid)
  await sleep(9000)

  /* ---------------- 1. 密码锁 ---------------- */
  console.log('\n== 密码：设置的那个密码真的能开门吗 ==')
  ok('unlock / enterSite 存在', String(await ev('typeof unlock')) === 'function')
  // ① 旧键 sz2_pw 应当被迁移成 sz2_mypw，并且能登录
  const legacy = await ev(`(async()=>{
    localStorage.removeItem('sz2_mypw'); localStorage.removeItem('sz2_pw');
    localStorage.setItem('sz2_pw', await sha256('oldpass1'));
    ACCESS = {lock:true, user:'x'};
    document.getElementById('pw').value = 'oldpass1';
    await unlock();
    return JSON.stringify({
      moved: !!localStorage.getItem('sz2_mypw'),
      oldGone: !localStorage.getItem('sz2_pw'),
      opened: document.getElementById('lock').style.display === 'none'
    });
  })()`)
  console.log('  ', legacy)
  ok('旧键 sz2_pw 自动迁移到 sz2_mypw', /"moved":true/.test(String(legacy)))
  ok('旧密码能正常进入（以前设了等于没设）', /"opened":true/.test(String(legacy)))

  // ② 新键直接生效
  const fresh = await ev(`(async()=>{
    localStorage.removeItem('sz2_mypw');
    localStorage.setItem('sz2_mypw', await sha256('newpass9'));
    ACCESS = {lock:true, user:'x'};
    document.getElementById('lock').style.display='flex'; document.getElementById('app').style.display='none';
    document.getElementById('pw').value = 'newpass9';
    await unlock();
    return document.getElementById('lock').style.display === 'none';
  })()`)
  ok('本机密码（sz2_mypw）能进入', String(fresh) === 'true', String(fresh))

  // ③ 错密码必须拒绝
  const bad = await ev(`(async()=>{
    localStorage.removeItem('sz2_mypw');
    localStorage.setItem('sz2_mypw', await sha256('rightpass'));
    ACCESS = {lock:true, user:'x'};
    document.getElementById('lock').style.display='flex';
    document.getElementById('pw').value = 'wrongpass';
    await unlock();
    return document.getElementById('lock').style.display !== 'none';
  })()`)
  ok('错密码被拒绝', String(bad) === 'true', String(bad))

  // ④ 设置面板写的是哪个键（读源码，避开 alert 弹窗）
  const src = String(await ev(`fetch('index.html',{cache:'no-store'}).then(r=>r.text())`))
  ok('设置面板写 sz2_mypw（不再是死键 sz2_pw）', /setItem\("sz2_mypw", await sha256\(np\)\)/.test(src))
  ok('强制改密存的是摘要而非明文', /setItem\('sz2_mypw', await sha256Hex\(a\)\)/.test(src))

  /* ---------------- 2. 历史会话 ---------------- */
  console.log('\n== 历史：还会不会被截断 ==')
  const hist = await ev(`(async()=>{
    const s0 = SS.new_();
    const id = s0.id;
    const add = h => SS.push({who:'我', html:h, cls:'me'});
    add('历史测试 1'); add('历史测试 2'); add('历史测试 3');
    await SS.flush();
    const after = await IDB.get('s:' + id);
    // 模拟「正文未加载」：msgs=null 但目录里记着 3 条，然后再落一次盘
    const s = SS.list.find(x => x.id === id);
    s.msgs = null; s.n = 3;
    SS._dirty.add(id);
    await SS.flush();
    const afterNull = await IDB.get('s:' + id);
    // 再 push 一条（正文未加载时的 bug 场景）：应当先抢读、再补上这条，不许覆盖
    SS.push({who:'我', html:'历史测试 4', cls:'me'});
    await new Promise(r=>setTimeout(r,600));
    await SS.flush();
    const afterPush = await IDB.get('s:' + id);
    // 重新读回
    s.msgs = null;
    await SS.hydrate(id);
    const rel = (SS.list.find(x=>x.id===id).msgs || []).length;
    return JSON.stringify({
      after: after && after.length,
      afterNull: afterNull && afterNull.length,
      afterPush: afterPush && afterPush.length,
      reloaded: rel
    });
  })()`)
  console.log('  ', hist)
  ok('写入后仓里有 3 条', /"after":3/.test(String(hist)))
  ok('正文未加载时落盘不会清空历史', /"afterNull":3/.test(String(hist)))
  ok('正文未加载时 push 不覆盖旧历史', /"afterPush":4/.test(String(hist)))
  ok('重新读回条数一致（4 条）', /"reloaded":4/.test(String(hist)))

  const hyd = await ev(`(async()=>{
    const s = SS.new_(); const id = s.id;
    SS.push({who:'我',html:'x',cls:'me'}); await SS.flush();
    const o = SS.list.find(x=>x.id===id);
    o.msgs = null;
    // 让 hydrate 走失败路径：临时把 IDB.get 换成永远 reject
    const bak = IDB.get; IDB.get = () => Promise.reject(new Error('force-fail'));
    await SS.hydrate(id);
    const failedFlag = !!o._failed, keptNull = o.msgs === null;
    IDB.get = bak;
    return JSON.stringify({failedFlag, keptNull});
  })()`)
  console.log('  ', hyd)
  ok('读失败时保持未加载态（不再写成空数组）', /"keptNull":true/.test(String(hyd)))

  /* ---------------- 3. PDF 打开速度 ---------------- */
  console.log('\n== PDF：点开还等不等 ==')
  const pdf = await ev(`(async()=>{
    const d = (DOCS||[]).find(x=>{ try{ const a=pdfPartsOf(x); return a && a[0]; }catch(e){ return false } });
    if(!d) return 'NO-PDF-DOC';
    const t0 = performance.now();
    await openDoc(d);
    const ms = Math.round(performance.now() - t0);
    const el = document.getElementById('rdPdf');
    const src = el ? (el.getAttribute('src')||'') : '';
    return JSON.stringify({ ms, hasSrc: !!src, on: !!el && el.style.display === 'block' });
  })()`)
  console.log('  ', pdf)
  ok('存在可打开的 PDF 书', String(pdf) !== 'NO-PDF-DOC', String(pdf).slice(0, 60))
  ok('点开即切到 PDF（不等探测）', /"hasSrc":true/.test(String(pdf)))
  ok('切换耗时 < 900ms', (() => {
    const m = /"ms":(\d+)/.exec(String(pdf)); return m && Number(m[1]) < 900
  })(), String(pdf).slice(0, 40))

  /* ---------------- 4. 联网：一点就连 ---------------- */
  console.log('\n== 联网：点一下就开，右键才进设置 ==')
  const net = await ev(`(async()=>{
    localStorage.removeItem('sz2_net'); NET.load();
    document.getElementById('netmask').style.display = 'none';
    const before = NET.on;
    document.getElementById('netbtn').click();
    await new Promise(r=>setTimeout(r,200));
    const tip = document.getElementById('nettip');
    return JSON.stringify({
      before,
      after: NET.on,
      maskOpen: document.getElementById('netmask').style.display === 'flex',
      btn: document.getElementById('netbtn').textContent,
      tip: tip ? tip.textContent : '',
      boxes: document.querySelectorAll('#netlist input[type=checkbox]').length
    });
  })()`)
  console.log('  ', net)
  ok('单击即开，不弹面板', /"after":true/.test(String(net)) && /"maskOpen":false/.test(String(net)))
  ok('按钮即时变「开」', /联网：开/.test(String(net)))
  ok('弹出轻提示（不打断）', /联网已开启/.test(String(net)))
  ok('通道列表无「启用」勾选框', /"boxes":0/.test(String(net)))

  const ctx = await ev(`(async()=>{
    document.getElementById('netmask').style.display = 'none';
    document.getElementById('netbtn').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,120));
    return document.getElementById('netmask').style.display === 'flex';
  })()`)
  ok('右键进联网设置（面板打开）', String(ctx) === 'true', String(ctx))

  const off = await ev(`(async()=>{
    document.getElementById('netmask').style.display = 'none';
    NET.setSw(true);
    document.getElementById('netbtn').click();
    await new Promise(r=>setTimeout(r,120));
    return NET.on;
  })()`)
  ok('再点一下即关', String(off) === 'false', String(off))

  /* ---------------- 5. 运行期异常 ---------------- */
  console.log('\n== 运行期异常 ==')
  if (!exceps.length) console.log('  (无)')
  exceps.slice(-8).forEach(e => console.log('  ' + String(e).slice(0, 160)))
  ok('无运行期异常', exceps.length === 0, exceps.length + ' 条')

  console.log('\n' + (fail === 0 ? '✓ 全部 ' + pass + ' 项通过' : '✗ 通过 ' + pass + ' / 失败 ' + fail))
  ws.close(); ch.kill(); process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error('探测脚本出错：', e); process.exit(2) })
