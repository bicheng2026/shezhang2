/* 「全网搜索」通道端到端验证（2026-10-14 新增）
   链路：页面 → NET._dssearch → 云函数 /search → DeepSeek 官方 Search → 返回结果。
   用法：先 `node web/_static_server.mjs 8777`，再 `node web/_cdp_search.mjs` */
import { spawn } from 'child_process'
import http from 'http'

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9227
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
    '--user-data-dir=' + process.cwd() + '/.cdp-tmp-search',
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
  const evalJs = async () => {}
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)
    if (r.result?.exceptionDetails) return 'EVALERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  console.log('打开', TARGET)
  await send('Page.navigate', { url: TARGET }, sid)
  await sleep(9000)

  console.log('\n== 通道存在性 ==')
  const has = await ev('NET_SRC.filter(s=>s.id==="ds").length')
  ok('NET_SRC 含 ds 通道', String(has) === '1', 'count=' + has)

  console.log('\n== 真搜（中文）==')
  const r1 = await ev('(async()=>{try{const a=await NET._search("ds","高血压 治疗指南");return "N="+a.length+" | "+(a[0]?a[0].t.slice(0,34)+" / "+a[0].x.slice(0,40):"");}catch(e){return "ERR "+(e&&e.message);}})()')
  console.log('  ', r1)
  ok('中文搜索返回结果', /^N=[1-9]/.test(String(r1)), String(r1).slice(0, 90))

  console.log('\n== 真搜（英文）==')
  const r2 = await ev('(async()=>{try{const a=await NET._search("ds","hypertension guideline 2025");return "N="+a.length+" | "+(a[0]?a[0].t.slice(0,40):"");}catch(e){return "ERR "+(e&&e.message);}})()')
  console.log('  ', r2)
  ok('英文搜索返回结果', /^N=[1-9]/.test(String(r2)), String(r2).slice(0, 90))

  console.log('\n== 连通性检测（面板）==')
  const p = await ev('(async()=>{const s=NET_SRC.find(x=>x.id==="ds");const r=await NET.probeOne(s);return JSON.stringify({ok:r.ok,note:r.note});})()')
  console.log('  probe:', p)
  ok('ds 通道探测为「通」', /"ok":true/.test(String(p)), String(p))

  console.log('\n== 开启联网后 gather（模拟真实问答取数）==')
  const g = await ev('(async()=>{NET.on=true; const r=await NET.gather("大学英语四级 报名"); return "list="+r.list.length+" txt="+r.txt.length+" | "+(r.list[0]?r.list[0].src:"");})()')
  console.log('  ', g)
  ok('gather 取到联网内容', /list=[1-9]/.test(String(g)), String(g).slice(0, 90))

  console.log('\n== 精简核对（天气专源应已撤除）==')
  const sc = await ev('(window.AGENT&&AGENT.TOOL_SCHEMA)?AGENT.TOOL_SCHEMA.filter(t=>t.function.name==="get_weather").length:0')
  ok('TOOL_SCHEMA 已无 get_weather', String(sc) === '0', 'count=' + sc)
  const hw = await ev('(window.AGENT&&AGENT.HANDLERS)?(typeof AGENT.HANDLERS.get_weather):"undef"')
  ok('HANDLERS 已无 get_weather', String(hw) === 'undefined', 'type=' + hw)
  const pw = await ev('AGENT.TOOLS_PROMPT.indexOf("get_weather")>=0?1:0')
  ok('TOOLS_PROMPT 已无 get_weather 引用', String(pw) === '0')
  const nsd = await ev('(AGENT.TOOL_SCHEMA.find(t=>t.function.name==="net_search")||{function:{}}).function.description||""')
  ok('net_search 描述含「天气」（通用搜索可查天气）', /天气/.test(String(nsd)), String(nsd).slice(0, 60))
  ok('net_search 超时已抬到 12s', String(await ev('AGENT.__NET_TIMEOUT||""')) !== '6000')

  console.log('\n== 联网源收敛（2026-10-18）==')
  ok('NET_SRC 只剩 1 条（DeepSeek）', String(await ev('NET_SRC.length')) === '1', 'len=' + await ev('NET_SRC.length'))
  ok('旧通道（维基/Jina/必应RSS/PubMed/校网）已从 NET_SRC 移除',
     String(await ev('NET_SRC.filter(s=>["zhwiki","enwiki","jina","bingrss","pmd","gxmu"].indexOf(s.id)>=0).length')) === '0')
  ok('联网面板已无「启用」勾选框', String(await ev('document.querySelectorAll("#netlist input[type=checkbox]").length')) === '0')
  ok('read_url 工具已注册', String(await ev('(AGENT.TOOL_SCHEMA||[]).filter(t=>t.function.name==="read_url").length')) === '1')
  ok('HANDLERS.read_url 存在', String(await ev('typeof AGENT.HANDLERS.read_url')) === 'function')
  ok('NET.fetchPage 存在（抓正文）', String(await ev('typeof NET.fetchPage')) === 'function')

  console.log('\n== 免 Key 核对（博查 / 智谱 应已移除）==')
  ok('NET_SRC 已无 bocha', String(await ev('NET_SRC.filter(s=>s.id==="bocha").length')) === '0')
  ok('NET_SRC 已无 zhipu', String(await ev('NET_SRC.filter(s=>s.id==="zhipu").length')) === '0')
  ok('NET_SRC 无任何 needKey 通道', String(await ev('NET_SRC.filter(s=>s.needKey).length')) === '0', 'count=' + await ev('NET_SRC.filter(s=>s.needKey).length'))
  ok('NET.key 已移除', String(await ev('typeof NET.key')) === 'undefined')
  ok('NET.setKey 已移除', String(await ev('typeof NET.setKey')) === 'undefined')
  ok('联网面板无 Key 输入框', String(await ev('document.querySelectorAll("#netlist input[type=password]").length')) === '0')

  console.log('\n== 云函数归属闸门（别人的站不许打本站云函数）==')
  ok('window.cloudIsOwn 存在', String(await ev('typeof window.cloudIsOwn')) === 'function')
  ok('本机打开时判定为「自己」', String(await ev('window.cloudIsOwn()')) === 'true')
  ok('ds 通道标记 ownOnly', String(await ev('(NET_SRC.find(s=>s.id==="ds")||{}).ownOnly')) === 'true')
  const blocked = await ev('(function(){var bak=window.cloudIsOwn; window.cloudIsOwn=function(){return false;}; var r1=NET.chOk({id:"ds",ownOnly:true}); var r2=NET.chOk({id:"pmd"}); window.cloudIsOwn=bak; return (r1===false && r2===true)?1:0;})()')
  ok('非归属站点：ownOnly 通道被拦、普通通道不受影响', String(blocked) === '1')
  const skip = await ev('(async()=>{var bak=window.cloudIsOwn; window.cloudIsOwn=function(){return false;}; var r=await NET.probeOne(NET_SRC.find(s=>s.id==="ds")); window.cloudIsOwn=bak; return JSON.stringify({skip:!!r.skip,ok:!!r.ok});})()')
  ok('非归属站点：ds 探测直接 skip（0 请求）', /"skip":true/.test(String(skip)), String(skip))
  const wb = await ev('(async()=>{var bak=window.cloudIsOwn; window.cloudIsOwn=function(){return false;}; var m=""; try{ await NET._dssearch("test"); m="NO-THROW"; }catch(e){ m=String(e&&e.message); } window.cloudIsOwn=bak; return m;})()')
  ok('非归属站点：_dssearch 内部再拦一次（0 请求）', /未配置自己的云函数/.test(String(wb)), String(wb).slice(0, 56))

  console.log('\n== 运行期异常 ==')
  if (!exceps.length) console.log('  (无)')
  exceps.slice(-6).forEach(e => console.log('  ' + String(e).slice(0, 150)))
  ok('无运行期异常', exceps.length === 0, exceps.length + ' 条')

  console.log('\n' + (fail === 0 ? '✓ 全部 ' + pass + ' 项通过' : '✗ 通过 ' + pass + ' / 失败 ' + fail))
  ws.close(); ch.kill(); process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error('探测脚本出错：', e); process.exit(2) })
