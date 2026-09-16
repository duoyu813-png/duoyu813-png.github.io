#!/usr/bin/env node
/**
 * generate-daily.js — 云端「本草日课」生成器
 *
 * 流程：定节气 → 选题（应季食材/节气养生/专题分析/热点辨析）→ 挑当令药材（自动避重复）
 *       → 免费抓取养生热点（Google/Bing 新闻 RSS，无需 Key）→ LLM 写文
 *       → 写 daily/YYYY-MM-DD.md → 跑 md2wechat.js 出公众号稿 → 跑 build-daily.js 更新站点
 *
 * 环境变量（GitHub Actions Secrets）：
 *   LLM_API_KEY       必填，模型密钥（智谱等 OpenAI 兼容端点）
 *   LLM_BASE_URL      选填，默认智谱 https://open.bigmodel.cn/api/paas/v4
 *   LLM_MODEL         选填，默认 glm-4.5-flash（智谱免费模型）
 *   TAVILY_API_KEY    选填；不填则用免费源抓热点（中国中医药网 → Google/Bing 新闻 RSS）
 *   FORCE=1           选填，当天已有文章时强制覆盖
 *   DATE=YYYY-MM-DD   选填，指定日期（测试用），默认今天
 *   DRY_RUN=1         选填，只选题不调用 AI
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DAILY = path.join(ROOT, 'daily');

const LLM_KEY = process.env.LLM_API_KEY || process.env.ZHIPU_API_KEY || process.env.GEMINI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const LLM_BASE = (process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'glm-4.5-flash';
const TV_KEY = process.env.TAVILY_API_KEY || '';
const FORCE = process.env.FORCE === '1';

/* 供 GitHub Actions 判断本次是否真的新写了文章（决定要不要发邮件） */
function setOutput(line) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line + '\n');
}

const TYPES = ['应季食材', '节气养生', '专题分析', '热点辨析'];

/* 专题分析可选主题（症状/体质 → 相关药材检索词，越具体越好） */
const TOPICS = [
  { name: '头痛', keys: ['头痛', '头风', '眩晕', '平肝'] },
  { name: '失眠', keys: ['失眠', '不眠', '安神', '多梦', '心悸'] },
  { name: '咳嗽', keys: ['咳嗽', '咳喘', '化痰', '润肺'] },
  { name: '胃寒胃痛', keys: ['胃寒', '温中散寒', '脾胃虚寒', '脘腹冷痛'] },
  { name: '便秘', keys: ['便秘', '润肠', '肠燥'] },
  { name: '上火', keys: ['清热', '泻火', '口疮', '目赤肿痛'] },
  { name: '湿气重', keys: ['祛湿', '化湿', '利水', '水肿', '痰饮'] },
  { name: '疲劳乏力', keys: ['补气', '益气', '气虚', '倦怠', '虚羸'] },
  { name: '眼干目涩', keys: ['明目', '目昏', '目赤', '益精明目'] },
  { name: '咽干咽痛', keys: ['咽喉', '利咽', '咽痛', '喉痹', '失音'] },
  { name: '秋燥干咳', keys: ['润燥', '润肺', '生津', '干咳', '肺燥'] },
  { name: '脾虚食少', keys: ['健脾', '脾虚', '食少', '便溏', '运化'] }
];

function todayStr() {
  if (process.env.DATE && /^\d{4}-\d{2}-\d{2}$/.test(process.env.DATE)) return process.env.DATE;
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/* ---------- 加载 window 数据 ---------- */
function loadWindow(files) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  files.forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  });
  return sandbox.window;
}

const win = loadWindow([
  'data/jieqi.js', 'data/herbs-1.js', 'data/herbs-2.js', 'data/herbs-3.js', 'data/herbs-4.js'
]);
const JIEQI = win.JIEQI || [];
const HERBS = win.HERBS || [];

/* ---------- 节气 ---------- */
function key(md) { return md[0] * 100 + md[1]; }
function jieqiOf(dateStr) {
  const tk = key([+dateStr.slice(5, 7), +dateStr.slice(8, 10)]);
  return JIEQI.find(j => {
    const a = key(j.start), b = key(j.end);
    return a <= b ? (tk >= a && tk <= b) : (tk >= a || tk <= b);
  }) || JIEQI[0];
}

