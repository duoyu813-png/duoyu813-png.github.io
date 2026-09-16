#!/usr/bin/env node
/**
 * send-mail.js — 把某天的「本草日课」通过 SMTP 发到邮箱（供 GitHub Actions 每天调用）
 *
 * 依赖：只用 Node 内置模块，无需 npm install。
 *
 * 环境变量（在仓库 Secrets 里配置）：
 *   MAIL_USER   发件邮箱（如 xxxx@qq.com / xxxx@foxmail.com）  —— 必填
 *   MAIL_PASS   邮箱「SMTP 授权码」（不是登录密码！）        —— 必填
 *   MAIL_TO     收件邮箱，默认 baibai159@foxmail.com
 *   MAIL_FROM   发件人地址，默认 = MAIL_USER
 *   MAIL_HOST   SMTP 服务器，默认 smtp.qq.com
 *   MAIL_PORT   端口，默认 465（SSL）。填 587 时自动走 STARTTLS
 *   SITE_URL    邮件底部站点链接，默认 https://duoyu813-png.github.io/bencao-shiyi/
 *
 * 用法：
 *   node tools/send-mail.js                # 发今天（北京时间）的文章
 *   node tools/send-mail.js 2026-09-16     # 发指定日期
 *   DRY_RUN=1 node tools/send-mail.js      # 只组装不发信，用于排查
 */

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const DAILY = path.join(ROOT, 'daily');

const HOST = process.env.MAIL_HOST || 'smtp.qq.com';
const PORT = Number(process.env.MAIL_PORT || 465);
const USER = process.env.MAIL_USER || '';
const PASS = process.env.MAIL_PASS || '';
const FROM = process.env.MAIL_FROM || USER;
const TO = process.env.MAIL_TO || 'baibai159@foxmail.com';
const SITE_URL = process.env.SITE_URL || 'https://duoyu813-png.github.io/bencao-shiyi/';

/* ---------- 日期 ---------- */
function pickDate() {
  const arg = process.argv[2];
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ---------- 解析 ---------- */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  m[1].split(/\r?\n/).forEach(line => {
    const kv = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  });
  return { meta, body: m[2] };
}

