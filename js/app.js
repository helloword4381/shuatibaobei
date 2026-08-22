/* app.js — 刷题宝贝 主逻辑 */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (t, cls, html) => { const e = document.createElement(t); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}

function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  const tab = name === 'wrong-book' ? 'wrong-book' : (name === 'memorize' ? 'memorize' : (name === 'home' ? 'home' : (name === 'practice' ? 'practice' : null)));
  if (tab) $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  window.scrollTo(0, 0);
}

// ============ 初始化 ============
async function boot() {
  try {
    const r = await DB.init(setSplash);
    $('#db-version').textContent = 'v' + (r.version || 'local');
    renderHome();
    showView('home');
    // 非阻塞检查更新
    checkForUpdates(false);
  } catch (e) {
    setSplash('题库加载失败：' + (e.message || e));
  }
}
function setSplash(m) { $('#splash-text').textContent = m; }

// ============ 更新检测 ============
async function checkForUpdates(force) {
  try {
    const { hasUpdate, remote, local } = await DB.checkUpdate();
    if (hasUpdate) {
      $('#update-desc').innerHTML =
        `新版本 <b>v${remote.version}</b> 已发布<br>题量：${remote.question_count} 题<br>当前：v${local || '无'}`;
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
    setSplash('正在下载新题库…'); $('#view-splash').classList.add('active');
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

// ============ 首页 ============
function renderHome() {
  const gs = Store.globalStats(); gs.total = DB.total();
  const banks = DB.listBanks();
  $('#home-stats').innerHTML = `
    <div class="stat-card"><div class="num">${gs.total}</div><div class="lbl">总题数</div></div>
    <div class="stat-card green"><div class="num">${gs.answered}</div><div class="lbl">已练习</div></div>
    <div class="stat-card orange"><div class="num">${gs.rate}%</div><div class="lbl">正确率</div></div>
    <div class="stat-card"><div class="num">${gs.wrong}</div><div class="lbl">错题</div></div>`;
  $('#wrong-count-desc').textContent = (Store.wrongCount()) + ' 道错题';

  $('#bank-list').innerHTML = banks.map(b => {
    const rows = DB.exec("SELECT type, COUNT(*) c FROM questions WHERE bank=? GROUP BY type", [b.bank]);
    let n = 0; const parts = [];
    for (const r of rows) { n += r.c; parts.push(typeLabel(r.type) + r.c); }
    const bs = Store.bankStats(b.bank);
    const pct = bs.answered ? Math.min(100, Math.round(bs.answered / n * 100)) : 0;
    return `<div class="list-item">
      <div class="li-ic">📘</div>
      <div class="li-main">
        <div class="li-title">${b.title}</div>
        <div class="li-sub">${n} 题 · ${parts.join(' / ')}</div>
        <div class="progress-mini"><i style="width:${pct}%"></i></div>
      </div>
      <div class="li-right">${bs.rate || 0}%</div>
    </div>`;
  }).join('');
}

function typeLabel(t) { return { single: '单选', multiple: '多选', judge: '判断', short_multi: '简答' }[t] || t; }
function srcLabel(t) { return { single: '单选', multiple: '多选', judge: '判断', short: '简答' }[t] || t; }

// ============ 配置页 ============
const SETUP = { mode: 'practice', types: ['single', 'multiple', 'judge', 'short'], order: 'seq', count: 20, bank: '' };

function openSetup(mode) {
  SETUP.mode = mode; SETUP.bank = '';
  const titles = { practice: '刷题练习', smart: '智能练题', exam: '模拟考试', memorize: '背题模式' };
  $('#setup-title').textContent = titles[mode] || '刷题';

  // 题库下拉
  const banks = [{ bank: '', title: '全部题库' }].concat(DB.listBanks());
  $('#setup-bank').innerHTML = banks.map(b => `<option value="${b.bank}">${b.title}</option>`).join('');

  // 题型 chips
  const types = mode === 'exam' ? ['single', 'multiple', 'judge', 'short'] : ['single', 'multiple', 'judge', 'short'];
  $('#setup-types').innerHTML = types.map(t => `<span class="chip ${mode === 'exam' || SETUP.types.includes(t) ? 'active' : ''}" data-val="${t}">${srcLabel(t)}</span>`).join('');
  $$('#setup-types .chip').forEach(c => c.onclick = () => { c.classList.toggle('active'); });

  // 出题方式
  $$('#setup-order .chip').forEach(c => c.classList.toggle('active', c.dataset.val === SETUP.order));
  $$('#setup-order .chip').forEach(c => c.onclick = () => {
    $$('#setup-order .chip').forEach(x => x.classList.remove('active')); c.classList.add('active'); SETUP.order = c.dataset.val;
  });

  // 题量
  const cnt = $('#setup-count');
  cnt.value = mode === 'exam' ? 50 : SETUP.count;
  $('#setup-count-val').textContent = cnt.value;
  cnt.oninput = () => $('#setup-count-val').textContent = cnt.value;
  $('#setup-order').style.display = mode === 'exam' ? 'none' : '';
  $('.field-label:nth-of-type(3)') && ($('.field-label:nth-of-type(3)').style.display = mode === 'exam' ? 'none' : '');

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
    // 智能练题：加权抽题
    const all = DB.pickQuestions({ bank: SETUP.bank || null, limit: 99999 });
    const ids = all.map(q => q.id);
    const n = Math.min(SETUP.count, ids.length);
    const picked = Store.pickWeighted(ids, n);
    qs = DB.byIds(picked);
  } else if (SETUP.mode === 'exam') {
    SETUP.types = ['single', 'multiple', 'judge', 'short'];
    qs = DB.pickQuestions({ bank: null, types: SETUP.types, order: 'rand', limit: SETUP.count });
  } else {
    qs = DB.pickQuestions({ bank: SETUP.bank || null, types: SETUP.types, order: SETUP.order, limit: SETUP.count });
  }
  if (!qs.length) { toast('没有符合条件的题目'); return; }
  startQuiz(qs);
};

// ============ 答题引擎 ============
const QUIZ = { qs: [], idx: 0, sel: {}, results: [], wrongs: [] };

function startQuiz(qs) {
  QUIZ.qs = qs; QUIZ.idx = 0; QUIZ.sel = {}; QUIZ.results = []; QUIZ.wrongs = [];
  renderQuiz();
  showView('quiz');
}

function renderQuiz() {
  const q = QUIZ.qs[QUIZ.idx];
  const total = QUIZ.qs.length;
  $('#qp-text').textContent = (QUIZ.idx + 1) + ' / ' + total;
  $('#qp-fill').style.width = ((QUIZ.idx + 1) / total * 100) + '%';
  const correct = QUIZ.results.filter(Boolean).length;
  $('#quiz-score').textContent = correct + '/' + (QUIZ.idx + 1);
  $('#q-prev').style.visibility = QUIZ.idx === 0 ? 'hidden' : 'visible';

  const submitted = QUIZ.sel[QUIZ.idx] !== undefined && QUIZ.sel[QUIZ.idx].submitted;
  const sel = QUIZ.sel[QUIZ.idx] ? QUIZ.sel[QUIZ.idx].sel : [];
  const body = $('#quiz-body');
  body.innerHTML = '';

  const meta = el('div', 'q-meta');
  meta.innerHTML = `<span class="tag">${q.bank_title}</span><span>${typeLabel(q.type)}</span>${q.source_type==='short'?'<span style="color:#8b5cf6">由简答转</span>':''}`;
  body.appendChild(meta);

  const stem = el('div', 'q-stem', q.question);
  body.appendChild(stem);

  // 选项
  let opts = q.options;
  if (q.type === 'judge') opts = [['T', '正确'], ['F', '错误']];
  const isMulti = q.type === 'multiple';
  opts.forEach(([k, txt]) => {
    const o = el('div', 'opt');
    const selected = sel.includes(k);
    if (selected) o.classList.add('selected');
    if (submitted) {
      const isAns = q.answer.includes(k);
      if (isAns) o.classList.add('correct');
      else if (selected) o.classList.add('wrong');
      o.classList.add('disabled');
    }
    o.innerHTML = `<div class="opt-key">${k}</div><div class="opt-txt">${txt}</div><div class="mark"></div>`;
    if (!submitted) o.onclick = () => {
      if (isMulti) {
        if (selected) QUIZ.sel[QUIZ.idx].sel = sel.filter(x => x !== k);
        else QUIZ.sel[QUIZ.idx].sel = [...sel, k];
      } else {
        QUIZ.sel[QUIZ.idx].sel = [k];
      }
      renderQuiz();
    };
    body.appendChild(o);
  });

  // 初始化选择容器
  if (!QUIZ.sel[QUIZ.idx]) QUIZ.sel[QUIZ.idx] = { sel: [], submitted: false };

  // 解析
  if (submitted) {
    const correct = QUIZ.results[QUIZ.idx];
    const an = el('div', 'analysis');
    an.innerHTML = `<div class="an-title">${correct ? '✓ 回答正确' : '✗ 回答错误'}</div>
      <div class="an-body"><b>正确答案：</b>${q.answer.map(a => q.type==='judge' ? (a==='T'?'正确':'错误') : a).join('、')}
      ${q.analysis ? '<br><b>参考解析：</b>' + q.analysis : ''}</div>`;
    body.appendChild(an);
  }

  $('#q-submit').classList.toggle('hidden', submitted);
  $('#q-next').classList.toggle('hidden', !submitted);
  $('#q-next').textContent = QUIZ.idx === total - 1 ? '完成' : '下一题';
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

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const A = [...a].sort().join(''), B = [...b].sort().join('');
  return A === B;
}

function finishQuiz() { renderResult(); showView('result'); }

// ============ 结果页 ============
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
      <div class="li-title">${q.question.slice(0, 40)}</div>
      <div class="li-sub">${q.bank_title} · ${typeLabel(q.type)}</div></div></div>`;
  }).join('') : '<div class="empty-tip">本次全对，太棒了！</div>';
}

$('#result-review').onclick = () => {
  const qs = QUIZ.wrongs.map(id => QUIZ.qs.find(q => q.id === id)).filter(Boolean);
  if (!qs.length) { toast('没有错题可复习'); return; }
  startQuiz(qs);
};
$('#result-again').onclick = () => openSetup(SETUP.mode);

// ============ 背题模式 ============
const MEM = { qs: [], idx: 0 };

function startMemorize() {
  const qs = DB.pickQuestions({ bank: SETUP.bank || null, types: SETUP.types, order: SETUP.order, limit: SETUP.count });
  if (!qs.length) { toast('没有题目'); return; }
  MEM.qs = qs; MEM.idx = 0;
  renderMemorize(); showView('memorize');
}

function renderMemorize() {
  const q = MEM.qs[MEM.idx];
  const total = MEM.qs.length;
  $('#mem-text').textContent = (MEM.idx + 1) + ' / ' + total;
  $('#mem-fill').style.width = ((MEM.idx + 1) / total * 100) + '%';
  $('#mem-prev').style.visibility = MEM.idx === 0 ? 'hidden' : 'visible';
  let ansTxt = q.answer.map(a => q.type === 'judge' ? (a === 'T' ? '正确' : '错误') : a).join('、');
  let optsTxt = '';
  if (q.type !== 'judge') {
    optsTxt = q.options.map(([k, t]) => `<div><b>${k}.</b> ${t}${q.answer.includes(k) ? ' ✓' : ''}</div>`).join('');
  }
  $('#memorize-body').innerHTML = `
    <div class="mem-card">
      <div class="mem-tag">${q.bank_title} · ${typeLabel(q.type)}</div>
      <div class="mem-stem">${q.question}</div>
      <div class="mem-divider"></div>
      <div class="mem-label">正确答案</div>
      <div class="mem-answer">${ansTxt}</div>
      ${optsTxt ? '<div class="mem-divider"></div><div class="mem-label">选项</div><div class="mem-answer">' + optsTxt + '</div>' : ''}
      ${q.analysis ? '<div class="mem-analysis"><b>参考解析：</b>' + q.analysis + '</div>' : ''}
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

// ============ 错题集 ============
function renderWrongBook() {
  const banks = [{ bank: '', title: '全部题库' }].concat(DB.listBanks());
  $('#wrong-bank').innerHTML = banks.map(b => `<option value="${b.bank}">${b.title}</option>`).join('');
  const ids = Store.getWrongIds();
  const bankFilter = $('#wrong-bank').value;
  const qs = DB.byIds(ids).filter(q => !bankFilter || q.bank === bankFilter);
  $('#wrong-empty').classList.toggle('hidden', qs.length > 0);
  $('#wrong-list').innerHTML = qs.map(q => `
    <div class="list-item">
      <div class="li-ic" style="background:#fef2f2">✗</div>
      <div class="li-main">
        <div class="li-title">${q.question.slice(0, 42)}</div>
        <div class="li-sub">${q.bank_title} · ${typeLabel(q.type)} · 错${Store.qStat(q.id).wrong}次</div>
      </div>
      <button class="link-btn" data-rm="${q.id}">移除</button>
    </div>`).join('');
  $$('#wrong-list [data-rm]').forEach(b => b.onclick = () => {
    Store.removeWrong(+b.dataset.rm); renderWrongBook();
  });
}
$('#wrong-bank').onchange = renderWrongBook;
$('#wrong-clear').onclick = () => {
  if (!Store.wrongCount()) { toast('错题集为空'); return; }
  if (confirm('确定清空全部错题？')) { Store.clearWrong(); renderWrongBook(); toast('已清空'); }
};

// ============ 路由/事件 ============
$$('.tab').forEach(t => t.onclick = () => {
  const tab = t.dataset.tab;
  if (tab === 'home') showView('home');
  else if (tab === 'practice') openSetup('practice');
  else if (tab === 'wrong-book') { renderWrongBook(); showView('wrong'); }
  else if (tab === 'memorize') openSetup('memorize');
  else if (tab === 'me') showMy();
});
$$('[data-back]').forEach(b => b.onclick = () => showView(b.dataset.back));
$$('.mode-card').forEach(c => c.onclick = () => {
  const m = c.dataset.mode;
  if (m === 'wrong-book') { renderWrongBook(); showView('wrong'); }
  else if (m === 'wrong-train') {
    const ids = Store.getWrongIds();
    if (!ids.length) { toast('错题集为空，先去刷题吧'); return; }
    const qs = DB.byIds(ids);
    startQuiz(qs);
  } else if (m === 'memorize') openSetup('memorize');
  else if (m === 'smart') openSetup('smart');
  else if (m === 'exam') openSetup('exam');
  else openSetup('practice');
});

function showMy() {
  // 简易"我的"页 = 在 home 上展示信息
  const gs = Store.globalStats(); gs.total = DB.total();
  showView('home');
  toast(`已练${gs.answered}题 · 正确率${gs.rate}% · 错题${gs.wrong}`);
}

boot();

// 注册 Service Worker（PWA 离线 + 可安装）—— 已启用
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
