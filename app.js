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

  // ---------- helpers ----------
  function norm(s) {
    return (s || "").toLowerCase().replace(/\s+/g, "");
  }
  function bigrams(s) {
    s = norm(s);
    var set = {};
    for (var i = 0; i < s.length - 1; i++) set[s.substr(i, 2)] = 1;
    return set;
  }
  function overlap(a, b) {
    var keys = Object.keys(a), n = 0;
    for (var i = 0; i < keys.length; i++) if (b[keys[i]]) n++;
    return n;
  }

  // ---------- retrieval（模糊检索）----------
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
  function scoreArticle(q, art) {
    // 空答案的落地页（如仅含子页列表的 Confluence 父页）不作为回答，避免显示空白
    if (!art.answer || !String(art.answer).trim()) return 0;
    var field = [art.category, art.title, (art.keywords || []).join(" "),
      (art.questions || []).join(" "), (art.answer || "").slice(0, 400)].join(" ");
    var qTok = tokenSet(q);
    var aTok = tokenSet(field);
    var ov = overlapN(qTok, aTok);                     // 词/字级模糊重合
    var bg = overlap(bigrams(q), bigrams(field));      // 字符级 bigram 模糊（容忍错别字/词序）
    var titleOv = overlapN(qTok, tokenSet(art.title)); // 标题命中加权
    return ov * 1.2 + bg * 0.5 + titleOv * 1.5;
  }

  function retrieve(q, topN) {
    var scored = KB.articles.map(function (a) {
      return { a: a, s: scoreArticle(q, a) };
    });
    scored.sort(function (x, y) { return y.s - x.s; });
    var best = scored.filter(function (x) { return x.s > 0; });
    if (best.length === 0) return [];
    // 作答用的模糊召回：保留分数 >= 最高分 25% 的文章（容忍错别字/词序，问题检索可模糊）
    var max = best[0].s;
    var keep = best.filter(function (x) { return x.s >= Math.max(0.5, max * 0.25); });
    return keep.slice(0, topN || 3);
  }

  // 判断问题是否真的命中某篇文章的主题：要求与文章【关键词】有实质重叠，
  // 要么含英文关键词（如 onedrive / vpn / mfa…），要么含 >=3 个中文关键词字，
  // 以过滤"电脑黑屏"这类仅因共享个别汉字而误匹配的问题。
  function isTopical(q, art) {
    var qTok = tokenSet(q);
    var kwTok = tokenSet((art.keywords || []).join(" "));
    var latin = 0, cjk = 0;
    for (var k in qTok) {
      if (!kwTok[k]) continue;
      if (k.indexOf("w:") === 0) latin++;
      else if (k.indexOf("c:") === 0) cjk++;
    }
    return latin > 0 || cjk >= 3;
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
    key: "7c947720ea864d3abd3fc43324e40a32.dlK66v8U3skJiZM2",
    model: "glm-4-flash"
  };

  function callLLM(cfg, q, context) {
    var sys = "你是 Jula 公司的 IT 支持 AI 助理，语气友好、简洁、专业，使用简体中文。" +
      "优先依据下方【知识库】内容回答；若知识库不足以回答，可基于通用知识作答，不要编造。" +
      "用清晰的步骤（1) 2) 3)）组织答案。重要：不要编造或猜测任何 URL/链接；" +
      "知识库上下文中未明确给出的链接请勿自行添加，参考来源链接由系统在答案下方统一展示。若仍无法解决，引导用户提交 Jira 工单或联系 IT。" +
      "\n\n【知识库】\n" + context;
    var body = {
      model: cfg.model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: q }
      ],
      temperature: 0.2
    };
    return fetch(cfg.base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.key },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error("LLM HTTP " + r.status);
      return r.json();
    }).then(function (d) {
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
    if (!q) return;
    addMsg("user", escapeHtml(q));
    input.value = "";
    input.style.height = "auto";
    showTyping(true);
    sendBtn.disabled = true;

    var scored = retrieve(q, 3);
    var arts = scored.map(function (x) { return x.a; });
    // 参考文档需"精确定位"：只展示分数 >= 最高分 60% 的文章（至少保底 1 篇），
    // 其余模糊召回的仅用于组答案，不列为参考文档。
    var best = scored[0];
    var maxS = best ? best.s : 0;
    var precise = scored.filter(function (x) { return x.s >= maxS * 0.6; });
    if (!precise.length) precise = scored.slice(0, 1);
    var preciseArts = precise.map(function (x) { return x.a; });
    var cfg = FIXED_CFG; // 后台固定模型，员工不可改

    // 检索优先级：① 本地知识库（Jira/Confluence 同步 + 上传的源文件）模糊匹配
    //           ② 仅当本地命中"确实相关"时才本地作答，否则回退 API 模型。
    // 相关判定：整体分数够高(>=CONF_SCORE) 或 命中文章关键词(英文词 / >=3 个中文关键词字)，
    // 过滤"电脑黑屏"这类仅因共享个别汉字而被弱匹配误答的无关问题。
    var CONF_SCORE = 9;
    var confident = !!(best && (maxS >= CONF_SCORE || isTopical(q, best.a)));
    var localAnswer = confident ? buildLocalAnswer(arts, q) : null;

    if (localAnswer) {
      setTimeout(function () {
        showTyping(false); sendBtn.disabled = false;
        addMsg("bot", renderText(localAnswer) + sourcesHtml(preciseArts) + contactFooter());
      }, 250);
      return;
    }

    // 本地无答案 → 回退到 API 模型（若已配置）
    if (cfg && cfg.base && cfg.key && cfg.model) {
      var ctx = arts.map(function (a) { return "《" + a.title + "》\n" + a.answer; }).join("\n\n");
      callLLM(cfg, q, ctx).then(function (ans) {
        showTyping(false); sendBtn.disabled = false;
        if (ans && ans.trim()) {
          // 回退到 API 时不再附带本地弱匹配文档链接（避免误导）；
          // renderText 会把答案中真实存在的网址自动转成可点击链接。
          addMsg("bot", renderText(ans) + contactFooter());
        } else {
          addMsg("bot", renderText(fallback(q)) + contactFooter());
        }
      }).catch(function () {
        showTyping(false); sendBtn.disabled = false;
        addMsg("bot", renderText(fallback(q) +
          "\n\n（注：API 调用失败，请检查模型设置或联系 IT）") + contactFooter());
      });
    } else {
      setTimeout(function () {
        showTyping(false); sendBtn.disabled = false;
        addMsg("bot", renderText(fallback(q)) + contactFooter());
      }, 250);
    }
  }

  function fallback(q) {
    return "抱歉，我在当前知识库中没有找到与「" + q + "」直接匹配的内容。\n" +
      "你可以换一种说法，或联系 IT 支持获取帮助。";
  }

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