/* ---------- 已写过的文章 ---------- */
function history() {
  return fs.readdirSync(DAILY)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort().reverse()
    .map(f => {
      const raw = fs.readFileSync(path.join(DAILY, f), 'utf8');
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const meta = {};
      if (m) m[1].split(/\r?\n/).forEach(l => {
        const kv = l.match(/^([^:：]+)[:：]\s*(.*)$/);
        if (kv) meta[kv[1].trim()] = kv[2].trim();
      });
      return {
        date: f.replace(/\.md$/, ''),
        herb: meta['主角药材'] || '',
        type: meta['选题类型'] || '',
        topic: meta['主题'] || ''
      };
    });
}

/* ---------- 基于日期的可复现随机 ---------- */
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isRecent(h, recentHerbs) {
  return recentHerbs.has(h.name) || (h.alias || []).some(a => recentHerbs.has(a));
}
function freshFilter(list, recentHerbs) {
  return list.filter(h => !isRecent(h, recentHerbs));
}

function pickHerb(jq, dateStr, recentHerbs) {
  const month = +dateStr.slice(5, 7);
  const rand = rng(dateStr);
  const seasonal = HERBS.filter(h => (h.months || []).includes(month));
  const inFoods = h => (jq.foods || []).some(f => h.name === f || (h.alias || []).includes(f));
  let pool = freshFilter(seasonal.filter(inFoods), recentHerbs);
  if (!pool.length) pool = freshFilter(seasonal, recentHerbs);
  if (!pool.length) pool = seasonal;
  if (!pool.length) pool = freshFilter(HERBS, recentHerbs);
  if (!pool.length) pool = HERBS;
  return pool[Math.floor(rand() * pool.length)];
}

function pickType(dateStr, recentTypes) {
  const rand = rng(dateStr + ':type');
  const recent = new Set(recentTypes.slice(0, 2));
  const pool = TYPES.filter(t => !recent.has(t));
  const list = pool.length ? pool : TYPES;
  return list[Math.floor(rand() * list.length)];
}

function pickTopic(dateStr, recentTopics) {
  const rand = rng(dateStr + ':topic');
  let pool = TOPICS.filter(t => !recentTopics.has(t.name));
  if (!pool.length) pool = TOPICS;
  return pool[Math.floor(rand() * pool.length)];
}

function herbsForTopic(topic) {
  return HERBS.map(h => {
    const hay = [h.name, (h.alias || []).join(''), h.effect, h.indications, h.cat].join(' ');
    let score = 0;
    topic.keys.forEach(k => { if (hay.indexOf(k) > -1) score++; });
    if (topic.keys.some(k => h.name === k)) score += 3;
    return { h, score };
  }).filter(o => o.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(o => o.h);
}

function chooseHerbForTopic(topic, dateStr, recentHerbs) {
  const month = +dateStr.slice(5, 7);
  const rand = rng(dateStr + ':herb');
  const cand = herbsForTopic(topic);
  let pool = freshFilter(cand.filter(h => (h.months || []).includes(month)), recentHerbs);
  if (!pool.length) pool = freshFilter(cand, recentHerbs);
  if (!pool.length) pool = cand;
  if (!pool.length) pool = freshFilter(HERBS, recentHerbs);
  if (!pool.length) pool = HERBS;
  return pool[Math.floor(rand() * pool.length)];
}

/* ---------- 免费热点：新闻 RSS（无需 Key） ---------- */
function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function stripTags(s) { return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const get = tag => {
      const r = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
      return r ? decodeEntities(r[1]) : '';
    };
    const title = stripTags(get('title'));
    if (!title) continue;
    items.push({
      title: title,
      url: stripTags(get('link')),
      date: stripTags(get('pubDate')).slice(0, 16),
      content: stripTags(decodeEntities(get('description'))).slice(0, 400)
    });
    if (items.length >= 5) break;
  }
  return items;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BenCaoBot/1.0)' } });
  if (!res.ok) throw new Error(url.slice(0, 60) + ' → ' + res.status);
  return res.text();
}

async function googleNews(query) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) +
    '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
  return { source: 'Google新闻', items: parseRss(await fetchText(url)) };
}

async function bingNews(query) {
  const url = 'https://www.bing.com/news/search?q=' + encodeURIComponent(query) + '&format=RSS&setlang=zh-CN';
  return { source: 'Bing新闻', items: parseRss(await fetchText(url)) };
}

