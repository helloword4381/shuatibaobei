/* admin.js — 刷题大专家 管理后台
 * 职责：密码门、查询 Supabase 所有用户及答题进度、统计渲染、搜索排序
 * 注意：全部事件绑定放在 DOMContentLoaded 内执行，容错兜底
 */

(function () {
  'use strict';

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
    if (!crypto || !crypto.subtle) throw new Error('当前浏览器不支持加密，请使用最新版 Chrome/Safari/Edge');
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

  /** 简易 toast（页面顶部可见，不依赖按钮文字） */
  function showTip(msg, type) {
    let tip = $('#tip-bar');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'tip-bar';
      Object.assign(tip.style, {
        position: 'fixed', left: '50%', transform: 'translateX(-50%)', top: '20px',
        padding: '10px 18px', borderRadius: '8px', fontSize: '14px', zIndex: '9999',
        boxShadow: '0 4px 16px rgba(0,0,0,.12)', transition: 'opacity .2s', opacity: '0',
        pointerEvents: 'none'
      });
      document.body.appendChild(tip);
    }
    tip.textContent = msg;
    tip.style.background = type === 'error' ? '#fef2f2' : (type === 'ok' ? '#f0fdf4' : '#eef2ff');
    tip.style.color = type === 'error' ? '#dc2626' : (type === 'ok' ? '#16a34a' : '#4f46e5');
    tip.style.opacity = '1';
    clearTimeout(showTip._t);
    showTip._t = setTimeout(() => { tip.style.opacity = '0'; }, 2000);
  }

  // ==================== 密码门 ====================
  async function checkPwd() {
    const input = $('#pwd-input').value.trim();
    if (!input) return false;
    const hash = await sha256(input);
    return hash === ADMIN_PWD_HASH;
  }

  function bindGate() {
    const btn = $('#pwd-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '验证中…';
      try {
        if (await checkPwd()) {
          sessionStorage.setItem('admin_ok', '1');
          $('#gate').style.display = 'none';
          $('#dashboard').classList.add('active');
          showTip('登录成功，正在加载数据…', 'ok');
          await loadDashboard();
        } else {
          showTip('❌ 密码错误，请重试', 'error');
          btn.textContent = '密码错误';
          setTimeout(() => { btn.textContent = '进 入'; btn.disabled = false; }, 1500);
          return;
        }
      } catch (e) {
        showTip('错误：' + (e.message || e), 'error');
        btn.textContent = '进 入';
      } finally {
        btn.disabled = false;
      }
    });

    const input = $('#pwd-input');
    if (input) input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
    });
  }

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
  function parseJSON(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return fallback; } }
    return v;
  }

  function computeUserStats(username, users, progress) {
    const u = users.find(x => x.username === username) || {};
    const p = progress.find(x => x.username === username) || {};

    const hist = parseJSON(p.hist, {});
    const wrong = parseJSON(p.wrong, {});

    let answered = 0, correct = 0;
    for (const id in hist) {
      answered++;
      correct += (hist[id].correct || 0);
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
      rate
    };
  }

  // ==================== 渲染 ====================
  let allUsers = [];
  let sortKey = 'created_desc';

  function renderStats(users) {
    const total = users.length;
    const totalAnswered = users.reduce((s, u) => s + u.answered, 0);
    const totalCorrect = users.reduce((s, u) => s + u.correct, 0);
    const totalWrong = users.reduce((s, u) => s + u.wrong, 0);
    const avgRate = totalAnswered ? Math.round(totalCorrect / totalAnswered * 100) : 0;
    const today = new Date().toDateString();
    const activeToday = users.filter(u => u.updated && new Date(u.updated).toDateString() === today).length;

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
    const search = $('#search');
    const q = search ? search.value.trim().toLowerCase() : '';
    const filtered = allUsers.filter(u => u.username.toLowerCase().includes(q));

    const [key, dir] = sortKey.split('_');
    const mul = dir === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      let va = 0, vb = 0;
      if (key === 'created') { va = new Date(a.created || 0).getTime(); vb = new Date(b.created || 0).getTime(); }
      else if (key === 'answered') { va = a.answered; vb = b.answered; }
      else if (key === 'rate') { va = a.rate; vb = b.rate; }
      else if (key === 'updated') { va = new Date(a.updated || 0).getTime(); vb = new Date(b.updated || 0).getTime(); }
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
      for (const p of progress) {
        if (!allUsers.find(x => x.username === p.username)) {
          allUsers.push(computeUserStats(p.username, users, progress));
        }
      }
      applyFilter();
    } catch (e) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="error-msg">⚠️ 加载失败：${esc(e.message)}</div></td></tr>`;
      showTip('加载失败：' + e.message, 'error');
    }
  }

  // ==================== 事件绑定 ====================
  function bindDashboard() {
    const search = $('#search');
    if (search) search.addEventListener('input', applyFilter);

    const sel = $('#sort-select');
    if (sel) sel.addEventListener('change', e => { sortKey = e.target.value; applyFilter(); });

    const rbtn = $('#refresh-btn');
    if (rbtn) rbtn.addEventListener('click', async () => {
      rbtn.disabled = true; rbtn.textContent = '刷新中…';
      try { await loadDashboard(); showTip('已刷新', 'ok'); }
      finally { rbtn.disabled = false; rbtn.textContent = '⟳ 刷新'; }
    });

    const lbtn = $('#logout-btn');
    if (lbtn) lbtn.addEventListener('click', () => {
      sessionStorage.removeItem('admin_ok');
      location.reload();
    });
  }

  // ==================== 启动（DOM 就绪后） ====================
  function boot() {
    try {
      bindGate();
      bindDashboard();

      // 同标签页会话内免密
      if (sessionStorage.getItem('admin_ok') === '1') {
        const gate = $('#gate'); const dash = $('#dashboard');
        if (gate) gate.style.display = 'none';
        if (dash) dash.classList.add('active');
        loadDashboard();
      }
    } catch (e) {
      showTip('初始化错误：' + (e.message || e), 'error');
      console.error(e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
