/* Jula IT 知识库 AI 助理 —— 本地检索 (RAG) + 可选 LLM 增强 */
(function () {
  "use strict";

  var KB = window.KB || { meta: {}, articles: [] };
  // 合并 Confluence ITSM 知识库（由 sync_confluence.py 生成）
  var KB_CONFLUENCE = window.KB_CONFLUENCE || { meta: {}, articles: [] };
  KB.articles = (KB.articles || []).concat(KB_CONFLUENCE.articles || []);
  // id -> 文章 映射，供本地文档打开/下载时按 id 取内容
  var byId = {};
  KB.articles.forEach(function (a) { byId[a.id] = a; });
  var SUGGESTIONS = [
    "OneDrive 同步失败显示红叉怎么办？",
    "怎么登录 OneDrive？",
    "OneDrive 和 SharePoint 有什么区别？",
    "Outlook 邮件发不出去卡在发件箱？",
    "收不到新邮件怎么排查？",
    "怎么预订上海会议室？",
    "如何导出 .pst 备份？",
    "MFA 手机短信怎么注册？",
    "怎么连 Cisco AnyConnect VPN？",
    "怎么提交 IT 工单？",
  ];

  // ---------- DOM ----------
  var chat = document.getElementById("chat");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("send");
  var typing = document.getElementById("typing");
  var chips = document.getElementById("chips");
  var attachBtn = document.getElementById("attach");
  var fileInput = document.getElementById("file");
  var previews = document.getElementById("previews");
  var attachments = []; // {type:'image', name, dataUrl} | {type:'text', name, text}

  // 多轮对话历史（仅本页会话，刷新即清空），用于让模型结合上下文理解追问
  var history = [];
  function trimHistory() { if (history.length > 12) history = history.slice(history.length - 12); }

  // ---------- helpers ----------
  function norm(s) {
    return (s || "").toLowerCase().replace(/\s+/g, "");
  }
  function isCJK(ch) {
    return /[一-龥]/.test(ch);
  }
  function bigrams(s) {
    // 仅取中文相邻字成词，避免英文片段/单字噪声导致误命中
    s = norm(s);
    var set = {};
    for (var i = 0; i < s.length - 1; i++) {
      var a = s.charAt(i), b = s.charAt(i + 1);
      if (isCJK(a) && isCJK(b)) set[a + b] = 1;
    }
    return set;
  }
  function overlap(a, b) {
    var keys = Object.keys(a), n = 0;
    for (var i = 0; i < keys.length; i++) if (b[keys[i]]) n++;
    return n;
  }

  // ---------- 停用词 / 同义词扩展 ----------
  // 停用词：对检索无意义的高频虚词 / 口语词，去掉以减少噪声（含“如何/怎样”等通用提问词，
  // 因为它们大量出现在文章标题里，反而会制造假的主题相关性）。
  var STOPWORDS = ("的 了 吗 呢 怎么 如何 怎样 什么 为什么 怎么办 可以 能 想 我们 你们 请问 问 一个 一些 这个 那个 有 没 是 在 和 与 及 或 请 帮忙 帮助 解决 问题 吧 啊 哦 呀 哈 处理 一下 需要 应该 咋 该 是否 怎么弄 不知 不知道 我想 我要 帮我 咨询 我这边 我们这边")
    .split(" ");
  // 同义词 -> 规范词。value 必须是知识库中【真实存在的关键词】（或英文 token），
  // 才能参与词面命中；用短语同义词会吞掉有区分度的中文，故尽量用语词级。
  var SYNONYMS = {
    "云盘": "onedrive", "网盘": "onedrive", "蓝云": "onedrive", "蓝色云朵": "onedrive", "个人云": "onedrive",
    "验证器": "authenticator", "身份验证器": "authenticator", "微软验证器": "authenticator", "microsoft authenticator": "authenticator",
    "双因素": "mfa", "两步验证": "mfa", "二次验证": "mfa", "多因素": "mfa",
    "远程桌面": "rdp", "远程": "rdp", "在家办公": "rdp", "远程控制": "rdp",
    "虚拟专网": "vpn", "连外网": "vpn", "外网": "vpn",
    "硬盘加密": "bitlocker", "恢复密钥": "bitlocker", "恢复秘钥": "bitlocker", "启动锁": "bitlocker",
    "报修": "jira", "工单": "jira", "it支持": "jira", "支持热线": "jira", "热线": "jira", "servicedesk": "jira",
    "会议室预订": "meeting", "订会议室": "meeting", "预订会议室": "meeting", "视频会议": "teams",
    "发邮件": "发不出", "收邮件": "收不到", "邮件发不出": "发不出", "发不出去": "发不出", "卡发件箱": "发不出",
    "收不到邮件": "收不到", "没收到邮件": "收不到",
    "组邮箱": "共享邮箱", "共享邮箱": "共享邮箱", "团队邮箱": "共享邮箱", "公共邮箱": "共享邮箱",
    "忘记密码": "重置密码", "重置密码": "重置密码", "改密码": "重置密码", "修改密码": "重置密码", "密码过期": "重置密码",
    "解锁账户": "解锁", "账户被锁": "解锁",
    "诈骗邮件": "钓鱼", "钓鱼": "钓鱼", "可疑邮件": "钓鱼", "垃圾邮件": "垃圾邮件", "白名单": "垃圾邮件", "拦截": "垃圾邮件",
    "打印机": "printer", "连打印机": "printer",
    "网络盘": "nas", "共享盘": "nas", "映射盘": "nas", "映射网络驱动器": "nas", "网络驱动器": "nas",
    "无线网": "wifi", "连wifi": "wifi", "连 wifi": "wifi", "无线": "wifi", "内网": "wifi", "上不了网": "wifi", "连不上网": "wifi", "公司wifi": "wifi",
    "登不上": "登录", "登录不了": "登录", "开机登录": "登录", "域登录": "登录", "锁屏登录": "登录", "pin": "pin",
    "c盘满": "卡顿", "磁盘满": "卡顿", "电脑卡": "卡顿", "电脑慢": "卡顿", "清理电脑": "卡顿",
    "误删文件": "误删", "找回文件": "误删", "恢复文件": "误删", "回收站": "误删", "历史版本": "误删", "还原文件": "误删",
    "邮件签名": "签名", "落款": "落款",
    "新员工": "新员工", "入职": "入职", "报到": "报到", "领电脑": "领电脑", "第一天": "onboarding",
    "装软件": "安装软件", "安装软件": "安装软件", "公司门户": "安装软件", "intune": "intune", "company portal": "intune",
    "外接显示器": "显示器", "双屏": "显示器", "多屏": "显示器", "投影": "投影", "分辨率": "分辨率",
    "手机收邮件": "手机", "outlook手机": "手机", "手机邮箱": "手机", "手机邮件": "手机", "配置手机": "手机",
    "团队站点": "sharepoint", "协作平台": "sharepoint", "团队文档": "sharepoint",
    "自动分类": "规则", "邮件规则": "规则", "分拣": "规则",
    "pst备份": "pst", "备份邮件": "备份", "导出pst": "pst", "归档邮件": "归档", "还原pst": "还原",
    "邮件乱码": "乱码", "乱码": "乱码", "编码": "编码",
    "outlook搜索": "搜索", "搜索邮件": "搜索", "搜不到": "搜索", "重建索引": "重建索引",
    "outlook闪退": "闪退", "outlook卡死": "无响应", "卡死": "无响应", "启动慢": "启动慢", "无响应": "无响应",
    "反复密码": "凭据", "一直要密码": "凭据", "凭据": "凭据", "登录窗口": "登录窗口",
    "owa": "owa", "诊断": "诊断", "排查": "排查", "本地还是服务器": "本地问题",
    "it政策": "it政策", "合规": "合规", "红线": "合规", "盗版": "盗版", "it合规": "合规"
  };
  // 把用户问题规范化：同义词扩展（注入规范关键词）+ 去停用词，提升召回与准确性
  function expandQuery(q) {
    var s = norm(q);
    var keys = Object.keys(SYNONYMS).sort(function (a, b) { return b.length - a.length; });
    keys.forEach(function (k) {
      var kn = norm(k);
      if (s.indexOf(kn) >= 0) s = s.split(kn).join(" " + SYNONYMS[k] + " ");
    });
    STOPWORDS.forEach(function (w) {
      var wn = norm(w);
      if (!wn) return;
      s = s.split(wn).join(" ");
    });
    return s.replace(/\s+/g, " ").trim();
  }

  // 把文本拆成 token：英文/数字词 + 中文单字，用于跨词/跨字的模糊匹配
  function tokenSet(s) {
    var low = (s || "").toLowerCase();
    var set = {};
    var latin = low.match(/[a-z0-9]+/g);
    if (latin) latin.forEach(function (w) { set["w:" + w] = 1; });
    var cjk = low.match(/[一-龥]/g);
    if (cjk) cjk.forEach(function (ch) { set["c:" + ch] = 1; });
    return set;
  }
  function overlapN(a, b) {
    var k = Object.keys(a), n = 0;
    for (var i = 0; i < k.length; i++) if (b[k[i]]) n++;
    return n;
  }
  function overlapEnglish(a, b) {
    var k = Object.keys(a), n = 0;
    for (var i = 0; i < k.length; i++) if (k[i].indexOf("w:") === 0 && b[k[i]]) n++;
    return n;
  }
  function articleKeyText(a) {
    return [a.category, a.title, (a.keywords || []).join(" "), (a.questions || []).join(" ")].join(" ");
  }
  // 文章答案质量因子：过滤 Confluence 同步产生的占位/空壳答案（"true" / "About guide…" 等），
  // 避免这些无效内容污染模型上下文与参考来源。
  function articleQuality(a) {
    var ans = (a.answer || "").replace(/\s+/g, "");
    if (!ans) return 0.1;
    if (ans.length < 25) return 0.15;
    if (/^true\d*$/i.test(ans) || /^true0*true0*$/i.test(ans)) return 0.1;
    if (/关于指南|aboutguide|tableofcontents/i.test((a.answer || "")) && ans.length < 130) return 0.45;
    if (/^[^一-龥a-z0-9]*$/.test(ans)) return 0.3; // 几乎无中英文实质内容
    return 1.0;
  }
  function scoreArticle(q, art) {
    if (!art.answer || !String(art.answer).trim()) return { s: 0, topical: false, quality: 0 };
    var eq = expandQuery(q);
    var keyText = articleKeyText(art);
    var qTok = tokenSet(eq);
    var aKeyTok = tokenSet(keyText);
    var aBodyTok = tokenSet((art.answer || "").slice(0, 700));

    var en = overlapEnglish(qTok, aKeyTok);             // 英文关键词命中（onedrive / vpn / mfa …）
    var bgKey = overlap(bigrams(eq), bigrams(keyText)); // 中文相邻字成词命中（标题/关键词/问题）
    var titleOv = overlapN(qTok, tokenSet(art.title));
    var qOv = 0;
    (art.questions || []).forEach(function (qq) {
      qOv = Math.max(qOv, overlapN(qTok, tokenSet(qq)));
    });
    var bodyOv = overlapN(qTok, aBodyTok);              // 正文单字级重合（噪声，低权重）

    // 主题相关性门控：必须命中英文关键词或中文词（bigram），否则视为不相关，大幅降权
    var topical = (en > 0) || (bgKey >= 1);

    var score = en * 2.2 + qOv * 2.6 + titleOv * 2.2 + bgKey * 1.3 + bodyOv * 0.25;
    var quality = articleQuality(art);
    score *= quality;
    if (!topical) score *= 0.12;
    return { s: score, topical: topical, quality: quality };
  }

  function retrieve(q, topN) {
    var scored = KB.articles.map(function (a) {
      var r = scoreArticle(q, a);
      return { a: a, s: r.s, topical: r.topical, quality: r.quality };
    }).filter(function (x) { return x.s > 0; });
    scored.sort(function (x, y) { return y.s - x.s; });
    return scored.slice(0, topN || 6);
  }

  // ---------- 意图识别（问候 / 感谢 / 能力询问 本地即时回应）----------
  function detectIntent(q) {
    var t = norm(q);
    if (!t) return null;
    var greet = ["你好", "您好", "在吗", "在不在", "有人吗", "早上好", "下午好", "晚上好", "hi", "hello", "hallo", "hey"];
    var thanks = ["谢谢", "感谢", "多谢", "thx", "thanks", "谢了", "麻烦了", "辛苦了"];
    var cap = ["你能做什么", "你会什么", "你能干啥", "你能帮什么", "有什么用", "能问什么", "覆盖什么", "能解决什么", "你会干嘛", "你会做啥", "会什么"];
    function has(arr) { return arr.some(function (w) { return t.indexOf(norm(w)) >= 0; }); }
    if (has(greet)) return "greeting";
    if (has(thanks)) return "thanks";
    if (has(cap)) return "capability";
    return null;
  }
  function intentReply(intent) {
    if (intent === "greeting") {
      return renderText("你好 👋 我是 Jula IT 知识库 AI 助理。\n我可以帮你解决 OneDrive / SharePoint 同步、Outlook 邮件·日历·备份与故障、MFA 注册、WiFi·VPN·NAS·打印机、Jira 工单与 IT 政策等问题。\n直接描述你遇到的问题，或点下面的示例就行～");
    }
    if (intent === "thanks") {
      return renderText("不客气，随时找我 😊 如果还有其他 IT 问题尽管说；仍未解决可联系 IT：bollan.zhang@jula.com（分机 8800）或提交 Jira 工单。");
    }
    if (intent === "capability") {
      var kv = byId["kb-nav"];
      var ans = kv && kv.answer ? kv.answer
        : "我可以解答 Jula IT 相关问题，包括 OneDrive、SharePoint、Outlook 邮件与日历、MFA、网络与打印、Jira 工单与 IT 政策等。";
      return renderText(ans) + sourcesHtml(kv ? [kv] : []);
    }
    return null;
  }

  function buildLocalAnswer(arts, q) {
    if (!arts.length) return null;
    if (arts.length === 1) {
      return "【" + arts[0].title + "】\n" + arts[0].answer;
    }
    var out = "为你找到以下相关指引：\n";
    arts.forEach(function (a, i) {
      out += "\n" + (i + 1) + ". 《" + a.title + "》\n" + a.answer + "\n";
    });
    return out;
  }

  function contactFooter() {
    var c = KB.meta && KB.meta.contact;
    if (!c) return "";
    var sol = "https://jula.atlassian.net/jira/servicedesk/projects/ITSM/knowledge/articles";
    return "\n\n🤖 仍未解决？联系 IT：" + escapeHtml(c.email) + "（分机 " + escapeHtml(c.ext) + "），" +
      '或提交工单：<a href="' + escapeHtml(c.ticket) + '" target="_blank" rel="noopener">' + escapeHtml(c.ticket) + "</a>" +
      '\nIT知识库：<a href="' + escapeHtml(sol) + '" target="_blank" rel="noopener">' + escapeHtml(sol) + "</a>";
  }

  // ---------- LLM（后台固定配置，员工不可修改）----------
  var FIXED_CFG = {
    base: "https://open.bigmodel.cn/api/paas/v4",
    key: "7ee9d3f936204473bdd884f16652370d.ETFM6YrJY2YM45Si",
    model: "glm-4.7-flash"
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function callLLM(cfg, messages, tries) {
    tries = tries || 1;
    var body = {
      model: cfg.model,
      messages: messages,
      temperature: 0.2,
      max_tokens: 1024 // 限制生成长度，降低免费档排队/生成耗时
    };
    var hdrs = { "Content-Type": "application/json" };
    if (cfg.key) hdrs["Authorization"] = "Bearer " + cfg.key; // 直连时才带 Key；走代理时由代理注入
    return fetch(cfg.base + "/chat/completions", {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.ok) return r.json();
      // 限流：HTTP 429（免费模型 RPM/QPS 过低），按 Retry-After 退避重试
      if (r.status === 429 && tries < 4) {
        var ra = parseInt(r.headers.get("Retry-After") || "2", 10);
        if (!isFinite(ra) || ra < 1) ra = 2;
        return sleep(ra * 1000).then(function () { return callLLM(cfg, messages, tries + 1); });
      }
      throw new Error("LLM HTTP " + r.status);
    }).then(function (d) {
      // 智谱把错误放在 200 响应体里（如 1305 限流 / 1113 余额不足），需显式抛出
      if (d && d.error) {
        if (d.error.code === 1305 && tries < 4) {
          return sleep(1500).then(function () { return callLLM(cfg, messages, tries + 1); });
        }
        throw new Error("LLM " + d.error.code + ": " + d.error.message);
      }
      return (d.choices && d.choices[0] && d.choices[0].message.content) || "";
    });
  }

  // ---------- chat UI ----------
  function addMsg(role, html) {
    var m = document.createElement("div");
    m.className = "msg " + role;
    var b = document.createElement("div");
    b.className = "bubble";
    b.innerHTML = html;
    m.appendChild(b);
    chat.appendChild(m);
    chat.scrollTop = chat.scrollHeight;
    verifyDocLinks(m);
    return m;
  }
  function escapeHtml(s) {
    return (s || "").replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }
  // 把文本中的 URL 变成可点击链接：先转义 HTML，再仅对 URL 片段包 <a>，
  // 行内换行由 bubble 的 white-space:pre-wrap 保留。
  function renderText(s) {
    var e = escapeHtml(s);
    return e.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, function (m) {
      var tail = "";
      var mm = m;
      while (/[。，、；：！？.,;:!?）)\]】'"'`]+$/.test(mm)) {
        tail = mm.slice(-1) + tail; mm = mm.slice(0, -1);
      }
      var href = mm.toLowerCase().indexOf("http") === 0 ? mm : "http://" + mm;
      return '<a href="' + href + '" target="_blank" rel="noopener">' + mm + "</a>" + tail;
    });
  }
  // 源文档映射：直接指向 kb_docs/ 下的【原始】PPT / Word 文件，不做任何格式或内容转换，
  // 由浏览器原样下载（下载文件名即原始文件名，不重命名）。
  // 原始文件缺失时，由 verifyDocLinks() 的 HEAD 探测自动隐藏该链接，绝不拿合成内容冒充。
  // 顺序很关键：MFA / IT Introduction 必须排在 IT Tips 第三期之前，
  // 否则 "MFA 手机短信认证 / IT Introduction"、"IT Introduction / IT Tips 第三期" 会被误判到错误文件。
  // 返回某来源对应的【原始】文件名（不含扩展名）。实际文件格式不限 PPT/Word，
  // 只要把原始文件放进 kb_docs/，链接即自动出现并原样下载，绝不做格式/内容转换。
  // 这里直接指向用户提供的原始文档真实文件名（kb_docs/ 内为逐字节原样副本）。
  function sourceDocFile(source) {
    if (!source) return null;
    var map = [
      ["IT Tips 第一期", "IT Tips第一期：OneDrive登录与同步状态指南"],
      ["IT Tips 第二期", "OneDrive与SharePoint同步策略深度解析"],
      ["MFA", "MFA手机短信认证"],
      ["IT Introduction", "IT Introduction-202607 version"],
      ["IT Tips 第三期", "Outlook常见问题与解决方案"],
      ["Outlook 常见问题", "Outlook常见问题与解决方案"]
    ];
    // 按常见原始格式探测，第一个存在的即作为源文档（PPT 优先，其次 Word）
    var exts = ["pptx", "ppt", "docx", "doc"];
    for (var i = 0; i < map.length; i++) {
      if (source.indexOf(map[i][0]) >= 0) {
        var base = map[i][1];
        return {
          name: base,
          candidates: exts.map(function (e) { return "kb_docs/" + base + "." + e; })
        };
      }
    }
    return null;
  }
  // 本地 KB 文章没有源文件二进制，用抽取内容生成可打开/下载的文档
  function localDocHtml(a) {
    var label = escapeHtml((a.category || "") + " · " + a.title);
    var open = '<a class="src-link" href="#" onclick="window.openLocalDoc(\'' +
      a.id + '\');return false;">📄 打开文档</a>';
    var doc = sourceDocFile(a.source);
    var docLink = "";
    if (doc) {
      // 直接给出可见的下载链接（指向真实原始文件，锚点导航在 file:// 与 http:// 下均可下载）；
      // verifyDocLinks 仅在确认文件确实缺失（404/403）时才隐藏，避免探测环境异常导致按钮"消失"。
      var cands = doc.candidates.map(encodeURI);
      docLink = ' <a class="src-link src-doc" data-candidates="' + escapeHtml(JSON.stringify(cands)) +
        '" href="' + cands[0] + '" download="' + escapeHtml(doc.name) +
        '" target="_blank" rel="noopener">📎 下载源文档</a>';
    }
    return '<span class="src-tag"><b>' + label + "</b><br>" + open + " " + docLink + "</span>";
  }
  // 源文档文件可能尚未提供：依次 HEAD 探测候选格式，命中真实存在的原始文件才显示链接，
  // 并按该原始文件名原样下载（不做任何格式/内容转换）。
  function verifyDocLinks(root) {
    var links = root.querySelectorAll ? root.querySelectorAll(".src-doc") : [];
    Array.prototype.forEach.call(links, function (a) {
      var cands;
      try { cands = JSON.parse(a.getAttribute("data-candidates")); } catch (e) { return; }
      if (!cands.length) return; // 无候选信息：保持默认可见
      (function test(i) {
        if (i >= cands.length) return; // 探测全部失败也不强制隐藏，避免环境异常误伤
        fetch(cands[i], { method: "HEAD" }).then(function (r) {
          if (r.ok) {
            // 命中真实存在的原始文件：回填可用于下载的原始文件名
            var parts = cands[i].split("/");
            a.href = cands[i];
            a.setAttribute("download", decodeURIComponent(parts[parts.length - 1]));
          } else if (r.status === 404 || r.status === 403) {
            // 文件确实缺失：尝试下一候选；全部缺失才隐藏
            if (i === cands.length - 1) a.style.display = "none";
            else test(i + 1);
          }
          // 其它状态码或网络错误（如 file:// 下 fetch 被拦截）：保持可见即可
        }).catch(function () { /* 网络/file:// 环境：保持可见 */ });
      })(0);
    });
  }
  window.openLocalDoc = function (id) {
    var a = byId[id];
    if (!a) return;
    var html = "<!doctype html><meta charset='utf-8'><title>" + escapeHtml(a.title) +
      "</title><body style='font-family:system-ui,sans-serif;max-width:780px;margin:28px auto;padding:0 16px;line-height:1.75;color:#222'>" +
      "<h2 style='margin-bottom:4px'>" + escapeHtml(a.title) + "</h2>" +
      "<p style='color:#888;font-size:13px'>分类：" + escapeHtml(a.category || "") +
      " · 来源：" + escapeHtml(a.source || "") + "</p><hr style='border:none;border-top:1px solid #eee'>" +
      "<div style='white-space:pre-wrap'>" + renderText(a.answer) + "</div></body>";
    var w = window.open("", "_blank");
    if (w) { w.document.open(); w.document.write(html); w.document.close(); }
  };

  function sourcesHtml(arts) {
    if (!arts.length) return "";
    var tags = arts.map(function (a) {
      var label = escapeHtml((a.category || "") + " · " + a.title);
      if (a.url) {
        var open = '<a class="src-link" href="' + escapeHtml(a.url) +
          '" target="_blank" rel="noopener">📄 打开文档 ↗</a>';
        return '<span class="src-tag"><b>' + label + "</b><br>" + open + "</span>";
      }
      return localDocHtml(a);
    }).join("");
    return '<div class="sources">📚 参考文档：' + tags + "</div>";
  }

  function showTyping(on) { typing.hidden = !on; if (on) chat.scrollTop = chat.scrollHeight; }

  function send() {
    var q = input.value.trim();
    if (!q && attachments.length === 0) return;

    // 拼出用于检索/历史记录的纯文本（图片无法检索，仅并入文本附件内容）
    var textFiles = attachments.filter(function (a) { return a.type === "text"; });
    var userText = q;
    if (textFiles.length) {
      var blk = textFiles.map(function (a) {
        return "\n\n【附件文本：" + a.name + "】\n" + a.text;
      }).join("");
      userText = (q ? q : "（请结合以下附件内容回答）") + blk;
    }
    var searchText = q || userText;

    // 意图识别：问候 / 感谢 / 能力询问 走本地即时回应（零延迟、更可控，不必占用模型）
    if (attachments.length === 0) {
      var intent = detectIntent(q);
      if (intent) {
        var rep = intentReply(intent);
        addMsg("user", escapeHtml(q));
        addMsg("bot", rep);
        input.value = "";
        input.style.height = "auto";
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: intent });
        trimHistory();
        return;
      }
    }

    // 构建发给模型的内容（多模态：文本 + 图片）
    var content;
    if (attachments.length === 0) {
      content = q;
    } else {
      content = [{ type: "text", text: userText }];
      attachments.forEach(function (a) {
        if (a.type === "image") content.push({ type: "image_url", image_url: { url: a.dataUrl } });
      });
    }

    // 用户气泡：文本 + 图片缩略图
    var imgs = attachments.filter(function (a) { return a.type === "image"; });
    var userHtml = escapeHtml(q || "（已发送附件，请查看图片）");
    if (imgs.length) {
      userHtml += '<div class="att-mini">' + imgs.map(function (a) {
        return '<img src="' + a.dataUrl + '" alt="附件图片" />';
      }).join("") + "</div>";
    }
    addMsg("user", userHtml);
    input.value = "";
    input.style.height = "auto";
    attachments = [];
    renderAttachmentPreview();
    showTyping(true);
    sendBtn.disabled = true;

    var scored = retrieve(searchText, 6);
    // 仅把“主题相关 + 答案可用”的文章送入模型上下文，避免噪声带偏回答
    var ctxArticles = scored.filter(function (x) {
      return x.topical && x.quality >= 0.3;
    }).slice(0, 3);
    var arts = scored.map(function (x) { return x.a; });
    var best = scored[0];
    var maxS = best ? best.s : 0;
    // 参考文档：展示与问题真正相关的条目（至少保底 1 篇），无关的模糊召回不列为来源
    var precise = ctxArticles.filter(function (x) { return x.s >= Math.max(0.5, maxS * 0.5); });
    if (!precise.length) precise = ctxArticles.slice(0, 1);
    var preciseArts = precise.map(function (x) { return x.a; });

    var ctx = ctxArticles.map(function (x) {
      return "《" + x.a.title + "》\n" + x.a.answer;
    }).join("\n\n");

    var sys = "你是 Jula 公司的 IT 支持 AI 助理，语气友好、简洁、专业，使用简体中文。\n" +
      "【回答纪律】\n" +
      "1) 只有当【知识库】中有能直接回答该问题的条目时，才基于它作答；严禁凭空编造具体步骤、命令或链接。\n" +
      "2) 若【知识库】没有任何相关条目（即下方为空或明显无关），明确告知用户：“这超出了我当前知识库的范围”，并引导其联系 IT（邮箱 bollan.zhang@jula.com / 分机 8800）或提交 Jira 工单，不要硬凑答案。\n" +
      "3) 用清晰的编号步骤（1) 2) 3)）组织答案；如存在多条可选方案，分点说明。\n" +
      "4) 处理追问：结合【对话历史】理解“那怎么操作”“链接在哪”“具体步骤”等指代，保持语境连贯。\n" +
      "5) 不要猜测或生成任何 URL；参考链接由系统在答案下方统一提供，你无需提供。\n" +
      (ctx ? "\n【知识库】\n" + ctx
           : "\n（本次未检索到明确相关的知识库条目，请严格按上述第 2 条纪律回应，不要编造。）");
    var messages = [{ role: "system", content: sys }]
      .concat(history, [{ role: "user", content: content }]);

    callLLM(FIXED_CFG, messages).then(function (ans) {
      showTyping(false); sendBtn.disabled = false;
      history.push({ role: "user", content: userText });
      if (ans && ans.trim()) {
        history.push({ role: "assistant", content: ans });
        addMsg("bot", renderText(ans) + sourcesHtml(preciseArts) + contactFooter());
      } else {
        // 模型返回空：回退到本地答案，仍保留文档链接
        var la = buildLocalAnswer(arts, searchText) || fallback(searchText);
        history.push({ role: "assistant", content: la });
        addMsg("bot", renderText(la) + sourcesHtml(preciseArts) + contactFooter());
      }
      trimHistory();
    }).catch(function (err) {
      showTyping(false); sendBtn.disabled = false;
      // API 失败：兜底用本地知识库作答，保证可用；同时把真实错误暴露出来便于排查
      var la = buildLocalAnswer(arts, searchText) || fallback(searchText);
      var why = (err && err.message) ? err.message : "网络/跨域被拒绝(Failed to fetch)";
      var note = "\n\n（注：API 调用失败：" + why + "，已回退到本地知识库）";
      history.push({ role: "user", content: userText });
      history.push({ role: "assistant", content: la + note });
      trimHistory();
      addMsg("bot", renderText(la + note) + sourcesHtml(preciseArts) + contactFooter());
    });
  }

  function fallback(q) {
    return "抱歉，我在当前知识库中没有找到与「" + q + "」直接匹配的内容。\n" +
      "你可以换一种说法，或联系 IT 支持获取帮助。";
  }

  // ---------- 附件（图片 / .txt） ----------
  function renderAttachmentPreview() {
    previews.innerHTML = "";
    attachments.forEach(function (a, i) {
      var chip = document.createElement("div");
      chip.className = "att-chip";
      if (a.type === "image") {
        var img = document.createElement("img");
        img.src = a.dataUrl; img.className = "att-thumb";
        chip.appendChild(img);
      } else {
        var ic = document.createElement("span");
        ic.className = "att-file"; ic.textContent = "📄";
        chip.appendChild(ic);
      }
      var name = document.createElement("span");
      name.className = "att-name"; name.textContent = a.name;
      chip.appendChild(name);
      var x = document.createElement("button");
      x.className = "att-x"; x.type = "button"; x.textContent = "×"; x.title = "移除";
      x.onclick = function () { attachments.splice(i, 1); renderAttachmentPreview(); };
      chip.appendChild(x);
      previews.appendChild(chip);
    });
    previews.hidden = attachments.length === 0;
  }

  function addFiles(fileList) {
    Array.prototype.forEach.call(fileList, function (f) {
      if (f.type.indexOf("image/") === 0) {
        var rd = new FileReader();
        rd.onload = function () {
          attachments.push({ type: "image", name: f.name, dataUrl: rd.result });
          renderAttachmentPreview();
        };
        rd.readAsDataURL(f);
      } else if (f.type === "text/plain" || /\.txt$/i.test(f.name)) {
        var rt = new FileReader();
        rt.onload = function () {
          attachments.push({ type: "text", name: f.name, text: rt.result });
          renderAttachmentPreview();
        };
        rt.readAsText(f);
      } else {
        alert("暂不支持的文件类型：" + f.name + "\n目前仅支持图片和 .txt 文本文件。");
      }
    });
  }

  attachBtn.onclick = function () { fileInput.click(); };
  fileInput.onchange = function () { addFiles(fileInput.files); fileInput.value = ""; };

  // ---------- init ----------
  SUGGESTIONS.slice(0, 6).forEach(function (s) {
    var c = document.createElement("span");
    c.className = "chip";
    c.textContent = s;
    c.onclick = function () { input.value = s; send(); };
    chips.appendChild(c);
  });

  sendBtn.onclick = send;
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

})();
