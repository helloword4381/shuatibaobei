/* admin.js — 刷题大专家 管理后台
 * 职责：密码门、查询 Supabase 所有用户及答题进度、统计渲染、搜索排序
 */

// ==================== Supabase 配置（与 store.js 一致） ====================
const CLOUD = {
  URL: 'https://tbdvkitjtcswwxthxbft.supabase.co',
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRiZHZraXRqdGNzd3d4dGh4YmZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczOTMzMzAsImV4cCI6MjEwMjk2OTMzMH0.DvOLX14AHrUMCjSHGfN9VDsyARM0i66FkrDZJpEOc30'
};

// 管理员密码 SHA-256 哈希（明文：shuati2024admin）
const ADMIN_PWD_HASH = '44b7769fe9ab386534489ea560a0c251274f00673fb5bd128df58d5e3d285c7e';

// ==================== 工具 ====================
const $ = s => document.querySelector(s);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(str) {
  if (!str) return '—';
  const d = new Date(str);
  if (isNaN(d)) return '—';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function rateClass(r) {
  if (r >= 80) return 'rate-high';
  if (r >= 50) return 'rate-mid';
  return 'rate-low';
}

// ==================== 密码门 ====================
async function checkPwd() {
  const input = $('#pwd-input').value.trim();
  if (!input) return false;
  const hash = await sha256(input);
  return hash === ADMIN_PWD_HASH;
}

$('#pwd-btn').onclick = async () => {
  const btn = $('#pwd-btn');
  btn.disabled = true; btn.textContent = '验证中…';
  try {
    if (await checkPwd()) {
      sessionStorage.setItem('admin_ok', '1');
      $('#gate').style.display = 'none';
      $('#dashboard').classList.add('active');
      await loadDashboard();
    } else {
      btn.textContent = '密码错误';
      setTimeout(() => { btn.textContent = '进 入'; }, 1500);
    }
  } catch (e) {
    btn.textContent = '错误：' + (e.message || e);
  } finally {
    btn.disabled = false;
  }
};

$('#pwd-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#pwd-btn').click();
});

