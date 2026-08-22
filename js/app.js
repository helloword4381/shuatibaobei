/* app.js — 刷题大专家 主逻辑
 * 职责：视图路由、账号 UI、答题引擎、背题/错题、更新检测、云端同步调度
 * 依赖：db.js 提供 DB、store.js 提供 Store（均为全局变量）
 */

// ==================== 基础工具 ====================
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/** 创建元素；html 为 HTML 字符串，动态内容必须先经 esc() 转义 */
const el = (t, cls, html) => {
  const e = document.createElement(t);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

/** HTML 转义：题库/用户输入/云端返回的数据拼进 innerHTML 前必须经过它 */
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}

// ==================== 视图路由 ====================
// 视图名 → 底部 tab 名（无对应 tab 的页面不映射）
const TAB_OF_VIEW = { home: 'home', practice: 'practice', 'wrong-book': 'wrong-book', memorize: 'memorize' };

function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  if (name !== 'login') { // 登录页保持当前 tab 高亮不变
    const tab = TAB_OF_VIEW[name] || null;
    $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  }
  window.scrollTo(0, 0);
}

/** 题型中文标签（type 与 source_type 通用） */
function typeLabel(t) {
  return { single: '单选', multiple: '多选', judge: '判断', short: '简答', short_multi: '简答' }[t] || t;
}

// ==================== 账号 UI（登录 / 注册 / 切换） ====================
let LOGIN_MODE = 'login'; // 'login' | 'register'

function updateUserTag() {
  const tag = $('#user-tag');
  const u = Store.who();
  if (u) { tag.style.display = ''; tag.textContent = '👤 ' + u; tag.title = '当前账号：' + u; }
  else { tag.style.display = 'none'; }
}

function setLoginMode(mode) {
  LOGIN_MODE = mode;
  $$('#view-login .chip[data-mode]').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
  $('#acc-submit').textContent = mode === 'login' ? '登 录' : '注 册 并 登 录';
  if (mode === 'register' && !$('#acc-user').value.trim()) $('#acc-pwd').value = '';
}

$$('#view-login .chip[data-mode]').forEach(c => c.onclick = () => setLoginMode(c.dataset.mode));

async function submitAccount() {
  const u = $('#acc-user').value.trim();
  const p = $('#acc-pwd').value;
  const rem = $('#acc-remember').checked;
  const btn = $('#acc-submit');
  btn.disabled = true;
  try {
    if (LOGIN_MODE === 'register') {
      await Store.register(u, p);
      toast('注册成功，已登录');
    } else {
      await Store.login(u, p, rem);
      toast('登录成功：' + u);
    }
    startCloudPushTimer();      // 登录成功后启动 60s 云端定时推送
    updateUserTag();
    renderAccountSwitcher();
    renderHome();
    showView('home');
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    btn.disabled = false;
  }
}
$('#acc-submit').onclick = submitAccount;

$('#acc-skip').onclick = () => {
  Store.switchUser(null); // 访客身份
  updateUserTag();
  renderAccountSwitcher();
  renderHome();
  showView('home');
  toast('访客模式：不会保存长期进度');
};

