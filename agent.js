/* ==================================================================
   蛇杖二号 · Agent 内核  v2-agent2
   ------------------------------------------------------------------
   干什么：把「检索权」从 ask() 的硬编码直线里拿回来，交给模型。
           模型自己决定查什么、查几轮；查不到允许它说「没找到」。

   边界（写死，不许破）：
     · 不碰加密：调用的都是已解密的顶层函数（sliceSec/headSpan/search…）
     · 不碰 QQ ：qq_feed / qq_digest / 本机 bridge 接口一律不入工具表
     · 不外发教材原文：net_search 只传用户问句，从不带【原文】正文
     · 任何时候挂了都上抛，由 ask() 落回直线 RAG —— 站点不许白屏

   依赖（全部来自 index.html 的顶层作用域，不要在这里重复实现）：
     DOCS  search  sliceSec  headSpan  findChapter  findRelated
     NET   MEM     TOOLS     addMsg    typeInto
   ================================================================== */
(function(){
"use strict";

/* ---------- 0. 刹车参数（改这里，别改循环体） ---------- */
const CFG = {
  MAX_TURNS : 5,        // 轮次上限（主公拍板：上五）
  TOTAL_MS  : 60000,    // 总刹车（毫秒）
  CLIP      : 5000,     // 单工具返回值裁剪（字符）
  CTX_LIMIT : 26000,    // 单轮上下文总量上限（字符）
  READ_MAX  : 5000,     // read_chapter 单章正文上限（字符）
  TODO_MAX  : 30,       // get_todo 最多返回条数
  TODO_CLIP : 260       // get_todo 每条字符上限
};

/* ---------- 1. 工具轨迹的小样式（动态注入，不动 index.html 的 CSS） ---------- */
(function injectCss(){
  if(document.getElementById("sz2-agent-css")) return;
  const s = document.createElement("style");
  s.id = "sz2-agent-css";
  s.textContent = [
    ".msg.tool .bubble{background:rgba(59,130,246,.07);border:1px solid rgba(59,130,246,.22);",
    "color:var(--dim);font-size:12.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word}",
    ".msg.tool .who{color:#3b82f6;font-size:12px}",
    ".msg.tool .bubble b{color:var(--teal);font-weight:600}"
  ].join("");
  document.head.appendChild(s);
})();

/* ---------- 2. 工具 schema（模型靠 description 选工具，别写含糊） ---------- */
const TOOL_SCHEMA = [
  {
    type:"function",
    function:{
      name:"search_library",
      description:"在临床医学教材文库中检索相关章节。返回命中的书名与章节名列表。任何涉及教材内容、知识点、章节的问题都应先调它。参数 q 用中文关键词，可以多次调用、每次换不同的关键词。",
      parameters:{ type:"object", properties:{
        q:{type:"string", description:"检索关键词，中文，2–8 字为宜，例如「休克 分期」「酸碱平衡 判断」"},
        topk:{type:"integer", description:"返回条数，默认 6"}
      }, required:["q"]}
    }
  },
  {
    type:"function",
    function:{
      name:"read_chapter",
      description:"读取命中列表里某一项的正文原文。参数 i 必须是 search_library 或 locate_doc 返回结果里的 i 序号（整数），不要自己编书名。返回的是教材原文，可直接引用并标注。",
      parameters:{ type:"object", properties:{
        i:{type:"integer", description:"命中列表里的序号 i"},
        max:{type:"integer", description:"正文字符上限，默认 5000"}
      }, required:["i"]}
    }
  },
  {
    type:"function",
    function:{
      name:"locate_doc",
      description:"按书名或章节名精确定位。当用户明确说出了书名（如「中医学第10版」「系统解剖学」）或章节名时用它，比 search_library 更直接。",
      parameters:{ type:"object", properties:{
        title:{type:"string", description:"书名或章节标题关键词，例如「生理学」或「细胞的基本功能」"}
      }, required:["title"]}
    }
  },
  {
    type:"function",
    function:{
      name:"read_doc_head",
      description:"读取某册文献的开头部分（目录与绪论）。当只确定书名、不确定内容在哪一章时，用它先看册的开头，再决定读哪章。",
      parameters:{ type:"object", properties:{
        book:{type:"string", description:"书名关键词，例如「病理生理学」"}
      }, required:["book"]}
    }
  },
  {
    type:"function",
    function:{
      name:"net_search",
      description:"联网检索公开网络资料，用于时效性信息（考试范围公告、选课通知、最新指南共识）。只传问题本身，绝不要把教材原文拼进来。返回结果须标〔网n〕。需要用户已在页面开启联网。",
      parameters:{ type:"object", properties:{
        q:{type:"string", description:"检索问句，只写问题本身"}
      }, required:["q"]}
    }
  },
  {
    type:"function",
    function:{
      name:"get_todo",
      description:"读取待办与公告清单（学校官网、图书馆官网的正式通知，共百余条，每条含标题、截止日期、来源、原文链接；不含任何班群消息）。凡是问「有什么通知」「最近有什么待办」「什么时候截止」「XX 报名到几号」「申报/评选/讲座/考试/奖学金/实习怎么安排」这类事务性、带时间点的问题，第一优先调用它。不传 kw 就返回全部（有截止日的排在最前）。",
      parameters:{ type:"object", properties:{
        kw:{type:"string", description:"可选。关键词过滤，如「奖学金」「四六级」「申报」「图书馆」。留空则返回全部。"},
        topk:{type:"integer", description:"返回条数，默认 20，上限 30"}
      }}
    }
  },
  {
    type:"function",
    function:{
      name:"read_attach",
      description:"读取用户本轮上传的附件内容（PDF/DOCX/图片/文本转换后的文字）。当用户说「看我上传的」「根据我发的资料」时用它。",
      parameters:{ type:"object", properties:{}}
    }
  },
  {
    type:"function",
    function:{
      name:"remember",
      description:"把值得长期记住的用户信息写入长期记忆（存在本机浏览器，不外发）。只记用户本人的长期信息：年级专业、学习进度、薄弱科目、偏好、目标。不要记教材知识点，不要记联网新闻。",
      parameters:{ type:"object", properties:{
        text:{type:"string", description:"要记住的一句话，不超过 40 字"}
      }, required:["text"]}
    }
  }
];

/* ---------- 3. 追加进 system prompt 的工具规范（模型的行为准则） ---------- */
const TOOLS_PROMPT = [
"",
"【工具使用规范 · 蛇杖二号】",
"",
"你现在是一个会自己找资料的助手。下面这些工具，你可以自由调用，最多 5 轮。",
"",
"什么时候该调：",
"  1）问题涉及教材原文、知识点、章节内容 —— 先 search_library 找，再 read_chapter 取正文，不要凭记忆直接答。",
"  2）问题里出现了具体书名（如「中医学第10版」「系统解剖学」）—— 用 locate_doc 定位到具体章节。",
"  3）只知道书名、不知道在第几章 —— 用 read_doc_head 看册的开头（目录/绪论），再决定读哪章。",
"  4）问到通知、待办、截止日期、报名/申报/评选/讲座/考试时间这类事务性内容 —— 第一优先调 get_todo，",
"     它给的是学校官网清单，带截止日和原文链接；get_todo 没命中再考虑 net_search。",
"     典型触发：「最近有什么通知」「有什么待办」「XX 什么时候截止」「XX 报名到几号」「申报开始了没」。",
"  5）用户提到了自己上传的附件 —— 用 read_attach。",
"  6）第一轮检索结果不够、或明显跑偏 —— 换关键词再查一轮，别急着答。",
"",
"怎么引用：",
"  · read_chapter 返回的原文编号〔n〕，net_search 返回的编号〔网n〕，get_todo 返回的编号〔待办n〕。",
"  · 你引用的每一处，都必须真的来自工具返回的内容。工具没返回的，不许编。",
"  · read_chapter 的参数 i 只能用工具返回给你的序号，不要自己编造。",
"  · 说到某条待办时，必须带上它的截止日期（ddl 字段），有原文链接就把链接给用户。",
"",
"查不到怎么办：",
"  · 工具返回为空或明显不相关时，如实说「我查了 XX，没找到」，然后凭准确的医学基础知识作答，",
"    并说明这部分没有教材原文支撑。绝不伪造出处、绝不编造数据、绝不假称查过某本书。",
"",
"什么时候别调：",
"  · 纯聊天、寒暄、问你是谁 —— 直接答。",
"  · 问题与文库、学业、时效信息都无关 —— 直接答。",
"",
"节奏要求：",
"  · 最多 5 轮。通常 1–2 轮就该有结论；到第 3 轮还没找到，就按「查不到」处理，别死磕。",
"  · 同一轮不要重复调同一个工具同一个参数。",
"  · read_chapter 一次不要超过 3 项，挑最相关的读。",
""
].join("\n");

/* ==================================================================
   4. 内部状态：命中表 HITS
      —— 模型只认整数序号 i，不抄书名，避免中文书名传参出错
   ================================================================== */
let HITS = [];        // [{d, i, ti}]，i=-1 表示只命中了册
let _n = 0;

/* —— 用量账本：主公问「每次大概多少 token」，这里记账 ——
   prompt / completion 取模型返回的 usage 累加；没有 usage 时用字数粗估，
   粗估值单独放 est 字段，不与真实值混在一起。 */
const _blankUsage = () => ({
  rounds:0, llmCalls:0, toolCalls:0, toolChars:0,
  prompt:0, completion:0, cached:0,
  hasUsage:false, est:0
});
let USAGE = _blankUsage();
function _accUsage(u){
  if(!u) return;
  USAGE.hasUsage = true;
  USAGE.prompt     += Number(u.prompt_tokens     || 0);
  USAGE.completion += Number(u.completion_tokens || 0);
  USAGE.cached     += Number(u.prompt_cache_hit_tokens || 0);
}

function pushHit(d, i, ti){
  HITS.push({d, i, ti});
  return HITS.length;              // 返回 1-based 序号
}
function getHit(i){
  const n = Number(i);
  if(!Number.isInteger(n) || n < 1 || n > HITS.length) return null;
  return HITS[n-1];
}
/* 按书名关键词找册（模糊匹配，模型给的往往是书名片段） */
function findBook(kw){
  if(!kw) return null;
  const k = String(kw).trim();
  if(!Array.isArray(DOCS) || !DOCS.length) return null;
  const norm = s => String(s||"").replace(/[\s（）()《》·\-—_]/g,"").toLowerCase();
  const nk = norm(k);
  // ① 完全相等 / 归一化相等
  for(const d of DOCS){
    if(d.t === k || norm(d.t) === nk) return d;
  }
  // ② 书名包含关键词（短的优先，偏精准）
  let best = null, bestLen = 1e9;
  for(const d of DOCS){
    const nt = norm(d.t);
    if(nt.includes(nk) || nk.includes(nt)){
      if(nt.length < bestLen){ best = d; bestLen = nt.length; }
    }
  }
  if(best) return best;
  // ③ 路径包含
  for(const d of DOCS){
    if(String(d.f||"").toLowerCase().includes(k.toLowerCase())) return d;
  }
  return null;
}

/* ==================================================================
   5. 隐私闸门：过滤可能混进来的班群字段
      —— 红线的技术兜底，不是靠自觉
   ================================================================== */
const QQ_PAT = /qq|群消息|群号|qq群|digest|班群|openid|CQ:|\[CQ/ig;
function guard(obj){
  try{
    let s = typeof obj === "string" ? obj : JSON.stringify(obj);
    if(!s) return String(obj == null ? "" : obj);
    if(QQ_PAT.test(s)){
      /* 命中红线字段：整条丢弃，只留一句说明（不把原内容吐出去） */
      return "[已拦截：该内容含班群相关字段，按隐私红线不予返回]";
    }
    QQ_PAT.lastIndex = 0;
    return s;
  }catch(e){ return "[内容序列化失败]"; }
}
const clip = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n) + "\n…（已截断，原长 " + t.length + " 字）" : t;
};

/* ==================================================================
   6. HANDLERS —— 8 个工具的本地实现
      全部转调 index.html 现成函数；不重复实现解密与三级降级
   ================================================================== */
const HANDLERS = {

  async search_library(a){
    const q = String(a && a.q || "").trim();
    if(!q) return {ok:false, msg:"缺少关键词 q"};
    const topk = Math.min(Math.max(parseInt(a && a.topk, 10) || 6, 1), 12);
    const out = [];
    try{
      const hits = search(q, topk) || [];
      for(const h of hits){
        const idx = pushHit(h.d, h.i, h.i >= 0 ? h.ti : "（本册正文相关，需册内定位）");
        out.push({ i: idx, book: h.d.t, chapter: h.i >= 0 ? String(h.ti).trim() : "（整册命中）" });
      }
    }catch(e){ return {ok:false, msg:"检索失败：" + e.message}; }
    if(!out.length) return {ok:true, count:0, msg:"文库中未检索到相关章节，可换更短的关键词再试。", hits:[]};
    return {ok:true, count:out.length, hits:out,
            tip:"用 read_chapter 并传入 i 序号读取对应正文"};
  },

  async read_chapter(a){
    const h = getHit(a && a.i);
    if(!h) return {ok:false, msg:"序号 i 无效。请先用 search_library 或 locate_doc 拿到 i。"};
    const max = Math.min(Math.max(parseInt(a && a.max, 10) || CFG.READ_MAX, 500), 12000);
    try{
      if(h.i >= 0){
        const body = await sliceSec(h.d, h.i, Math.round(max * 2.5));  // sliceSec 吃字节数，汉字约 3 字节/字
        if(!body || !body.trim()) return {ok:false, msg:"该章节正文为空"};
        return {ok:true, n:Number(a.i), src:h.d.t + " · " + String(h.ti).trim(),
                text:clip(body, max)};
      }
      /* 只命中了册、没定位到章：取开头做册内段落定位 */
      const span = await headSpan(h.d);
      const rel  = span ? findRelated(span, "", 3) : [];
      if(!rel.length) return {ok:false, msg:"册内未定位到相关段落"};
      return {ok:true, n:Number(a.i), src:h.d.t + "（册内定位）",
              text:clip(rel.join("\n\n"), max)};
    }catch(e){ return {ok:false, msg:"取文失败：" + e.message}; }
  },

  async locate_doc(a){
    const title = String(a && a.title || "").trim();
    if(!title) return {ok:false, msg:"缺少 title"};
    try{
      const ch = findChapter(title);
      if(ch){
        const idx = pushHit(ch.d, ch.i, ch.ti);
        return {ok:true, count:1, hits:[{i:idx, book:ch.d.t, chapter:String(ch.ti).trim()}],
                tip:"用 read_chapter 并传入 i 序号读取正文"};
      }
    }catch(e){}
    /* findChapter 找不到章节号时，退而 lv.2：定位到册本身 */
    const d = findBook(title);
    if(d){
      const idx = pushHit(d, -1, "（整册）");
      return {ok:true, count:1,
              hits:[{i:idx, book:d.t, chapter:"（已定位到册，可用 read_chapter 做册内定位）"}],
              chapters:(d.s||[]).slice(0, 40).map(x=>String(x[0]).trim()),
              tip:"上面是该册前若干章节名；想读某章可用 locate_doc 传章节名精确定位"};
    }
    return {ok:true, count:0, msg:"文库中没有这本书，也没有匹配的章节。换更短的书名关键词试试。", hits:[]};
  },

  async read_doc_head(a){
    const kw = String(a && a.book || "").trim();
    const d = kw ? findBook(kw) : null;
    if(!d) return {ok:false, msg:"没找到这本册：" + kw + "。用 search_library 先搜一下。"};
    try{
      const span = await headSpan(d);
      if(!span) return {ok:false, msg:"取不到该册开头"};
      const idx = pushHit(d, -1, "（整册）");
      return {ok:true, i:idx, book:d.t,
              chapters:(d.s||[]).slice(0, 50).map(x=>String(x[0]).trim()),
              head:clip(span, 3000),
              tip:"上面是该册章节列表与开头正文；确定章节后可用 locate_doc 精确定位，或用 read_chapter 读 i=" + idx + " 做册内定位"};
    }catch(e){ return {ok:false, msg:"取文失败：" + e.message}; }
  },

  async net_search(a){
    const q = String(a && a.q || "").trim();
    if(!q) return {ok:false, msg:"缺少检索问句 q"};
    if(typeof NET === "undefined" || !NET || !NET.on)
      return {ok:false, msg:"用户未开启联网参考（页面「🌐 联网」开关关闭），无法联网检索。请基于文库原文作答。"};
    try{
      /* 隐私：只传问句，绝不传任何【原文】正文 */
      const r = await Promise.race([
        NET.gather(q),
        new Promise(res=>setTimeout(()=>res({txt:"", list:[], note:"联网超时"}), 6000))
      ]);
      if(!r || !r.list || !r.list.length)
        return {ok:false, msg:"联网未取到内容。" + ((r && r.note) || "可能通道不可达或未配置搜索 Key。")};
      return {ok:true, count:r.list.length,
              items:r.list.map((x,n)=>({n:n+1, src:x.src, title:x.t})),
              text:clip(r.txt, 3600),
              tip:"引用时标〔网n〕，序号与上面 items 的 n 对应"};
    }catch(e){ return {ok:false, msg:"联网失败：" + e.message}; }
  },

  async get_todo(a){
    try{
      const r = await fetch("data/todo.json?t=" + Date.now(), {cache:"no-store"});
      if(!r.ok) return {ok:false, msg:"待办读取失败 HTTP " + r.status +
        "（确认 data/todo.json 已随站点放上去）"};
      const j = await r.json();
      /* 隐私双保险：这份 json 若哪天 include_qq 变 true，直接拒绝返回 */
      if(j && j.include_qq)
        return {ok:false, msg:"该数据源含班群内容，按隐私红线不予读取。"};
      let items = (j && j.items) || [];
      const kw = String((a && a.kw) || "").trim();
      if(kw){
        /* 空格 / 逗号分词，任一词命中即可；同时比标题、来源、打标理由 */
        const toks = kw.split(/[\s,，、]+/).filter(Boolean);
        items = items.filter(x=>{
          const s = String(x.title||"") + String(x.src||"") + String(x.reason||"");
          return toks.some(t=>s.includes(t));
        });
      }
      /* 有截止日的排前面并按日期升序 —— 问「什么时候截止」时最关心的就是这些 */
      items = items.slice().sort((p,q)=>{
        const pd = String(p.ddl||""), qd = String(q.ddl||"");
        if(pd && qd) return pd < qd ? -1 : (pd > qd ? 1 : 0);
        if(pd) return -1;
        if(qd) return 1;
        return 0;
      });
      const total = items.length;
      const topk = Math.min(Math.max(parseInt(a && a.topk, 10) || 20, 1), CFG.TODO_MAX);
      items = items.slice(0, topk);
      const out = items.map((x,n)=>({
        n:n+1,
        level:x.level || "",
        title:clip(x.title || "", CFG.TODO_CLIP),
        ddl:x.ddl || "",
        src:x.src || "",
        url:x.url || ""
      }));
      const s = JSON.stringify(out);
      if(/qq|班群|群消息/i.test(s))
        return {ok:false, msg:"返回内容触发隐私闸门，已拦截。"};
      if(!out.length)
        return {ok:true, count:0, matched:0,
                msg: kw ? ("没有命中「" + kw + "」的待办。可以不带 kw 再取一次看全部，或换个更短的词。")
                        : "待办清单为空。"};
      return {ok:true, count:out.length, matched:total, items:out,
              updated:(j && j.updated_at) || "",
              tip:"这是学校/图书馆官网的公开公告与待办清单，共命中 " + total +
                  " 条，上面返回前 " + out.length + " 条（有截止日的排最前）。引用时标〔待办n〕；" +
                  "需要给用户原文出处就用 url 字段。含班群消息的数据源不在此列，也拿不到。"};
    }catch(e){ return {ok:false, msg:"待办读取失败：" + e.message}; }
  },

  async read_attach(a){
    try{
      const atts = (typeof TOOLS !== "undefined" && TOOLS && TOOLS.atts) ? TOOLS.atts : [];
      if(!atts.length) return {ok:false, msg:"本轮没有上传附件。"};
      const out = atts.map((x,n)=>({
        n:n+1,
        name:x.name || "（未命名）",
        kind:x.kind,
        text:x.kind === "image" ? "（图片，已随消息送入，请直接看图）"
                                : clip(x.text || "", 4000)
      }));
      return {ok:true, count:out.length, items:out, tip:"引用附件内容时标〔附件n〕"};
    }catch(e){ return {ok:false, msg:"附件读取失败：" + e.message}; }
  },

  async remember(a){
    const t = String((a && a.text) || "").trim();
    if(t.length < 4) return {ok:false, msg:"内容太短，不记。"};
    if(t.length > 60) return {ok:false, msg:"超过 60 字，请压缩后再记。"};
    /* 隐私：不记疑似群消息/他人信息的内容 */
    if(/qq|班群|群消息|同学|学号/i.test(t))
      return {ok:false, msg:"疑似含群消息或他人信息，按隐私红线不予记忆。"};
    try{
      if(typeof MEM === "undefined" || !MEM || typeof MEM.add !== "function")
        return {ok:false, msg:"记忆模块不可用。"};
      MEM.add(t.slice(0, 40));
      return {ok:true, msg:"已记住：" + t};
    }catch(e){ return {ok:false, msg:"记忆写入失败：" + e.message}; }
  }
};

/* 工具名 → 界面上显示的中文（轨迹用） */
const TOOL_CN = {
  search_library:"检索文库", read_chapter:"读取章节", locate_doc:"定位书目",
  read_doc_head:"读取册开头", net_search:"联网检索", get_todo:"读取待办公告",
  read_attach:"读取附件", remember:"写入记忆"
};

/* ==================================================================
   7. 一次 completion（非流式：工具轮）/ 一轮（流式：最终回答）
      —— 统一在这里处理各种端点的怪脾气
   ================================================================== */
function bodyBase(mdl, think){
  const b = {model:mdl, temperature:0.7};
  /* DeepSeek 的推理开关：有 thinking 字段就带上，没有就不带（兼容 OpenAI 系） */
  try{
    b.thinking = think ? {type:"enabled"} : {type:"disabled"};
    if(think) b.reasoning_effort = "high";
  }catch(e){}
  return b;
}
function httpPost(base, key, payload){
  return fetch(String(base).replace(/\/$/,"") + "/chat/completions", {
    method:"POST",
    headers:{"Content-Type":"application/json", "Authorization":"Bearer " + key},
    body: JSON.stringify(payload)
  });
}

/* 带 usage 的 POST：先试 stream_options（能换来真实 token 数）。
   端点不认这个字段会回 400，此时原样退回重发一次，不影响主流程。 */
async function httpPostUsage(base, key, basePayload){
  let r = await httpPost(base, key, Object.assign({stream_options:{include_usage:true}}, basePayload));
  if(r.ok) return r;
  const t = await r.text().catch(()=> "");
  if(r.status === 400 && /stream_options|include_usage/i.test(t)){
    return httpPost(base, key, basePayload);      /* 退一档再来 */
  }
  /* 真失败：把已读出的错误正文包回去，让上层照常抛错 */
  return { ok:false, status:r.status, body:null, text: async ()=>t };
}

/* 流式一轮：累积 content / reasoning_content / tool_calls（SSE 里 tool_calls 是增量片段，必须按 index 拼） */
async function streamOnce(opt, msgs, onDelta){
  const payload = Object.assign(bodyBase(opt.mdl, opt.think), {
    messages: msgs,
    stream: true,
    tools: TOOL_SCHEMA,
    tool_choice: "auto"
  });
  const r = await httpPostUsage(opt.cfg.base, opt.cfg.key, payload);
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error("HTTP " + r.status + " " + t.slice(0, 200));
  }
  const rd = r.body.getReader(), dec = new TextDecoder();
  let content = "", reasoning = "", lastU = null;
  const tcMap = {};                    // index -> 增量拼装槽
  let sawTool = false;
  USAGE.llmCalls++;

  while(true){
    const {done, value} = await rd.read();
    if(done) break;
    for(const line of dec.decode(value, {stream:true}).split("\n")){
      if(!line.startsWith("data:")) continue;
      const js = line.slice(5).trim();
      if(!js || js === "[DONE]") continue;
      let d;
      try{ d = JSON.parse(js); }catch(e){ continue; }
      if(d.usage) lastU = d.usage;      /* usage 只在最后一个 chunk 里来，取最后一次即可 */
      const ch = d.choices && d.choices[0];
      if(!ch) continue;
      const dl = ch.delta || {};
      if(dl.reasoning_content){ reasoning += dl.reasoning_content; if(onDelta) onDelta(null, dl.reasoning_content, true); }
      if(dl.content){ content += dl.content; if(onDelta) onDelta(dl.content, null, false); }
      if(Array.isArray(dl.tool_calls) && dl.tool_calls.length){
        sawTool = true;
        for(const t of dl.tool_calls){
          const k = (t.index == null) ? 0 : t.index;
          if(!tcMap[k]) tcMap[k] = {id:"", type:"function", function:{name:"", arguments:""}};
          if(t.id) tcMap[k].id = t.id;
          if(t.function && t.function.name)     tcMap[k].function.name      += t.function.name;
          if(t.function && t.function.arguments) tcMap[k].function.arguments += t.function.arguments;
        }
      }
    }
  }
  let tool_calls = null;
  if(sawTool){
    tool_calls = Object.keys(tcMap).sort((a,b)=>a-b).map(k=>{
      const c = tcMap[k];
      return { id: c.id || ("call_" + k + "_" + Date.now().toString(36)),
               type:"function",
               function:{ name:c.function.name, arguments:c.function.arguments } };
    }).filter(x=>x.function.name);
  }
  /* content 去掉装饰符（与直线流程保持一致的输出洁癖） */
  content = String(content).replace(/[✳◆▍#]+/g, "");
  _accUsage(lastU);
  USAGE.est += Math.ceil((content.length + String(reasoning).length) / 1.6);
  return { role:"assistant", content: content || null,
           ...(reasoning ? {reasoning_content: reasoning} : {}),
           ...(tool_calls && tool_calls.length ? {tool_calls} : {}) };
}

/* 收尾一轮：不带 tools，强制模型输出文本（用于轮次/时间耗尽时的兜底） */
async function finishOnce(opt, msgs, onDelta){
  const payload = Object.assign(bodyBase(opt.mdl, opt.think), {
    messages: msgs,
    stream: true
    /* 故意不传 tools —— 让它没得选，只能给文本 */
  });
  const r = await httpPostUsage(opt.cfg.base, opt.cfg.key, payload);
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error("HTTP " + r.status + " " + t.slice(0, 160));
  }
  const rd = r.body.getReader(), dec = new TextDecoder();
  let content = "", reasoning = "", lastU = null;
  USAGE.llmCalls++;
  while(true){
    const {done, value} = await rd.read();
    if(done) break;
    for(const line of dec.decode(value, {stream:true}).split("\n")){
      if(!line.startsWith("data:")) continue;
      const js = line.slice(5).trim();
      if(!js || js === "[DONE]") continue;
      let d; try{ d = JSON.parse(js); }catch(e){ continue; }
      if(d.usage) lastU = d.usage;
      const dl = (d.choices && d.choices[0] && d.choices[0].delta) || {};
      if(dl.reasoning_content){ reasoning += dl.reasoning_content; if(onDelta) onDelta(null, dl.reasoning_content); }
      if(dl.content){ content += dl.content; if(onDelta) onDelta(dl.content, null); }
    }
  }
  _accUsage(lastU);
  USAGE.est += Math.ceil((String(content).length + String(reasoning).length) / 1.6);
  return String(content).replace(/[✳◆▍#]+/g, "");
}

/* ---- 输出清洗：堵住 DeepSeek 的 DSL 泄漏 -------------------------
   现象：当模型想调工具但手上没有工具表（例如 finishOnce 的强制收尾回合，
   或多个并行 tool_calls 没全部回灌），它会把内部的 DSML 调用文本原样吐出来，
   形如 <｜｜DSML｜｜ invoke name="search_library">。这种内容不能给用户看。
   处理：识别到 DSML / 全角竖线标记就尝试剥离，剥完没剩多少干货就判定本轮无效，
        由 ask() 降级走直线 RAG。 */
function sanitizeFinal(s){
  let t = String(s == null ? "" : s);
  if(!t) return "";
  const hasDsl = /DSML/i.test(t) || /\uFF5C{2}/.test(t);
  if(!hasDsl) return t;
  t = t.replace(/<[^>]*DSML[^>]*>/gi, "")
       .replace(/<[\uFF5C|][^>]*>/g, "")
       .replace(/[\uFF5C|]{2,}[^\n]{0,160}/g, "")
       .replace(/\n{3,}/g, "\n\n")
       .trim();
  /* 剥离后没有实质内容 → 本轮作废，返回空串让上层降级 */
  return t.length >= 20 ? t : "";
}

/* ==================================================================
   8. 轨迹渲染 —— 一个气泡走天下，且必须排在答案气泡【之前】
      ------------------------------------------------------------------
      主公要求：工具调用不要写在回答下面，要像「深度思考」/ WorkBuddy 那样，
      先看它在干什么，再看它答什么。
      addMsg() 是往聊天区尾部 append，而答案气泡 b 已经先建好了，
      所以纯 append 必然落在答案下面。这里补一步「上提」：
      每次刷新都把轨迹行 insertBefore 到答案气泡所在行之前。
      _anchor 就是 index.html 传进来的 bub（答案气泡）。
   ================================================================== */
let _tb = null, _tbRow = null, _tbLines = [], _anchor = null;
const _hEsc = s => String(s == null ? "" : s)
  .replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));

function traceReset(anchor){
  _tb = null; _tbRow = null; _tbLines = [];
  _anchor = anchor || null;
}

/* 重新画一遍（也要写回 _rec.html，否则切会话重绘会丢） */
function _paintTrace(){
  if(!_tb) return;
  const html = _tbLines.map(_hEsc).join("<br>");
  _tb.innerHTML = html;
  if(_tb._rec) _tb._rec.html = html;
}
/* 上提到答案之前 */
function _hoist(){
  try{
    const chat = document.getElementById("chat");
    const aRow = _anchor && _anchor.parentElement;
    if(chat && _tbRow && aRow && _tbRow.parentElement === chat
       && _tbRow.nextElementSibling !== aRow){
      chat.insertBefore(_tbRow, aRow);
    }
  }catch(e){ /* 挪不动就算了，不影响答案 */ }
}

function trace(name, args, res){
  try{
    if(typeof addMsg !== "function") return;
    const cn = TOOL_CN[name] || name;
    const argTxt = (args && Object.keys(args).length)
      ? Object.keys(args).map(k => k + "=" + clip(args[k], 24)).join(", ") : "";
    const brief = (()=>{
      const r = res || {};
      if(r.ok === false) return "　→ 失败：" + String(r.msg || "").slice(0, 90);
      if(Array.isArray(r.hits) && r.hits.length)
        return "　→ 命中 " + r.hits.length + " 项：" + r.hits.slice(0,3)
                 .map(h => "[" + h.i + "] " + clip(h.book,16) + (h.chapter ? " · " + clip(h.chapter,20) : "")).join("；");
      if(Array.isArray(r.items) && r.items.length)
        return "　→ 返回 " + r.items.length + " 条" +
               (r.items[0] && r.items[0].title ? "：" + clip(r.items[0].title, 26) : "");
      if(r.text) return "　→ 取回正文约 " + String(r.text).length + " 字";
      if(r.msg)  return "　→ " + String(r.msg).slice(0, 90);
      return "　→ ok";
    })();
    _tbLines.push("🔧 " + cn + (argTxt ? "（" + argTxt + "）" : ""), brief);

    if(!_tb){
      _tb = addMsg("🔧 工具调用", "", "tool");
      _tbRow = _tb && _tb.parentElement;
      /* 也做成可折叠，跟深度思考一个用法 */
      try{
        const w = _tbRow && _tbRow.querySelector(".who");
        if(w){ w.style.cursor = "pointer";
               w.title = "点击折叠 / 展开";
               w.onclick = ()=>{ const bub = _tbRow.querySelector(".bubble");
                                 bub.style.display = bub.style.display === "none" ? "block" : "none"; }; }
      }catch(e){}
    }
    _paintTrace();
    _hoist();
    const c = document.getElementById("chat"); if(c) c.scrollTop = c.scrollHeight;
  }catch(e){ /* 轨迹渲染失败不影响主流程 */ }
}

/* 收尾：写上「共几轮 / 几次工具 / 多少 tokens」，并把标题标成已结束 */
function traceFinish(summary){
  try{
    if(!_tb || !_tbLines.length) return;
    if(summary) _tbLines.push("", summary);
    _paintTrace();
    try{
      const w = _tbRow && _tbRow.querySelector(".who");
      if(w) w.textContent = "🔧 工具调用（已结束，点击折叠）";
    }catch(e){}
    _hoist();
  }catch(e){}
}

/* 上下文裁剪：只砍最老的 tool 消息，保住 system 与用户提问 */
function trimCtx(msgs, limit){
  let size = 0;
  for(const m of msgs) size += String(m.content || "").length;
  if(size <= limit) return;
  for(let k = 0; k < msgs.length && size > limit; k++){
    const m = msgs[k];
    if(!m || m.role !== "tool") continue;
    const before = String(m.content || "").length;
    if(before > 400){
      m.content = String(m.content).slice(0, 400) + "\n…（此前的工具返回已裁剪以控制上下文）";
      size -= (before - m.content.length);
    }
  }
}

/* ==================================================================
   9. runLoop —— 主循环（双刹车：轮次 + 总时长）
   ================================================================== */
async function runLoop(opt){
  if(!opt || !opt.cfg || !opt.cfg.key) throw new Error("runLoop: 缺少端点配置");

  HITS = [];
  USAGE = _blankUsage();               // 每次新问重置账本
  traceReset(opt.bub);                 // 轨迹气泡锚在答案气泡之前（主公要求：先见过程，再见答案）

  const sys  = String(opt.sysBase || "") + TOOLS_PROMPT
             + (MODE_PROMPT && MODE_PROMPT[opt.mode] ? "\n\n" + MODE_PROMPT[opt.mode] : "");
  const user = [ opt.memTxt || "",
                 opt.fileTxt ? "【附件内容】\n" + opt.fileTxt + "\n\n" : "",
                 opt.netTxt  || "",
                 "【我的问题】\n" + opt.q ].join("");

  const msgs = [
    { role:"system", content: sys },
    { role:"user",   content: user }
  ];

  let turn = 0, final = "";
  let _shown = "", _rsn = "";            /* 界面累积缓冲（跨轮连续打字，不清屏） */
  const t0 = Date.now();
  let repeatGuard = {name:"", n:0};

  while(turn++ < CFG.MAX_TURNS){
    if(Date.now() - t0 > CFG.TOTAL_MS){
      trace("_timeout", {}, {ok:false, msg:"已到总时长上限，转入作答"});
      break;
    }
    if(!final && turn > 1 && msgs.length && msgs[msgs.length-1].role === "tool"){
      /* 已经在 tool 回合但还没结论：轻推一下，避免它无限查下去 */
      msgs.push({role:"user", content:"资料已经够了，请现在作答。"});
    }

    const msg = await streamOnce(opt, msgs, (txt, rsn)=>{
      /* 文本往主气泡打，思考过程往「深度思考」气泡打（与直线流程观感一致） */
      if(txt){ _shown += txt; try{ if(opt.bub) typeInto(opt.bub, _shown); }catch(e){} }
      if(rsn){ _rsn += rsn; try{ if(opt.thinkBub) typeInto(opt.thinkBub, _rsn.replace(/[✳◆▍#]+/g,"")); }catch(e){} }
    });

    /* ⚠️ DeepSeek 思考模式 + tool_calls：reasoning_content 必须原样回灌，否则下一轮 400 */
    if(msg.reasoning_content){
      msgs.push({ role:"assistant", content: msg.content || null,
                  reasoning_content: msg.reasoning_content,
                  tool_calls: msg.tool_calls || null });
    } else {
      msgs.push({ role:"assistant", content: msg.content || null,
                  tool_calls: msg.tool_calls || null });
    }

    if(!msg.tool_calls || !msg.tool_calls.length){
      final = String(msg.content || "");
      break;
    }

    for(const call of msg.tool_calls){
      const fn = call.function && call.function.name;
      let args = {};
      try{ args = JSON.parse((call.function && call.function.arguments) || "{}"); }catch(e){ args = {}; }

      /* 防模型在同一工具上打转 */
      if(repeatGuard.name === fn && args && Object.keys(args).length){
        repeatGuard.n++;
        if(repeatGuard.n >= 3){
          trace(fn, args, {ok:false, msg:"同一工具连续命中已达上限，转入作答"});
          msgs.push({role:"tool", tool_call_id:call.id, name:fn,
                     content:"该工具你已连续调用多次，资料已足够，请立刻依据已获内容作答。"});
          continue;
        }
      } else { repeatGuard = {name:fn, n:1}; }

      let res;
      try{
        const h = HANDLERS[fn];
        res = h ? await h(args) : {ok:false, msg:"没有这个工具：" + fn};
      }catch(e){ res = {ok:false, msg:"执行异常：" + (e && e.message || e)}; }

      trace(fn, args, res);
      USAGE.toolCalls++;
      const _c = clip(guard(res), CFG.CLIP);
      USAGE.toolChars += String(_c).length;
      msgs.push({ role:"tool", tool_call_id:call.id, name:fn, content: _c });
    }
    USAGE.rounds = turn;
    trimCtx(msgs, CFG.CTX_LIMIT);
  }

  if(!final){
    /* 轮次或时间用尽仍没给文本：卸掉工具表再问一次，逼它必须输出结论 */
    msgs.push({role:"user", content:"已到检索上限，请立即依据上面已经拿到的内容作答，不要再调用任何工具。"});
    try{
      final = await finishOnce(opt, msgs, (txt, rsn)=>{
        if(txt){ _shown += txt; try{ if(opt.bub) typeInto(opt.bub, _shown); }catch(e){} }
        if(rsn){ _rsn += rsn; try{ if(opt.thinkBub) typeInto(opt.thinkBub, _rsn.replace(/[✳◆▍#]+/g,"")); }catch(e){} }
      });
    }catch(e){ final = ""; }
  }

  final = sanitizeFinal(final);

  /* 收尾：把「几轮 / 几次工具 / 命中多少 / 多少 token」写在轨迹气泡末尾，主公开销一眼可见 */
  traceFinish((function(){
    const u = USAGE;
    const tk = u.hasUsage
      ? "tokens 入 " + u.prompt + " / 出 " + u.completion +
        (u.cached ? "（缓存命中 " + u.cached + "）" : "")
      : "tokens 约 " + u.est + "（粗估，接口未回 usage）";
    return "—— 共 " + u.rounds + " 轮 · " + u.toolCalls + " 次工具 · 命中 " +
           HITS.length + " 项 · " + tk;
  })());

  if(!final){
    /* 仍然没拿到能看的文本 → 交还控制权，由 ask() 走原直线 RAG 兜底 */
    return "";
  }
  return final;
}

/* ==================================================================
   10. selfTest —— 不动 Key、不联网也能跑的部分：逐个验证 Handler 是否可调用
       （需要真实模型的那部分只能浏览器里问一句，这里能验代码的连通性）
   ================================================================== */
async function selfTest(){
  const out = [];
  const chk = async (name, args)=>{
    try{
      const h = HANDLERS[name];
      if(!h) return {name, ok:false, note:"未实现"};
      const r = await h(args);
      const s = JSON.stringify(r);
      return {name, ok: r && r.ok !== false, note: clip(s, 220)};
    }catch(e){ return {name, ok:false, note:"异常：" + (e && e.message || e)}; }
  };
  out.push(await chk("search_library", {q:"休克", topk:3}));
  out.push(await chk("locate_doc",     {title:"生理学"}));
  const c0 = HITS.length ? await chk("read_chapter", {i:HITS.length, max:600}) : {name:"read_chapter", ok:false, note:"前置命中为空，跳过"};
  out.push(c0);
  out.push(await chk("net_search",     {q:"test"}));
  out.push(await chk("get_todo",       {}));
  out.push(await chk("read_attach",    {}));
  out.push(await chk("remember",       {text:"自检临时记忆，可删"}));
  return {turns:CFG.MAX_TURNS, tools:TOOL_SCHEMA.length, results:out};
}

/* ---------- 11. 导出 ---------- */
window.AGENT = {
  v:"v2-agent2",        // ① 轨迹前置显示 ② token 记账 ③ get_todo 加强
  runLoop,
  selfTest,
  CFG,
  HANDLERS,
  TOOL_SCHEMA,
  TOOLS_PROMPT,
  failed:false,                     /* 一旦崩过就置 true，由 ask() 降级用 */
  setBusy(v){ try{ busy = !!v; }catch(e){} },   /* busy 是 index.html 的顶层 let，只能从这边改 */
  usage(){ return Object.assign({}, USAGE); },  /* 本轮用量：轮次 / 工具次数 / token */
  _state(){ return {hits:HITS.length, failed:window.AGENT.failed, usage:USAGE}; }
};

})();