// 正文 HTML 优先用公众号排版稿（样式完整），取不到再退化成纯文本段落
function contentHtml(date) {
  const wechat = path.join(DAILY, date + '-wechat.html');
  if (fs.existsSync(wechat)) {
    const html = fs.readFileSync(wechat, 'utf8');
    const m = html.match(/<div class="phone" id="article">([\s\S]*?)\n<\/div>/);
    if (m) return m[1].trim();
  }
  return '';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bodyFromMarkdown(md) {
  return md.replace(/\r\n/g, '\n').split('\n').map(line => {
    const l = line.trim();
    if (!l) return '';
    if (/^#{1,3}\s+/.test(l)) return '<h2 style="color:#7a5a3a;">' + escapeHtml(l.replace(/^#{1,3}\s+/, '')) + '</h2>';
    if (/^→\s*/.test(l)) return '<p style="background:#faf6ef;border:1px solid #e3d3b8;border-radius:6px;padding:12px 14px;">' + escapeHtml(l.replace(/^→\s*/, '')) + '</p>';
    if (/^>\s?/.test(l)) return '<blockquote style="border-left:3px solid #c9a36a;color:#6b6b6b;margin:16px 0;padding:6px 14px;">' + escapeHtml(l.replace(/^>\s?/, '')) + '</blockquote>';
    return '<p style="line-height:1.85;color:#3f3f3f;">' + escapeHtml(l) + '</p>';
  }).join('\n');
}

/* ---------- 组装邮件 ---------- */
function buildMessage(date, meta, html) {
  const title = meta['标题'] || '本草日课 ' + date;
  const jieqiName = String(meta['节气'] || '').replace(/[（(].*$/, '').trim();
  const subject = '【本草日课】' + title + (jieqiName ? ' · ' + jieqiName : '');

  const chips = [date, meta['节气'], meta['选题类型'], meta['主角药材'] ? '主角：' + meta['主角药材'] : '']
    .filter(Boolean).map(escapeHtml).join(' · ');

  const page =
    '<div style="max-width:640px;margin:0 auto;font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;">' +
    '<div style="padding:14px 16px;background:#f6f1e7;border-radius:8px;font-size:13px;color:#8c8c8c;text-align:center;">本草日课 · ' + chips + '</div>' +
    '<div style="padding:22px 18px;background:#fff;color:#3f3f3f;">' + html + '</div>' +
    '<div style="padding:14px 16px;font-size:12px;line-height:1.7;color:#9a9a9a;border-top:1px solid #ece5d8;">' +
    '本草拾遗 · 中医食疗检索　<a href="' + SITE_URL + '" style="color:#a9743b;">' + SITE_URL + '</a><br>' +
    '本邮件由 GitHub Actions 自动发送。</div>' +
    '</div>';

  const headers = [
    'From: ' + encodeWord('本草日课') + ' <' + FROM + '>',
    'To: <' + TO + '>',
    'Subject: ' + encodeWord(subject),
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ].join('\r\n');

  const encodedBody = Buffer.from(page, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return { subject, raw: headers + '\r\n\r\n' + encodedBody + '\r\n' };
}

function encodeWord(s) {
  return '=?UTF-8?B?' + Buffer.from(String(s), 'utf8').toString('base64') + '?=';
}

/* ---------- 极简 SMTP 客户端 ---------- */
function connect() {
  return new Promise((resolve, reject) => {
    const sock = PORT === 465
      ? tls.connect({ host: HOST, port: PORT, servername: HOST }, () => resolve(sock))
      : net.connect({ host: HOST, port: PORT }, () => resolve(sock));
    sock.setTimeout(30000, () => reject(new Error('SMTP 连接超时')));
    sock.once('error', reject);
  });
}

function session(sock) {
  let buf = '';
  let pending = null;

  function tryResolve() {
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const consumed = lines.slice(0, i + 1).join('\r\n') + '\r\n';
        buf = buf.slice(consumed.length);
        const resolve = pending;
        pending = null;
        resolve({ code: parseInt(lines[i].slice(0, 3), 10), text: lines.slice(0, i + 1).join('\n') });
        return;
      }
    }
  }

  sock.on('data', chunk => { buf += chunk.toString('utf8'); if (pending) tryResolve(); });

  return {
    read: () => new Promise(resolve => { pending = resolve; tryResolve(); }),
    write: s => sock.write(s)
  };
}

async function step(cli, cmd, expect) {
  if (cmd !== null) cli.write(cmd + '\r\n');
  const r = await cli.read();
  if (expect && String(r.code)[0] !== String(expect)[0]) {
    throw new Error('SMTP 响应异常 ' + r.code + '：' + r.text);
  }
  return r;
}

async function send(raw) {
  let sock = await connect();
  try {
    let cli = session(sock);
    await step(cli, null, 2);                       // 220 greeting
    await step(cli, 'EHLO bencao-shiyi', 2);        // 250
    if (PORT !== 465) {
      await step(cli, 'STARTTLS', 2);               // 220
      const secure = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: HOST }, () => resolve(s));
        s.once('error', reject);
      });
      sock = secure;
      cli = session(sock);
      await step(cli, 'EHLO bencao-shiyi', 2);
    }
    await authenticate(cli);
    await deliver(cli, raw);
  } finally {
    try { sock.end(); } catch (e) { /* ignore */ }
  }
}

async function authenticate(cli) {
  await step(cli, 'AUTH LOGIN', 3);                 // 334
  await step(cli, Buffer.from(USER, 'utf8').toString('base64'), 3);
  await step(cli, Buffer.from(PASS, 'utf8').toString('base64'), 2); // 235
}

async function deliver(cli, raw) {
  await step(cli, 'MAIL FROM:<' + FROM + '>', 2);
  await step(cli, 'RCPT TO:<' + TO + '>', 2);
  await step(cli, 'DATA', 3);                       // 354
  cli.write(raw.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
  await step(cli, null, 2);                         // 250
  await step(cli, 'QUIT', 2);
}

/* ---------- 主流程 ---------- */
(async () => {
  const date = pickDate();
  const mdPath = path.join(DAILY, date + '.md');
  if (!fs.existsSync(mdPath)) {
    console.error('找不到 ' + mdPath + '，跳过发信');
    process.exit(0);
  }

  const { meta, body } = parseFrontmatter(fs.readFileSync(mdPath, 'utf8'));
  const html = contentHtml(date) || bodyFromMarkdown(body.replace(/^#\s+.*\r?\n/, ''));
  const { subject, raw } = buildMessage(date, meta, html);

  if (process.env.DRY_RUN === '1') {
    console.log('DRY_RUN：主题「' + subject + '」，报文 ' + raw.length + ' 字节，未发送');
    return;
  }

  if (!USER || !PASS) {
    console.error('未配置 MAIL_USER / MAIL_PASS，跳过发信（站点已正常更新）');
    process.exit(0);
  }

  console.log('发送邮件 → ' + TO + '，主题「' + subject + '」');
  await send(raw);
  console.log('✓ 邮件已发送');
})().catch(e => {
  console.error('✗ 发信失败：' + e.message);
  process.exit(1);
});
