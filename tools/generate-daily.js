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

/* 选题类型（13 类，轮转时按最近用过的自动避开）。
   ⚠ 注意：pickType 只从这个数组选，若想发专题分析必须出现在这里。 */
const TYPES = [
  '症状自救', '误区纠偏', '对照鉴别', '体质辨识',
  '单味药材深讲', '应季食材', '节气养生', '古籍今读',
  '场景养生', '食疗方详解', '药材鉴别挑选', '热点辨析',
  '专题分析'
];

/* 需要配「主题」的类型：围绕一个具体健康问题展开 */
const TOPIC_TYPES = ['症状自救', '误区纠偏', '对照鉴别', '体质辨识', '专题分析'];

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
  { name: '脾虚食少', keys: ['健脾', '脾虚', '食少', '便溏', '运化'] },
  { name: '腹泻便溏', keys: ['止泻', '健脾', '渗湿', '久泻'] },
  { name: '手脚冰凉', keys: ['温阳', '散寒', '四肢不温', '阳虚'] },
  { name: '月经不调', keys: ['调经', '活血', '痛经', '血虚'] },
  { name: '水肿虚胖', keys: ['利水', '消肿', '健脾', '痰湿'] },
  { name: '食欲不振', keys: ['消食', '开胃', '健脾', '食积'] },
  { name: '口臭口苦', keys: ['清热', '化湿', '清肝', '胃热'] },
  { name: '脱发早白', keys: ['补肝肾', '益精血', '乌须发', '填精'] },
  { name: '腰膝酸软', keys: ['补肝肾', '强筋骨', '腰痛', '益精'] },
  { name: '换季过敏', keys: ['祛风', '止痒', '解表', '卫气'] },
  { name: '饭后犯困', keys: ['健脾', '化湿', '益气', '升清'] },
  { name: '口腔溃疡', keys: ['清热', '泻火', '口疮', '解毒'] },
  { name: '夜尿频多', keys: ['补肾', '固涩', '缩尿', '益肾'] },
  { name: '情绪烦躁', keys: ['疏肝', '解郁', '理气', '调畅情志'] },
  { name: '上火牙痛', keys: ['清热', '泻火', '牙痛', '胃火'] },
  { name: '久坐腰酸', keys: ['强筋骨', '活血', '通络', '腰背'] },
  { name: '气血不足', keys: ['补气', '养血', '血虚', '面色萎黄'] },
  { name: '脾胃虚寒', keys: ['温中', '散寒', '脾胃虚寒', '脘腹冷痛'] },
  { name: '入夜盗汗', keys: ['滋阴', '敛汗', '阴虚', '虚热'] }
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
  // 历史里的类型可能带括号后缀（如「专题分析（秋乏辨证分型）」），先归一化再去重
  const norm = t => String(t || '').replace(/[（(].*$/, '').trim();
  const recent = new Set(recentTypes.map(norm).filter(Boolean).slice(0, 2));
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

/* 每类选题一套结构与开篇指令。
   注意：开篇一律从具体场景/说法/痛点切入，不得要求"从节气切入"。 */
function structureFor(type, dateStr, topic) {
  const T = topic ? topic.name : '';
  const S = {
    '症状自救': [
      '# 标题',
      `开篇 1–2 段，直接描写一个具体的生活场景或身体感受（某个时刻、某个动作），自然引出「${T}」，约 150 字。`,
      `## ${T}，先分清是哪一型`,
      '用 2–3 个常见证型讲清楚：每一型的诱因、典型表现（尽量点出舌象或伴随症状）。约 300 字。',
      '## 对证的食疗方',
      '→ 方名：组成（写清用量）；制法；适合哪一型',
      '→ 方名：组成（写清用量）；制法；适合哪一型',
      '## 日常预防与调理',
      '给 3 条能马上做的建议：起居作息、穴位（写清位置与按法）、情志或运动。约 200 字。',
      '## 禁忌提醒',
      '写清哪些情况不能只靠食疗、必须及时就医。约 120 字。'
    ],
    '误区纠偏': [
      '# 标题',
      '开篇 1–2 段，先摆出这个流传很广的说法或做法，再点出它的问题，约 150 字。',
      '## 这个说法错在哪',
      '讲清错在哪一层、它为什么会流传开，再讲真正的中医道理。约 280 字。',
      '## 正确的做法是什么',
      '给出正确的认识和当天就能改的具体动作。约 200 字。',
      '## 两道方子',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '## 禁忌提醒',
      '写清哪些人不适合、什么情况要就医。约 120 字。'
    ],
    '对照鉴别': [
      '# 标题',
      '开篇 1–2 段，描写一个让人分不清的具体情形，约 150 字。',
      '## 两者到底差在哪',
      '从病因、典型表现、舌象脉感逐项对比，务必给出 1–2 个"看一眼就能分"的判断要点。约 300 字。',
      '## 各自的用法',
      '分别给适合的做法。',
      '→ 方名：组成（写清用量）；制法；适合前者',
      '→ 方名：组成（写清用量）；制法；适合后者',
      '## 用反了会怎样',
      '讲清用错的后果与纠偏办法。约 150 字。',
      '## 禁忌提醒',
      '约 120 字。'
    ],
    '体质辨识': [
      '# 标题',
      '开篇 1–2 段，描写一组典型表现让读者对号入座，约 150 字。',
      '## 怎么判断你属不属于',
      '列出可自查的要点：舌象、二便、寒热偏好、精神状态等。约 250 字。',
      '## 这类体质该怎么调',
      '讲清调理思路与常见误区。约 200 字。',
      '## 两道方子',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '## 禁忌提醒',
      '约 120 字。'
    ],
    '单味药材深讲': [
      '# 标题',
      '开篇 1–2 段，从一个反常识的点或具体使用场景切入，约 150 字。',
      '## 它到底是什么',
      '讲清药性、归经、功效，以及上面给到的古籍依据。约 220 字。',
      '## 两道方子',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '## 怎么吃更合适',
      '讲清与当季食材的搭配、吃的频次与时机。约 180 字。',
      '## 除了吃，还要注意',
      '给 2–3 条起居、穴位或预防建议。约 160 字。',
      '## 禁忌提醒',
      '写清哪些人不能吃、慎吃。约 120 字。'
    ],
    '应季食材': [
      '# 标题',
      '开篇 1–2 段，从菜市场或餐桌上的一个具体场景切入，顺带纠一个常见误区，约 150 字。',
      '## 为什么现在正当令',
      '讲清当季的道理，顺手纠正一个流传的误传。约 220 字。',
      '## 它到底是什么',
      '讲清性味归经、功效与古籍依据。约 220 字。',
      '## 两道方子',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '## 禁忌提醒',
      '写清哪些人不能吃、慎吃。约 120 字。'
    ],
    '节气养生': [
      '# 标题',
      '开篇 1–2 段，从这几天身体上的具体感受切入（不要以节气名为题，不要写"XX节气到了"这类套话），约 150 字。',
      '## 这几天身体在发生什么',
      '讲清当前时令对应的身体变化与高发不适。约 250 字。',
      '## 调养重点',
      '从起居、饮食、情志三方面讲，各给具体动作。约 220 字。',
      '## 两道方子',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '## 禁忌提醒',
      '约 120 字。'
    ],
    '古籍今读': [
      '# 标题',
      '开篇直接引出那句古文并标注出处，约 120 字。',
      '## 原文',
      '照录原文并写明出处（只可引用下方给定的药材资料里的古籍）。约 80 字。',
      '## 这话到底什么意思',
      '用大白话逐句翻一遍，不许甩完原文就走。约 280 字。',
      '## 今天怎么用得上',
      '落到现代生活的具体做法，讲清能改什么。约 250 字。',
      '## 两道方子',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '## 禁忌提醒',
      '约 120 字。'
    ],
    '场景养生': [
      '# 标题',
      '开篇 1–2 段，直接描写那个场景本身（如熬夜后的早晨、应酬完的第二天），约 150 字。',
      '## 这时候身体在经历什么',
      '讲清背后的机制，不要只讲症状。约 220 字。',
      '## 当天就能做的补救',
      '按时间顺序给具体动作（几点做什么、吃什么、按哪个穴）。约 250 字。',
      '## 两道方子',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '## 禁忌提醒',
      '约 120 字。'
    ],
    '食疗方详解': [
      '# 标题',
      '开篇 1–2 段，从一个适用人群或场景切入，约 120 字。',
      '## 这个方子适合谁',
      '讲清适用的证型与人群，以及为什么对症。约 220 字。',
      '## 原方与加减',
      '写清组成用量，再给 2–3 种常见情况的加减变化。约 250 字。',
      '## 怎么做得更到位',
      '讲清制法细节、服用时机与频次。约 180 字。',
      '## 哪些人不适合',
      '约 120 字。'
    ],
    '药材鉴别挑选': [
      '# 标题',
      '开篇 1–2 段，从"买到假货/不会挑/放坏了"的具体痛点切入，约 150 字。',
      '## 好坏到底差在哪',
      '讲清评判标准与常见伪品、劣品的坑。约 250 字。',
      '## 四步挑到好的',
      '按看、闻、摸、尝分别给出可操作的判断方法。约 250 字。',
      '## 怎么存才不坏',
      '讲清储存条件与保质期。约 120 字。',
      '## 两道方子',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '## 禁忌提醒',
      '约 120 字。'
    ],
    '热点辨析': [
      '# 标题',
      '开篇 1–2 段，直接摆出那个正在流传的说法，约 150 字。',
      '## 这个说法哪来的',
      '讲清来源与流传背景。约 150 字。',
      '## 哪些有道理，哪些是误传',
      '分开辨析，不要一棍子打死也不要全盘认同。约 300 字。',
      '## 正确的做法',
      '约 180 字。',
      '## 两道方子',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '→ 方名：组成（写清用量）；制法；适合人群',
      '## 禁忌提醒',
      '约 120 字。'
    ],
    '专题分析': [
      '# 标题',
      `开篇 1–2 段，从一个具体场景切入，自然引出「${T}」，约 150 字。`,
      `## ${T}，先分清是哪一型`,
      '用 2–3 个常见证型讲清楚：每一型的诱因、典型表现（尽量点出舌象或伴随症状）。约 300 字。',
      '## 对证的食疗方',
      '→ 方名：组成（写清用量）；制法；适合哪一型',
      '→ 方名：组成（写清用量）；制法；适合哪一型',
      '## 日常预防与调理',
      '给 3 条能马上做的建议：起居作息、穴位（写清位置与按法）、情志或运动。约 200 字。',
      '## 禁忌提醒',
      '写清哪些情况不能只靠食疗、必须及时就医。约 120 字。'
    ]
  };
  return S[type] || S['单味药材深讲'];
}

function buildMessages(dateStr, jq, herb, type, hot, topic) {
  const system = [
    '你是「本草拾遗」的中医食疗专栏作者，文风：口语、克制、有据可查，不夸大、不恐吓。',
    '只用药食同源知识，不得做医疗诊断、不得开处方、不得承诺疗效；需要就医的情况要明确提示就医。',
    '禁止编造古籍原文与出处；引用只能来自下方给定的「药材资料」，引用不到的不要写。',
    '严禁编造新闻、数据、专家姓名与媒体名称；热点只能化用下方给出的资讯，不得杜撰细节。',
    '下方「近期资讯」仅作背景参考：与今天的节气或药材相关才可引用，不相关就完全忽略，绝不生硬硬蹭。',
    '全文约 1000–1200 字，简体中文。',
    '',
    '【开篇规则·重要】开篇必须从具体的人、场景、感受、说法切入——一个动作、一个时刻、一句常听到的话、',
    '一个反常现象。禁止以节气名、季节名、"最近""进入XX之后"这类时间套话开篇，',
    '节气最多在文中自然提一句，不得主导开头。',
    '【不同类型要有不同味道】写了「应季食材」就围绕食材本身与当令道理；',
    '写了「专题分析/症状自救」就围绕那个症状、证型与对证吃法；',
    '写了「热点辨析」就围绕那个说法辨析；不要把每种类型都写成"XX时节养生"。',
    '',
    '【标题规则·重要】标题要具体到一眼看出这篇讲什么，禁止以下套路：',
    '① 以节气名或季节名开头（如「白露…」「秋分这天…」「明天寒露…」）；',
    '② 「XX别急着…」「XX不是XX」这类句式；',
    '③ 空泛的感悟、感叹，或看不出内容的文艺腔；',
    '④ 千篇一律的「XX时节话XX / XX安神正当时」式套话。',
    '优先用这几种：痛点提问（「睡够 8 小时还是困，问题可能不在觉而在脾」）、',
    '敢下判断的反常识断言（「长期喝粥不养胃，反而可能把胃养懒」）、',
    '对照结构（「风寒风热都咳嗽，看一眼痰的颜色就分得清」）、',
    '具体场景代入（「应酬回来舌苔厚得像铺了层毯子」）、数字或期限（「连喝三天，先把脾的堵通开」）。'
  ].join('\n');

  const mb = (herb.recipes || []).map(r => `- ${r.name}｜组成：${r.material}｜制法：${r.method}｜效用：${r.effect}`).join('\n');
  const classic = (herb.classic || []).map(c => `《${c.book}》：${c.text}`).join('\n');

  const hotText = (hot && hot.items && hot.items.length)
    ? ('【近期养生资讯（来自' + hot.source + '）·仅作背景参考，相关才用、不相关请完全忽略，不要硬蹭】\n' + (hot.answer ? '摘要：' + hot.answer + '\n' : '') +
       hot.items.map(i => `- ${i.title}${i.date ? '（' + i.date + '）' : ''}${i.url ? ' ' + i.url : ''}\n  ${i.content}`).join('\n'))
    : '【近期热点】无（未取到），请纯以节气与药材知识切入。';

  const typeHasTopic = TOPIC_TYPES.includes(type);
  const topicLine = (typeHasTopic && topic)
    ? `【本次专题】${topic.name}——按照上面「${type}」的定位展开，先把分型与病因说清，再给对证的食疗与预防调理。`
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
    '症状自救': '针对一个具体症状讲清常见证型分型，给对证的居家处理。痛点感强，不做诊断、不承诺疗效',
    '误区纠偏': '纠正一个流传很广的错误说法，先摆出这个说法，再讲清错在哪、正确的是什么',
    '对照鉴别': '辨析两个容易混淆的概念/药材/证型，讲清怎么区分、各自怎么用',
    '体质辨识': '从一个体质的典型表现入手，讲怎么判断、日常怎么调',
    '单味药材深讲': '讲透一味药材的性味归经、功效、古籍依据与用法',
    '应季食材': '从当下当令的一味食材讲起，纠正一个常见误区',
    '节气养生': '讲清这个节气的身体变化与调养重点，药材是落点（每月最多 2 次）',
    '古籍今读': '拎一句经典原文，讲它在今天怎么用',
    '场景养生': '针对一个具体生活场景（熬夜后、应酬后、换季、久坐等）讲当天能做的调理',
    '食疗方详解': '一个方子讲透：组成用量、加减变化、适合与不适合的人群',
    '药材鉴别挑选': '讲怎么挑好的、真假优劣怎么分、怎么储存',
    '热点辨析': '针对近期流传的养生说法，先摆出再辨析',
    '专题分析': '针对一个常见症状/体质做辨证分型，给出对证的吃法与预防调理'
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
  if (TOPIC_TYPES.includes(type)) {
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

  /* 检索词按选题类型分化，避免所有文章都被「节气」主导：
     专题/症状/误区类优先搜主题本身，节气养生才用节气名。 */
  const seasonalTypes = ['节气养生', '应季食材'];
  const lead = (topic ? topic.name : '') || (seasonalTypes.includes(type) ? jq.name + ' 养生' : herb.name + ' 养生');
  const query = (lead ? lead + ' ' : '') + '中医 食疗 调理';
  const hints = [topic ? topic.name : '', herb.name, jq.name, jq.name + ' 养生', '养生', '食疗'].filter(Boolean);
  let hot = null;
  try {
    hot = await searchHot(query, hints);
    if (hot) console.log('热点源 ' + hot.source + '：' + hot.items.length + ' 条');
    else console.log('未取到热点，按纯"选题+药材"生成');
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
    fallbackTitle: `${herb.name}：${(topic ? topic.name + '的' : '')}日常调理`
  }), 'utf8');
  console.log('已写入 ' + path.relative(ROOT, mdPath));
  setOutput('generated=true');

  execFileSync(process.execPath, [path.join(__dirname, 'md2wechat.js'), dateStr], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'build-daily.js')], { stdio: 'inherit' });
  console.log('完成');
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