// ==================== Supabase 查询 ====================
async function fetchAllUsers() {
  const res = await fetch(CLOUD.URL + '/rest/v1/users?select=username,created_at&order=created_at.desc', {
    headers: { 'apikey': CLOUD.ANON_KEY, 'Authorization': 'Bearer ' + CLOUD.ANON_KEY, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error('查询用户表失败：HTTP ' + res.status);
  return res.json();
}

async function fetchAllProgress() {
  const res = await fetch(CLOUD.URL + '/rest/v1/progress?select=username,wrong,hist,settings,updated_at&order=updated_at.desc', {
    headers: { 'apikey': CLOUD.ANON_KEY, 'Authorization': 'Bearer ' + CLOUD.ANON_KEY, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error('查询进度表失败：HTTP ' + res.status);
  return res.json();
}

// ==================== 数据处理 ====================
function computeUserStats(username, users, progress) {
  const u = users.find(x => x.username === username) || {};
  const p = progress.find(x => x.username === username) || {};

  const hist = (typeof p.hist === 'string') ? JSON.parse(p.hist || '{}') : (p.hist || {});
  const wrong = (typeof p.wrong === 'string') ? JSON.parse(p.wrong || '{}') : (p.wrong || {});

  let answered = 0, correct = 0;
  for (const id in hist) {
    answered++;
    correct += (hist[id].correct || 0);
  }

  // 按题库分组统计
  const banks = {};
  for (const id in hist) {
    const b = hist[id].bank || '未分类';
    if (!banks[b]) banks[b] = { answered: 0, correct: 0 };
    banks[b].answered++;
    banks[b].correct += (hist[id].correct || 0);
  }

  const wrongCount = Object.keys(wrong).length;
  const rate = answered ? Math.round(correct / answered * 100) : 0;

  return {
    username,
    created: u.created_at || null,
    updated: p.updated_at || null,
    answered,
    correct,
    wrong: wrongCount,
    rate,
    banks
  };
}

// ==================== 渲染 ====================
let allUsers = [];
let filtered = [];
let sortKey = 'created_desc';

function renderStats(users) {
  const total = users.length;
  const totalAnswered = users.reduce((s, u) => s + u.answered, 0);
  const totalCorrect = users.reduce((s, u) => s + u.correct, 0);
  const totalWrong = users.reduce((s, u) => s + u.wrong, 0);
  const avgRate = totalAnswered ? Math.round(totalCorrect / totalAnswered * 100) : 0;
  const activeToday = users.filter(u => {
    if (!u.updated) return false;
    const d = new Date(u.updated);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  $('#stats-grid').innerHTML = [
    { label: '注册用户', val: total, cls: 'primary', extra: '已注册账号总数' },
    { label: '总答题数', val: totalAnswered, cls: '', extra: '所有用户合计' },
    { label: '平均正确率', val: avgRate + '%', cls: 'green', extra: totalCorrect + ' 道答对 / ' + totalAnswered + ' 道答题' },
    { label: '今日活跃', val: activeToday, cls: '', extra: '今天有同步记录的用户' },
    { label: '总错题数', val: totalWrong, cls: 'red', extra: '所有用户错题合计' }
  ].map(s => `
    <div class="stat-card">
      <div class="label">${s.label}</div>
      <div class="value ${s.cls}">${s.val}</div>
      <div class="extra">${s.extra}</div>
    </div>
  `).join('');
}

function renderTable(users) {
  const tbody = $('#user-tbody');
  if (!users.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">暂无用户数据</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const rc = rateClass(u.rate);
    return `<tr>
      <td class="td-user">${esc(u.username)}</td>
      <td class="hide-mobile date-str">${fmtDate(u.created)}</td>
      <td class="hide-mobile date-str">${fmtDate(u.updated)}</td>
      <td class="td-num">${u.answered}</td>
      <td class="td-num">${u.correct}</td>
      <td class="td-num"><span class="rate-badge ${rc}">${u.rate}%</span></td>
      <td class="td-num">${u.wrong}</td>
    </tr>`;
  }).join('');
}

function applyFilter() {
  const q = $('#search').value.trim().toLowerCase();
  filtered = allUsers.filter(u => u.username.toLowerCase().includes(q));

  const [key, dir] = sortKey.split('_');
  const mul = dir === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    let va, vb;
    if (key === 'created') { va = new Date(a.created || 0).getTime(); vb = new Date(b.created || 0).getTime(); }
    else if (key === 'answered') { va = a.answered; vb = b.answered; }
    else if (key === 'rate') { va = a.rate; vb = b.rate; }
    else if (key === 'updated') { va = new Date(a.updated || 0).getTime(); vb = new Date(b.updated || 0).getTime(); }
    else va = 0; vb = 0;
    return (va - vb) * mul;
  });

  renderStats(filtered);
  renderTable(filtered);
}

// ==================== 主加载 ====================
async function loadDashboard() {
  const tbody = $('#user-tbody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="7"><div class="loading"><div class="spin"></div><br>正在从云端加载数据…</div></td></tr>';

  try {
    const [users, progress] = await Promise.all([fetchAllUsers(), fetchAllProgress()]);

    allUsers = users.map(u => computeUserStats(u.username, users, progress));
    // 也包含只有 progress 但 users 表没有的用户（理论上不会，但兜底）
    for (const p of progress) {
      if (!allUsers.find(x => x.username === p.username)) {
        allUsers.push(computeUserStats(p.username, users, progress));
      }
    }

    applyFilter();
  } catch (e) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="error-msg">⚠️ 加载失败：${esc(e.message)}</div></td></tr>`;
  }
}

// ==================== 事件绑定 ====================
$('#search').addEventListener('input', applyFilter);
$('#sort-select').addEventListener('change', e => {
  sortKey = e.target.value;
  applyFilter();
});
$('#refresh-btn').onclick = async () => {
  const btn = $('#refresh-btn');
  btn.disabled = true; btn.textContent = '刷新中…';
  try { await loadDashboard(); }
  finally { btn.disabled = false; btn.textContent = '⟳ 刷新'; }
};
$('#logout-btn').onclick = () => {
  sessionStorage.removeItem('admin_ok');
  location.reload();
};

// ==================== 自动登录（同标签页内） ====================
if (sessionStorage.getItem('admin_ok') === '1') {
  $('#gate').style.display = 'none';
  $('#dashboard').classList.add('active');
  loadDashboard();
}}