/* 中国中医药网「养生中国」：官方中医药资讯，UTF-8，无需 Key */
async function tcmNews(hints) {
  const listUrl = 'https://www.cntcm.com.cn/col2124.html';
  const html = await fetchText(listUrl);
  const arts = [];
  const re = /<a\s[^>]*href=["']([^"']*content\/\d{6}\/\d{2}\/c\d+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const title = stripTags(m[2]);
    if (!title || title.length < 6) continue;
    const dm = m[1].match(/content\/(\d{4})(\d{2})\/(\d{2})\//);
    const url = m[1].startsWith('http') ? m[1] : 'https://www.cntcm.com.cn/' + m[1].replace(/^\.?\//, '');
    arts.push({ url, title, date: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : '' });
  }
  const seen = new Set();
  const uniq = arts.filter(a => (seen.has(a.url) ? false : (seen.add(a.url), true)));
  uniq.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const cand = uniq.slice(0, 6);
  const hs = (hints || []).filter(Boolean);
  for (const a of cand) {
    try {
      const h = await fetchText(a.url);
      const idx = h.search(/id=["']content["']/i);
      a.content = stripTags(idx >= 0 ? h.slice(idx, idx + 6000) : h).slice(0, 600);
    } catch (e) { a.content = ''; }
    const hay = a.title + ' ' + a.content;
    a.score = hs.reduce((n, k) => n + (hay.indexOf(k) > -1 ? 1 : 0), 0);
  }
  cand.sort((a, b) => (b.score - a.score) || String(b.date).localeCompare(String(a.date)));
  return { source: '中国中医药网·养生中国', items: cand.slice(0, 3) };
}

async function tavily(query) {
  if (!TV_KEY) return null;
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TV_KEY },
    body: JSON.stringify({
      api_key: TV_KEY, query, search_depth: 'basic',
      include_answer: true, max_results: 5, topic: 'news', days: 7
    })
  });
  if (!res.ok) throw new Error('Tavily ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return { source: 'Tavily', answer: data.answer || '', items: (data.results || []).map(r => ({ title: r.title, url: r.url, content: (r.content || '').slice(0, 500) })) };
}

/* 依次尝试免费源，任一成功即返回 */
async function searchHot(query, hints) {
  if (TV_KEY) { try { return await tavily(query); } catch (e) { /* 继续用免费源 */ } }
  const sources = [
    () => tcmNews(hints),
    () => googleNews(query),
    () => bingNews(query)
  ];
  const errs = [];
  for (const fn of sources) {
    try {
      const r = await fn();
      if (r.items && r.items.length) return r;
      errs.push(r.source + ' 无结果');
    } catch (e) { errs.push(e.message); }
  }
  if (errs.length) console.error('免费热点源均失败：' + errs.join('；'));
  return null;
}

/* ---------- 调用 LLM ---------- */
async function chat(messages) {
  const payload = { model: LLM_MODEL, messages, temperature: 1.0, max_tokens: 3000, stream: false };
  // 智谱 GLM-4.5 默认开启思考模式，会耗尽 token 导致正文为空，这里显式关闭
  if (/bigmodel\.cn/.test(LLM_BASE)) payload.thinking = { type: 'disabled' };
  const res = await fetch(LLM_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LLM_KEY },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('LLM ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const text = msg.content || '';
  if (!text) throw new Error('LLM 返回正文为空：' + JSON.stringify(data).slice(0, 300));
  return text.trim();
}

function structureFor(type, dateStr, topic) {
  if (type === '专题分析' && topic) {
    return [
      '# 标题',
      `开篇 1–2 段，从 ${dateStr} 的节气或热点切入，自然引出「${topic.name}」，约 150 字。`,
      `## ${topic.name}，先分清是哪一型`,
      '用 2–3 个常见证型讲清楚：每一型的诱因、典型表现（尽量点出舌象或伴随症状）。约 300 字。',
      '## 对证的食疗方',
      '→ 方名：组成（写清用量）；制法；适合哪一型',
      '→ 方名：组成（写清用量）；制法；适合哪一型',
      '## 日常预防与调理',
      '给 3 条能马上做的建议：起居作息、穴位（写清位置与按法）、情志或运动。约 200 字。',
      '## 禁忌提醒',
      '写清哪些情况不能只靠食疗、必须及时就医。约 120 字。'
    ];
  }
  return [
    '# 标题',
    `开篇 1–2 段，从 ${dateStr} 的节气或热点切入，约 150 字。`,
    '## 它到底是什么',
    '讲清药性、功效，以及上面给到的古籍依据。约 220 字。',
    '## 两道方子',
    '→ 方名：组成（写清用量）；制法；适合人群',
    '→ 方名：组成（写清用量）；制法；适合人群',
    '## 怎么吃更合适',
    '讲清与当季食材的搭配（从上面「应季食材」里挑 2–3 样），以及吃的频次与时机。约 180 字。',
    '## 除了吃，还要注意',
    '给 2–3 条起居、穴位或预防建议。约 160 字。',
    '## 禁忌提醒',
    '写清哪些人不能吃、慎吃。约 120 字。'
  ];
}

function buildMessages(dateStr, jq, herb, type, hot, topic) {
  const system = [
    '你是「本草拾遗」的中医食疗专栏作者，文风：口语、克制、有据可查，不夸大、不恐吓。',
    '只用药食同源知识，不得做医疗诊断、不得开处方、不得承诺疗效；需要就医的情况要明确提示就医。',
    '禁止编造古籍原文与出处；引用只能来自下方给定的「药材资料」，引用不到的不要写。',
    '严禁编造新闻、数据、专家姓名与媒体名称；热点只能化用下方给出的资讯，不得杜撰细节。',
    '下方「近期资讯」仅作背景参考：与今天的节气或药材相关才可引用，不相关就完全忽略，绝不生硬硬蹭。',
    '全文约 1000–1200 字，简体中文。'
  ].join('\n');

  const mb = (herb.recipes || []).map(r => `- ${r.name}｜组成：${r.material}｜制法：${r.method}｜效用：${r.effect}`).join('\n');
  const classic = (herb.classic || []).map(c => `《${c.book}》：${c.text}`).join('\n');

  const hotText = (hot && hot.items && hot.items.length)
    ? ('【近期养生资讯（来自' + hot.source + '）·仅作背景参考，相关才用、不相关请完全忽略，不要硬蹭】\n' + (hot.answer ? '摘要：' + hot.answer + '\n' : '') +
       hot.items.map(i => `- ${i.title}${i.date ? '（' + i.date + '）' : ''}${i.url ? ' ' + i.url : ''}\n  ${i.content}`).join('\n'))
    : '【近期热点】无（未取到），请纯以节气与药材知识切入。';

  const topicLine = (type === '专题分析' && topic)
    ? `【专题】${topic.name}——先说清分型与病因，再给对证的食疗与预防调理。`
    : '';

  const user = [
    `请写一篇 ${dateStr} 的「本草日课」。`,
    '',
    `【节气】${jq.name}（${jq.start[0]}/${jq.start[1]}–${jq.end[0]}/${jq.end[1]}）`,
    `养生要点：${jq.yangsheng}`,
    `饮食宜忌：${jq.yinshi}`,
    `应季食材：${(jq.foods || []).join('、')}`,
    '',
    `【主角药材】${herb.name}（别名：${(herb.alias || []).join('、') || '无'}；${herb.nature}，${herb.flavor}，归${(herb.meridian || []).join('、')}经）`,
    `功效：${herb.effect}`,
    `主治：${herb.indications}`,
    `禁忌：${herb.caution}`,
    classic ? '古籍：\n' + classic : '',
    mb ? '现有食疗方：\n' + mb : '',
    '',
    hotText,
    '',
    `【选题类型】${type}（${typeDesc(type)}）`,
    topicLine,
    '',
    '【输出格式】只输出文章正文本身，不要 frontmatter、不要代码块、不要任何说明文字。',
    '第一行写成「# 标题」，标题一句话，可含疑问或反差，不要带书名号，然后空一行再写正文。',
    '',
    '正文严格照下面结构写（小标题文字可自拟，但层级和符号必须一致）：',
    ...structureFor(type, dateStr, topic),
    '> 本内容仅供学习参考，不替代医生诊断……（免责声明必须用 > 顶格开头，不要写成 ## 标题）',
    '*素材参考：……*',
    '',
    '硬性要求：食疗方必须以「→ 」顶格单独成行，2 道，用量明确；不要把方名写成 ### 标题。',
    '全文约 1000–1200 字；资料不足时宁可少写，也不要编造古籍、新闻、专家或数据。'
  ].filter(Boolean).join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function typeDesc(t) {
  return {
    '应季食材': '从当下最当令的一味食材讲起，纠正一个常见误区',
    '节气养生': '讲清这个节气的身体变化与调养重点，药材是落点',
    '专题分析': '针对一个常见症状/体质做辨证分型，给出对证的吃法与预防调理',
    '热点辨析': '针对近期流传的养生说法，先摆出再辨析'
  }[t] || '围绕节气与药材展开';
}

/* ---------- 解析模型输出 ---------- */
function normalize(text, meta) {
  let t = text.trim();
  const fence = t.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```$/);
  if (fence) t = fence[1].trim();

  const hm = t.match(/^#\s+(.+)$/m);
  let title;
  if (hm) {
    title = hm[1].trim();
    t = t.slice(t.indexOf(hm[0])).trim();
  } else {
    title = meta.fallbackTitle;
    t = '# ' + title + '\n\n' + t;
  }
  if (t.replace(/\s/g, '').length < 300) throw new Error('正文过短，疑似生成失败');

  return '---\n' +
    '标题: ' + title + '\n' +
    '日期: ' + meta.date + '\n' +
    '节气: ' + meta.jieqi + '\n' +
    '选题类型: ' + meta.type + '\n' +
    (meta.topic ? '主题: ' + meta.topic + '\n' : '') +
    '主角药材: ' + meta.herb + '\n' +
    '---\n\n' + t + '\n';
}

/* ---------- 主流程 ---------- */
(async () => {
  if (!LLM_KEY && process.env.DRY_RUN !== '1') { console.error('缺少 LLM_API_KEY'); process.exit(1); }

  const dateStr = todayStr();
  const mdPath = path.join(DAILY, dateStr + '.md');
  if (fs.existsSync(mdPath) && !FORCE) {
    console.log(dateStr + ' 已有文章，跳过（FORCE=1 可覆盖）');
    setOutput('generated=false');
    return;
  }

  const jq = jieqiOf(dateStr);
  const hist = history();
  const recentHerbs = new Set();
  hist.slice(0, 12).forEach(h => {
    String(h.herb || '').split(/[、,，/／]/).forEach(s => {
      const base = s.replace(/[（(].*$/, '').trim();
      if (base) recentHerbs.add(base);
    });
  });
  const recentTopics = new Set(hist.slice(0, 12).map(h => h.topic).filter(Boolean));

  const type = pickType(dateStr, hist.map(h => h.type).filter(Boolean));
  let topic = null;
  let herb;
  if (type === '专题分析') {
    topic = pickTopic(dateStr, recentTopics);
    herb = chooseHerbForTopic(topic, dateStr, recentHerbs);
  } else {
    herb = pickHerb(jq, dateStr, recentHerbs);
  }
  if (!herb) { console.error('没有可选药材'); process.exit(1); }

  console.log(`日期 ${dateStr}｜节气 ${jq.name}｜选题 ${type}` +
    (topic ? `（${topic.name}）` : '') + `｜药材 ${herb.name}`);

  if (process.env.DRY_RUN === '1') {
    console.log('DRY_RUN：仅做选题，不调用 AI。已用药材 ' + [...recentHerbs].join('、') +
      (recentTopics.size ? '；已用主题 ' + [...recentTopics].join('、') : ''));
    setOutput('generated=false');
    return;
  }

  const query = (topic ? topic.name + ' ' : '') + `${jq.name} 养生 中医 调理`;
  const hints = [jq.name, herb.name, topic ? topic.name : '', '节气', '养生', '秋', '燥'];
  let hot = null;
  try {
    hot = await searchHot(query, hints);
    if (hot) console.log('热点源 ' + hot.source + '：' + hot.items.length + ' 条');
    else console.log('未取到热点，按纯节气+药材生成');
  } catch (e) {
    console.error('热点检索异常，降级：' + e.message);
  }

  const content = await chat(buildMessages(dateStr, jq, herb, type, hot, topic));
  fs.writeFileSync(mdPath, normalize(content, {
    date: dateStr,
    jieqi: `${jq.name}（${jq.start[0]}/${jq.start[1]}–${jq.end[0]}/${jq.end[1]}）`,
    type: type,
    topic: topic ? topic.name : '',
    herb: herb.name,
    fallbackTitle: `${jq.name}·${herb.name}：今日本草日课`
  }), 'utf8');
  console.log('已写入 ' + path.relative(ROOT, mdPath));
  setOutput('generated=true');

  execFileSync(process.execPath, [path.join(__dirname, 'md2wechat.js'), dateStr], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'build-daily.js')], { stdio: 'inherit' });
  console.log('完成');
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