function renderAccountSwitcher() {
  const wrap = $('#account-switcher');
  const accounts = Store.listAccounts();
  if (!accounts.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';
  wrap.appendChild(el('div', 'sw-title', '快速切换已保存账号：'));
  const list = el('div', 'sw-list');
  accounts.forEach(name => {
    const chip = el('span', 'sw-chip', `<span>👤 ${esc(name)}</span>`);
    chip.onclick = () => {
      // 本地已保存的账号可直接切换（信任本机）；无密码校验，见审查报告说明
      if (Store.who() === name) { toast('已是当前账号'); return; }
      try {
        Store.switchUser(name);
        updateUserTag(); renderHome(); toast('已切换到：' + name); showView('home');
      } catch (e) {
        // 回退：把用户名填进表单，要求输入密码
        $('#acc-user').value = name; $('#acc-pwd').value = '';
        $('#acc-pwd').focus();
        toast('请输入密码以切换账号');
      }
    };
    list.appendChild(chip);
  });
  wrap.appendChild(list);
}

// ==================== 云端同步调度（每 60s 推送一次） ====================
let CLOUD_PUSH_TIMER = null;
let CLOUD_LAST = { at: null, ok: null, msg: '' };

function stopCloudPushTimer() {
  if (CLOUD_PUSH_TIMER) { clearInterval(CLOUD_PUSH_TIMER); CLOUD_PUSH_TIMER = null; }
}

function startCloudPushTimer() {
  stopCloudPushTimer();
  if (!Store.cloudEnabled || !Store.cloudEnabled()) return;
  // 登录成功后先推一次，避免干等 60s
  setTimeout(async () => {
    const r = await Store.cloudPushNow();
    CLOUD_LAST = { at: Date.now(), ok: !!r.ok, msg: r.ok ? '首次自动同步成功' : (r.reason || '云端可能暂不可用') };
    refreshCloudStatus();
  }, 800);
  CLOUD_PUSH_TIMER = setInterval(async () => {
    if (!Store.who()) return;
    const r = await Store.cloudPushNow();
    CLOUD_LAST = { at: Date.now(), ok: !!r.ok, msg: r.ok ? '已同步' : ((r.reason || '') + (r.error ? ': ' + String(r.error.message || r.error) : '')) };
    refreshCloudStatus();
  }, 60 * 1000);
}

function refreshCloudStatus() {
  const state = $('#me-cloud-detail');
  if (!state) return;
  if (!Store.cloudEnabled || !Store.cloudEnabled()) { state.textContent = '未启用（本地模式）'; return; }
  if (!Store.who()) { state.textContent = '未登录'; return; }
  const s = CLOUD_LAST;
  if (!s.at) { state.textContent = '已就绪，约每 60 秒自动同步一次'; return; }
  const t = new Date(s.at);
  const ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
  const icon = s.ok ? '✅' : '❌';
  const color = s.ok ? 'var(--accent2)' : 'var(--danger)';
  state.innerHTML = `<span style="color:${color}">${icon} ${ts} ${esc(s.msg || (s.ok ? '成功' : '失败'))}</span>`;
}

// ==================== 启动流程 ====================
function setSplash(m) { $('#splash-text').textContent = m; }

async function boot() {
  try {
    setSplash('正在加载题库…');
    const r = await DB.init(setSplash);
    $('#db-version').textContent = 'v' + (r.version || 'local');

    const auto = Store.autoLogin();
    if (auto) {
      toast('已自动登录：' + auto.username);
      // 自动登录后立刻拉一次云端进度（其他设备可能有更新），再启动定时推送
      if (Store.cloudEnabled && Store.cloudEnabled()) {
        try {
          const p = await Store.cloudPullNow();
          CLOUD_LAST = { at: Date.now(), ok: !!p.ok, msg: p.ok ? (p.nothing ? '自动登录：云端暂无新进度' : '自动登录：已合并云端进度') : '自动登录：同步失败，将用本地进度' };
        } catch (_) {}
      }
      startCloudPushTimer();
      updateUserTag();
      renderAccountSwitcher();
      renderHome();
      showView('home');
    } else {
      const rem = Store.rememberUsername();
      if (rem) $('#acc-user').value = rem;
      updateUserTag();
      renderAccountSwitcher();
      // 未登录也进首页（访客模式可刷题，云同步时提示登录）
      renderHome();
      showView('home');
    }

    checkForUpdates(false); // 非阻塞检查更新
  } catch (e) {
    setSplash('题库加载失败：' + (e.message || e));
  }
}

// ==================== 题库更新检测 ====================
async function checkForUpdates(force) {
  try {
    const { hasUpdate, remote, local } = await DB.checkUpdate();
    if (hasUpdate) {
      $('#update-desc').innerHTML =
        `新版本 <b>v${esc(remote.version)}</b> 已发布<br>题量：${esc(remote.question_count)} 题<br>当前：v${esc(local || '无')}`;
      $('#update-modal').classList.remove('hidden');
    } else if (force) {
      toast('题库已是最新版本 v' + (local || remote.version));
    }
  } catch (e) {
    if (force) toast('检查更新失败（网络）');
  }
}

$('#btn-sync').onclick = () => checkForUpdates(true);
$('#update-later').onclick = () => $('#update-modal').classList.add('hidden');
$('#update-now').onclick = async () => {
  try {
    setSplash('正在下载新题库…');
    $('#view-splash').classList.add('active');
    showView('splash');
    let prog = 0;
    const v = await DB.downloadUpdate(null, p => { if (p !== prog) { prog = p; setSplash('下载中 ' + p + '%'); } });
    $('#db-version').textContent = 'v' + v;
    $('#update-modal').classList.add('hidden');
    toast('题库已更新到 v' + v);
    renderHome();
    showView('home');
  } catch (e) {
    toast('下载失败：' + (e.message || e));
    showView('home');
  }
};

// ==================== 首页 ====================
function renderHome() {
  const gs = Store.globalStats();
  gs.total = DB.total();
  const banks = DB.listBanks();

  $('#home-stats').innerHTML = `
    <div class="stat-card"><div class="num">${gs.total}</div><div class="lbl">总题数</div></div>
    <div class="stat-card green"><div class="num">${gs.answered}</div><div class="lbl">已练习</div></div>
    <div class="stat-card orange"><div class="num">${gs.rate}%</div><div class="lbl">正确率</div></div>
    <div class="stat-card"><div class="num">${gs.wrong}</div><div class="lbl">错题</div></div>`;
  $('#wrong-count-desc').textContent = Store.wrongCount() + ' 道错题';

  $('#bank-list').innerHTML = banks.map(b => {
    const rows = DB.exec("SELECT type, COUNT(*) c FROM questions WHERE bank=? GROUP BY type", [b.bank]);
    let n = 0; const parts = [];
    for (const r of rows) { n += r.c; parts.push(typeLabel(r.type) + r.c); }
    const bs = Store.bankStats(b.bank);
    const pct = bs.answered ? Math.min(100, Math.round(bs.answered / n * 100)) : 0;
    return `<div class="list-item">
      <div class="li-ic">📘</div>
      <div class="li-main">
        <div class="li-title">${esc(b.title)}</div>
        <div class="li-sub">${n} 题 · ${esc(parts.join(' / '))}</div>
        <div class="progress-mini"><i style="width:${pct}%"></i></div>
      </div>
      <div class="li-right">${bs.rate || 0}%</div>
    </div>`;
  }).join('');
}

// ==================== 配置页（刷题前选择） ====================
const SETUP = { mode: 'practice', types: ['single', 'multiple', 'judge', 'short'], order: 'seq', count: 20, bank: '' };

function openSetup(mode) {
  SETUP.mode = mode; SETUP.bank = '';
  const titles = { practice: '刷题练习', smart: '智能练题', exam: '模拟考试', memorize: '背题模式' };
  $('#setup-title').textContent = titles[mode] || '刷题';

  const banks = [{ bank: '', title: '全部题库' }].concat(DB.listBanks());
  $('#setup-bank').innerHTML = banks.map(b => `<option value="${esc(b.bank)}">${esc(b.title)}</option>`).join('');

  // 简答题仅在背题模式可选；刷题/智能/模拟只出选择判断题
  const isMemorize = mode === 'memorize';
  const types = isMemorize ? ['single', 'multiple', 'judge', 'short'] : ['single', 'multiple', 'judge'];
  // 非背题模式强制去掉简答
  if (!isMemorize) SETUP.types = SETUP.types.filter(t => t !== 'short');
  // 背题模式显示简答题提示
  $('#setup-short-hint').classList.toggle('hidden', !isMemorize);
  $('#setup-types').innerHTML = types.map(t =>
    `<span class="chip ${mode === 'exam' || SETUP.types.includes(t) ? 'active' : ''}" data-val="${t}">${typeLabel(t)}</span>`).join('');
  $$('#setup-types .chip').forEach(c => c.onclick = () => c.classList.toggle('active'));

  $$('#setup-order .chip').forEach(c => c.classList.toggle('active', c.dataset.val === SETUP.order));
  $$('#setup-order .chip').forEach(c => c.onclick = () => {
    $$('#setup-order .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    SETUP.order = c.dataset.val;
  });

  const cnt = $('#setup-count');
  cnt.value = mode === 'exam' ? 50 : SETUP.count;
  $('#setup-count-val').textContent = cnt.value;
  cnt.oninput = () => $('#setup-count-val').textContent = cnt.value;

  // 模拟考试不展示"出题方式"（固定随机）
  const orderHidden = mode === 'exam';
  $('#setup-order').style.display = orderHidden ? 'none' : '';
  $('#label-order').style.display = orderHidden ? 'none' : '';

  showView('setup');
}

$('#setup-start').onclick = () => {
  SETUP.bank = $('#setup-bank').value;
  SETUP.types = $$('#setup-types .chip.active').map(c => c.dataset.val);
  SETUP.count = +$('#setup-count').value;
  if (!SETUP.types.length && SETUP.mode !== 'exam') { toast('请至少选择一种题型'); return; }

  if (SETUP.mode === 'memorize') { startMemorize(); return; }

  let qs;
  if (SETUP.mode === 'smart') {
    // 智能练题：先取出全部候选题 id，按历史正确率加权抽取
    const all = DB.pickQuestions({ bank: SETUP.bank || null, limit: 99999 });
    const ids = all.map(q => q.id);
    const picked = Store.pickWeighted(ids, Math.min(SETUP.count, ids.length));
    qs = DB.byIds(picked);
  } else if (SETUP.mode === 'exam') {
    SETUP.types = ['single', 'multiple', 'judge']; // 模拟考试不含简答题
    qs = DB.pickQuestions({ bank: null, types: SETUP.types, order: 'rand', limit: SETUP.count });
  } else {
    qs = DB.pickQuestions({ bank: SETUP.bank || null, types: SETUP.types, order: SETUP.order, limit: SETUP.count });
  }
  if (!qs.length) { toast('没有符合条件的题目'); return; }
  startQuiz(qs);
};

// ==================== 答题引擎 ====================
const QUIZ = { qs: [], idx: 0, sel: {}, results: [], wrongs: [] };
// qs: 题目数组；idx: 当前题号；sel: {idx: {sel:[], submitted}}
// results: {idx: boolean}；wrongs: 本次答错的题目 id 列表

function startQuiz(qs) {
  QUIZ.qs = qs; QUIZ.idx = 0; QUIZ.sel = {}; QUIZ.results = []; QUIZ.wrongs = [];
  renderQuiz();
  showView('quiz');
  ensureAnswerSheet(); // PC 端答题卡
}

/** 宽屏(≥1100px)时在答题页插入答题卡 DOM */
function ensureAnswerSheet() {
  if (window.innerWidth < 1100) return;
  let sheet = document.querySelector('.answer-sheet');
  if (!sheet) {
    sheet = el('div', 'answer-sheet');
    const foot = $('#view-quiz .quiz-foot');
    $('#view-quiz').insertBefore(sheet, foot);
  }
  renderAnswerSheet();
}

function renderAnswerSheet() {
  const sheet = document.querySelector('.answer-sheet');
  if (!sheet) return;
  const correct = QUIZ.results.filter(Boolean).length;
  const wrong = QUIZ.results.filter(r => r === false).length;
  const done = QUIZ.results.length;
  const total = QUIZ.qs.length;
  sheet.innerHTML = `
    <h4>答题卡（${done}/${total}）</h4>
    <div class="as-summary">
      <span style="color:var(--accent2)">✓ ${correct}</span>
      <span style="color:var(--danger)">✗ ${wrong}</span>
      <span>未答 ${total - done}</span>
    </div>
    <div class="as-grid">${QUIZ.qs.map((q, i) => {
      const submitted = QUIZ.sel[i] !== undefined && QUIZ.sel[i].submitted;
      const res = QUIZ.results[i];
      let cls = 'as-cell';
      if (QUIZ.idx === i) cls += ' active';
      if (submitted) cls += res ? ' correct' : ' wrong';
      return `<div class="${cls}" data-i="${i}">${i + 1}</div>`;
    }).join('')}</div>`;
  $$('.answer-sheet .as-cell').forEach(c => c.onclick = () => {
    QUIZ.idx = +c.dataset.i;
    renderQuiz();
    $('#view-quiz').scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function renderQuiz() {
  const q = QUIZ.qs[QUIZ.idx];
  const total = QUIZ.qs.length;
  $('#qp-text').textContent = (QUIZ.idx + 1) + ' / ' + total;
  $('#qp-fill').style.width = ((QUIZ.idx + 1) / total * 100) + '%';
  const correct = QUIZ.results.filter(Boolean).length;
  $('#quiz-score').textContent = correct + '/' + (QUIZ.idx + 1);
  $('#q-prev').style.visibility = QUIZ.idx === 0 ? 'hidden' : 'visible';

  // 保证当前题目的作答状态存在
  if (!QUIZ.sel[QUIZ.idx]) QUIZ.sel[QUIZ.idx] = { sel: [], submitted: false };
  const state = QUIZ.sel[QUIZ.idx];
  const submitted = state.submitted;

  const body = $('#quiz-body');
  body.innerHTML = '';

  const meta = el('div', 'q-meta');
  meta.innerHTML = `<span class="tag">${esc(q.bank_title)}</span><span>${typeLabel(q.type)}</span>`;
  body.appendChild(meta);

  body.appendChild(el('div', 'q-stem', esc(q.question)));

  let opts = q.options;
  if (q.type === 'judge') opts = [['T', '正确'], ['F', '错误']];
  const isMulti = q.type === 'multiple';
  opts.forEach(([k, txt]) => {
    const o = el('div', 'opt');
    const selected = state.sel.includes(k);
    if (selected) o.classList.add('selected');
    if (submitted) {
      if (q.answer.includes(k)) o.classList.add('correct');
      else if (selected) o.classList.add('wrong');
      o.classList.add('disabled');
    }
    o.innerHTML = `<div class="opt-key">${esc(k)}</div><div class="opt-txt">${esc(txt)}</div><div class="mark"></div>`;
    if (!submitted) o.onclick = () => {
      if (isMulti) {
        state.sel = state.sel.includes(k) ? state.sel.filter(x => x !== k) : [...state.sel, k];
      } else {
        state.sel = [k];
      }
      renderQuiz();
    };
    body.appendChild(o);
  });

  if (submitted) {
    const correctNow = QUIZ.results[QUIZ.idx];
    const ansText = q.answer.map(a => q.type === 'judge' ? (a === 'T' ? '正确' : '错误') : a).join('、');
    const an = el('div', 'analysis');
    an.innerHTML = `<div class="an-title">${correctNow ? '✓ 回答正确' : '✗ 回答错误'}</div>
      <div class="an-body"><b>正确答案：</b>${esc(ansText)}
      ${q.analysis ? '<br><b>参考解析：</b>' + esc(q.analysis) : ''}</div>`;
    body.appendChild(an);
  }

  $('#q-submit').classList.toggle('hidden', submitted);
  $('#q-next').classList.toggle('hidden', !submitted);
  $('#q-next').textContent = QUIZ.idx === total - 1 ? '完成' : '下一题';

  ensureAnswerSheet();
  renderAnswerSheet();
}

$('#q-prev').onclick = () => { if (QUIZ.idx > 0) { QUIZ.idx--; renderQuiz(); } };

$('#q-submit').onclick = () => {
  const q = QUIZ.qs[QUIZ.idx];
  if (!QUIZ.sel[QUIZ.idx]) QUIZ.sel[QUIZ.idx] = { sel: [], submitted: false };
  const sel = QUIZ.sel[QUIZ.idx].sel;
  if (!sel.length) { toast('请选择答案'); return; }
  QUIZ.sel[QUIZ.idx].submitted = true;
  const correct = sameSet(sel, q.answer);
  QUIZ.results[QUIZ.idx] = correct;
  Store.recordAnswer(q.id, correct, q.bank);
  if (!correct && !QUIZ.wrongs.includes(q.id)) QUIZ.wrongs.push(q.id);
  renderQuiz();
};

$('#q-next').onclick = () => {
  if (QUIZ.idx < QUIZ.qs.length - 1) { QUIZ.idx++; renderQuiz(); }
  else finishQuiz();
};

/** 集合相等判断（选项顺序无关） */
function sameSet(a, b) {
  if (a.length !== b.length) return false;
  return [...a].sort().join('') === [...b].sort().join('');
}

function finishQuiz() {
  // 清掉插入的答题卡元素，避免下次进入时重复
  document.querySelectorAll('.answer-sheet').forEach(n => n.remove());
  renderResult();
  showView('result');
}

// ==================== 结果页 ====================
function renderResult() {
  const total = QUIZ.qs.length;
  const correct = QUIZ.results.filter(Boolean).length;
  const pct = total ? Math.round(correct / total * 100) : 0;
  $('#result-ring').style.background = `conic-gradient(var(--accent2) ${pct * 3.6}deg, #eef0f5 ${pct * 3.6}deg)`;
  $('#result-pct').textContent = pct + '%';
  $('#result-meta').innerHTML = `答对 <b>${correct}</b> / ${total}　错题 <b>${QUIZ.wrongs.length}</b>`;
  $('#result-wrongs').innerHTML = QUIZ.wrongs.length ? QUIZ.wrongs.map(id => {
    const q = QUIZ.qs.find(x => x.id === id);
    return `<div class="list-item"><div class="li-ic">✗</div><div class="li-main">
      <div class="li-title">${esc(q.question.slice(0, 40))}</div>
      <div class="li-sub">${esc(q.bank_title)} · ${typeLabel(q.type)}</div></div></div>`;
  }).join('') : '<div class="empty-tip">本次全对，太棒了！</div>';
}

$('#result-review').onclick = () => {
  const qs = QUIZ.wrongs.map(id => QUIZ.qs.find(q => q.id === id)).filter(Boolean);
  if (!qs.length) { toast('没有错题可复习'); return; }
  startQuiz(qs);
};
$('#result-again').onclick = () => openSetup(SETUP.mode);

// ==================== 背题模式 ====================
const MEM = { qs: [], idx: 0 };

function startMemorize() {
  const qs = DB.pickQuestions({ bank: SETUP.bank || null, types: SETUP.types, order: SETUP.order, limit: SETUP.count });
  if (!qs.length) { toast('没有题目'); return; }
  MEM.qs = qs; MEM.idx = 0;
  renderMemorize();
  showView('memorize');
}

function renderMemorize() {
  const q = MEM.qs[MEM.idx];
  const total = MEM.qs.length;
  $('#mem-text').textContent = (MEM.idx + 1) + ' / ' + total;
  $('#mem-fill').style.width = ((MEM.idx + 1) / total * 100) + '%';
  $('#mem-prev').style.visibility = MEM.idx === 0 ? 'hidden' : 'visible';
  // 简答题直接显示参考答案文本；其它题型走选项逻辑
  const isShort = q.type === 'short_multi';
  const ansTxt = isShort ? q.answer :
    q.answer.map(a => q.type === 'judge' ? (a === 'T' ? '正确' : '错误') : a).join('、');
  const optsTxt = isShort || q.type === 'judge' ? '' :
    q.options.map(([k, t]) => `<div><b>${esc(k)}.</b> ${esc(t)}${q.answer.includes(k) ? ' ✓' : ''}</div>`).join('');
  $('#memorize-body').innerHTML = `
    <div class="mem-card">
      <div class="mem-tag">${esc(q.bank_title)} · ${typeLabel(q.type)}</div>
      <div class="mem-stem">${esc(q.question)}</div>
      <div class="mem-divider"></div>
      <div class="mem-label">${isShort ? '参考答案' : '正确答案'}</div>
      <div class="mem-answer" ${isShort ? 'style="white-space:pre-wrap;line-height:1.8"' : ''}>${esc(ansTxt)}</div>
      ${optsTxt ? '<div class="mem-divider"></div><div class="mem-label">选项</div><div class="mem-answer">' + optsTxt + '</div>' : ''}
      ${q.analysis ? '<div class="mem-analysis"><b>参考解析：</b>' + esc(q.analysis) + '</div>' : ''}
    </div>`;
}
$('#mem-prev').onclick = () => { if (MEM.idx > 0) { MEM.idx--; renderMemorize(); } };
$('#mem-next').onclick = () => {
  if (MEM.idx < MEM.qs.length - 1) { MEM.idx++; renderMemorize(); }
  else { toast('已全部背完'); showView('home'); }
};
$('#mem-mark').onclick = () => {
  const q = MEM.qs[MEM.idx];
  Store.addWrong(q.id, q.bank);
  toast('已加入错题本');
};

// ==================== 错题集 ====================
function renderWrongBook() {
  const banks = [{ bank: '', title: '全部题库' }].concat(DB.listBanks());
  $('#wrong-bank').innerHTML = banks.map(b => `<option value="${esc(b.bank)}">${esc(b.title)}</option>`).join('');
  const bankFilter = $('#wrong-bank').value;
  const qs = DB.byIds(Store.getWrongIds()).filter(q => !bankFilter || q.bank === bankFilter);
  $('#wrong-empty').classList.toggle('hidden', qs.length > 0);
  $('#wrong-list').innerHTML = qs.map(q => `
    <div class="list-item">
      <div class="li-ic" style="background:#fef2f2">✗</div>
      <div class="li-main">
        <div class="li-title">${esc(q.question.slice(0, 42))}</div>
        <div class="li-sub">${esc(q.bank_title)} · ${typeLabel(q.type)} · 错${Store.qStat(q.id).wrong}次</div>
      </div>
      <button class="link-btn" data-rm="${q.id}">移除</button>
    </div>`).join('');
  $$('#wrong-list [data-rm]').forEach(b => b.onclick = () => {
    Store.removeWrong(+b.dataset.rm);
    renderWrongBook();
  });
}
$('#wrong-bank').onchange = renderWrongBook;
$('#wrong-clear').onclick = () => {
  if (!Store.wrongCount()) { toast('错题集为空'); return; }
  if (confirm('确定清空全部错题？')) { Store.clearWrong(); renderWrongBook(); toast('已清空'); }
};

// ==================== 全局导航 ====================
/** 提示需登录才能用云端功能（不强制跳转，仅 toast 提醒） */
function requireLogin() {
  if (Store.who()) return true;
  toast('登录后可云端同步进度（访客可正常刷题）');
  return false;
}

$$('.tab').forEach(t => t.onclick = () => {
  const tab = t.dataset.tab;
  if (tab === 'home') {
    if (Store.who()) { renderHome(); showView('home'); } else showView('login');
  }
  else if (tab === 'practice') { openSetup('practice'); }
  else if (tab === 'wrong-book') { renderWrongBook(); showView('wrong'); }
  else if (tab === 'memorize') { openSetup('memorize'); }
  else if (tab === 'me') showMe();
});

$$('[data-back]').forEach(b => b.onclick = () => showView(b.dataset.back));

$$('.mode-card').forEach(c => c.onclick = () => {
  const m = c.dataset.mode;
  if (m === 'wrong-book') { renderWrongBook(); showView('wrong'); }
  else if (m === 'wrong-train') {
    const ids = Store.getWrongIds();
    if (!ids.length) { toast('错题集为空，先去刷题吧'); return; }
    startQuiz(DB.byIds(ids));
  }
  else if (m === 'memorize') openSetup('memorize');
  else if (m === 'smart') openSetup('smart');
  else if (m === 'exam') openSetup('exam');
  else openSetup('practice');
});

function goLoginPage() {
  showView('login');
  const rem = Store.rememberUsername();
  if (rem) $('#acc-user').value = rem;
  $('#acc-pwd').value = '';
  setLoginMode('login');
  renderAccountSwitcher();
}

// ==================== 账号中心 ====================
function showMe() {
  const who = Store.who();
  const gs = Store.globalStats();
  gs.total = DB.total();
  const accounts = Store.listAccounts();
  if (who) {
    $('#me-desc').innerHTML = `
      <div>
        <b style="font-size:16px;color:var(--ink)">当前账号：</b> <b style="color:var(--primary-d)">${esc(who)}</b><br><br>
        <b>学习进度：</b><br>
        · 总题数：<b>${gs.total}</b> · 已练习：<b>${gs.answered}</b> · 正确率：<b style="color:var(--accent2)">${gs.rate}%</b> · 错题：<b style="color:var(--danger)">${gs.wrong}</b><br><br>
        <b>已注册账号（共 ${accounts.length} 个）：</b><br>
        ${accounts.map(a => (a === who ? '✅ <b>' + esc(a) + '</b>（当前）' : '· ' + esc(a))).join('<br>') || '（暂无其他账号）'}
      </div>`;
    refreshCloudStatus();
  } else {
    $('#me-desc').innerHTML = `
      <div style="text-align:center;padding:10px 0">
        <div style="font-size:15px;color:var(--ink);margin-bottom:8px">当前为<b style="color:var(--ink-2)">访客模式</b>，可正常刷题</div>
        <div style="color:var(--ink-3);font-size:12px;margin-bottom:14px">登录后可云端同步进度、跨设备使用</div>
        <button class="btn-primary" id="me-goto-login" style="margin:0 auto;max-width:200px">去登录 / 注册</button>
      </div>`;
    $('#me-cloud-state').textContent = '☁️ 云端同步：';
    $('#me-cloud-detail').textContent = '未登录';
    const goBtn = $('#me-goto-login');
    if (goBtn) goBtn.onclick = () => showView('login');
  }
  showView('me');
}

function bindAccountCenter() {
  const btnPush = $('#me-cloud-push');
  const btnPull = $('#me-cloud-pull');

  if (btnPush) btnPush.onclick = async () => {
    if (!Store.who()) { toast('请先登录'); return; }
    btnPush.disabled = true; const ot = btnPush.textContent; btnPush.textContent = '同步中…';
    try {
      const r = await Store.cloudPushNow();
      CLOUD_LAST = { at: Date.now(), ok: !!r.ok, msg: r.ok ? '手动同步成功' : (r.reason || String(r.error?.message || r.error || '失败')) };
      refreshCloudStatus();
      toast(CLOUD_LAST.ok ? '已同步到云端：' + CLOUD_LAST.msg : '同步失败：' + CLOUD_LAST.msg);
    } finally { btnPush.disabled = false; btnPush.textContent = ot; }
  };

  if (btnPull) btnPull.onclick = async () => {
    if (!Store.who()) { toast('请先登录'); return; }
    btnPull.disabled = true; const ot = btnPull.textContent; btnPull.textContent = '拉取中…';
    try {
      const r = await Store.cloudPullNow();
      CLOUD_LAST = { at: Date.now(), ok: !!r.ok, msg: r.ok ? (r.nothing ? '云端暂无进度' : '已合并云端进度到本地') : (r.reason || String(r.error?.message || r.error || '失败')) };
      refreshCloudStatus();
      toast(CLOUD_LAST.ok ? CLOUD_LAST.msg : '拉取失败：' + CLOUD_LAST.msg);
      if (CLOUD_LAST.ok) {
        updateUserTag(); renderAccountSwitcher();
        if ($('#view-home').classList.contains('active')) renderHome();
      }
    } finally { btnPull.disabled = false; btnPull.textContent = ot; }
  };

  $('#me-export').onclick = () => {
    try {
      const dump = Store.exportAll();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      const stamp = new Date();
      const y = stamp.getFullYear();
      const m = String(stamp.getMonth() + 1).padStart(2, '0');
      const d = String(stamp.getDate()).padStart(2, '0');
      a.download = `刷题大专家-数据备份-${y}${m}${d}.json`;
      a.href = URL.createObjectURL(blob);
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast(`已导出 ${Object.keys(dump.users).length} 个账号的数据，请在另一台设备的"账号中心-导入数据"里导入`);
    } catch (e) {
      toast('导出失败：' + (e.message || String(e)));
    }
  };

  $('#me-import-file').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = ''; // reset，允许再次选同一文件
    if (!f) return;
    const fr = new FileReader();
    fr.onload = ev => {
      try {
        let dump;
        try { dump = JSON.parse(ev.target.result); } catch (_) { throw new Error('文件不是合法的 JSON'); }
        const r = Store.importAll(dump, { mode: 'merge' });
        let msg = `导入完成：成功 ${r.imported.length} 个账号`;
        if (r.failed.length) msg += '，失败 ' + r.failed.length;
        toast(msg);
        updateUserTag(); renderAccountSwitcher();
        if (Store.who()) renderHome();
        if ($('#view-home').classList.contains('active')) renderHome();
        setTimeout(() => alert(
          '导入完成：\n' +
          '成功：' + (r.imported.length ? r.imported.join('、') : '（无）') + '\n' +
          '失败：' + (r.failed.length ? r.failed.join('；') : '（无）') + '\n\n' +
          '如果导入的账号密码你清楚，可以直接在登录页输入密码登录。\n如果想直接切到该账号且勾选了"记住"，下次打开会自动登录。'
        ), 200);
      } catch (err) {
        toast('导入失败：' + (err.message || String(err)));
      }
    };
    fr.onerror = () => toast('读取文件失败');
    fr.readAsText(f);
  });

  $('#me-switch').onclick = () => {
    goLoginPage();
  };

  $('#me-logout').onclick = () => {
    stopCloudPushTimer();
    Store.logout();
    updateUserTag();
    toast('已退出登录');
    goLoginPage();
  };
}
bindAccountCenter();

// ==================== 启动 ====================
boot();

// 注册 Service Worker（PWA 离线 + 可安装）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
