/**
 * 班级工作台 - 智能排班系统 v20260910-0800
 * 主要功能：
 * 1. Excel导入解析（识别姓名、性别）
 * 2. 智能排班算法（轮空+下周优先）
 * 3. 多页面菜单（值班表含排班配置 / 座位表 / 学生管理 / 随机点名）
 * 4. 座位表随机排座（完全随机 / 男女穿插 / 男女分区）
 * 5. 随机点名转盘
 * 6. Supabase 云端 PostgreSQL + localStorage 双重持久化（学生/值班表/座位表/点名历史/排班配置）
 * 7. 全站登录拦截 + 仅本地逃生口；超级管理员白名单（yzx20010716@163.com）才能看到云端存储配置
 */

// ===== 全局状态 =====
const state = {
    students: [],        // { name, gender, resting }
    schedule: null,      // 当前值班表数据
    seating: null,       // 当前座位表数据 { rows, cols, mode, seats, overflow }
    startDate: null,     // 起始日期
    weekCycle: 2,        // 排班周期
    currentPage: 'duty', // 当前页面
    rollcall: {
        history: [],       // 已被点到的学生姓名（按时间顺序）
        angle: 0,          // 当前累计旋转角度（弧度）
        spinning: false,   // 是否正在旋转
        lastResult: null,  // 最近一次结果 { name, gender }
    },
    dutyCounts: { '扫地': 2, '擦黑板': 1, '倒垃圾': 1, '摆桌椅': 1 }, // 各职务人数
    seatingConfig: { rows: 6, cols: 6, mode: 'random' },               // 座位表默认配置
    attendance: {                                                     // 考勤记录
        view: 'week',          // 'week' | 'month'
        anchorDate: null,     // 当前查看锚点（YYYY-MM-DD）
        records: {},          // { 'YYYY-MM-DD': { studentName: { status, note } } }
        initializedAt: null,
        selected: {},         // { studentName: true } 导出选中用
    },
    score: {                                                          // 积分统计
        view: 'ranking',      // 'ranking' | 'detail'
        log: [],              // { id, ts, date, studentName, source, delta, reason }
        rules: {              // 积分规则（用户可编辑）
            attendance: { present: +1, late: -1, makeup: +2, leave: 0 },
            duty:       +2,
            rollcall:   +1,
        },
    },
};

// ===== 工具函数 =====
function $(id) { return document.getElementById(id); }

function showToast(msg, type = 'success') {
    const toast = $('toast');
    toast.textContent = msg;
    toast.className = 'toast show ' + type;
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// ===== 本地缓存（localStorage + Supabase 云端双重持久化） =====
const STORAGE_KEY = 'class-workbench.v1';
const LOCAL_ONLY_KEY = 'class-workbench.v1.localOnly';
const SUPABASE_CONFIG_KEY = 'class-workbench.v1.supabaseConfig'; // { url, anonKey }

// 当前 Supabase 客户端与 session（在 init 后或登录后填充）
let supabaseClient = null;
let supabaseUser = null;

// ===== 全站登录拦截 + 超级管理员白名单 =====
const ADMIN_EMAIL = 'yzx20010716@163.com';
function isAdmin() {
    if (!supabaseUser) return false;
    return (supabaseUser.email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase();
}
// 业务页是否允许访问（已登录云端或勾选仅本地都算通过）
function isAccessGranted() {
    return cloudReady() || localOnlyMode();
}

// 读取 URL/anon key 配置
function getSupabaseConfig() {
    try {
        const raw = localStorage.getItem(SUPABASE_CONFIG_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj.url !== 'string' || typeof obj.anonKey !== 'string') return null;
        if (!/^https?:\/\//.test(obj.url)) return null;
        if (obj.anonKey.length < 20) return null;
        // 容错：去掉结尾斜杠，以及常见的 "/rest/v1" 后缀（用户可能误把 API base URL 当 Project URL 复制）
        let url = obj.url.replace(/\/+$/, '');
        url = url.replace(/\/rest\/v1$/i, '');
        return { url, anonKey: obj.anonKey };
    } catch (err) {
        return null;
    }
}

function setSupabaseConfig(url, anonKey) {
    try {
        localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify({ url, anonKey }));
    } catch (err) { /* ignore */ }
}

function clearSupabaseConfig() {
    try { localStorage.removeItem(SUPABASE_CONFIG_KEY); } catch (err) { /* ignore */ }
}

// 初始化客户端 + 从 localStorage 恢复 session
function initSupabase() {
    const cfg = getSupabaseConfig();
    if (!cfg || !window.supabase || typeof window.supabase.createClient !== 'function') {
        supabaseClient = null;
        supabaseUser = null;
        return false;
    }
    try {
        supabaseClient = window.supabase.createClient(cfg.url, cfg.anonKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                storageKey: 'class-workbench.v1.supabaseSession',
            },
        });
    } catch (err) {
        console.warn('[supabase] 创建客户端失败：', err);
        supabaseClient = null;
        supabaseUser = null;
        return false;
    }
    // 异步恢复 session
    supabaseClient.auth.getSession().then(({ data, error }) => {
        if (error) { console.warn('[supabase] 恢复 session 失败：', error); return; }
        supabaseUser = data && data.session && data.session.user ? data.session.user : null;
        refreshCloudStatus();
        if (supabaseUser) {
            syncFromSupabase();
            // session 恢复成功 → 关闭登录遮罩，进入默认页
            if (isAccessGranted()) {
                closeLoginGate();
                const cur = document.querySelector('.page:not(.hidden)')?.dataset.page;
                if (!cur || cur === 'placeholder') switchPage('duty');
            }
        } else {
            // session 恢复后仍未登录 → 打开遮罩
            gateOpenIfNeeded();
        }
    }).catch(err => console.warn('[supabase] getSession 异常：', err));
    return true;
}

// 是否就绪：未勾选仅本地 + 客户端存在 + 已登录
function cloudReady() {
    if (localOnlyMode()) return false;
    if (!supabaseClient) return false;
    return !!supabaseUser;
}

// 用户是否勾选了"仅本地存储"
function localOnlyMode() {
    try { return localStorage.getItem(LOCAL_ONLY_KEY) === '1'; }
    catch (err) { return false; }
}

function setLocalOnlyMode(enabled) {
    try {
        if (enabled) localStorage.setItem(LOCAL_ONLY_KEY, '1');
        else localStorage.removeItem(LOCAL_ONLY_KEY);
    } catch (err) { /* ignore */ }
}

function saveState() {
    let snapshot;
    try {
        // 只保存业务数据，不保存 spinning 这种瞬时状态
        snapshot = {
            students: state.students,
            schedule: state.schedule,
            seating: state.seating,
            startDate: state.startDate,
            weekCycle: state.weekCycle,
            rollcall: {
                history: state.rollcall.history,
                angle: state.rollcall.angle,
                lastResult: state.rollcall.lastResult,
            },
            dutyCounts: state.dutyCounts,
            seatingConfig: state.seatingConfig,
            attendance: state.attendance,
            score: state.score,
            savedAt: Date.now(),
        };
    } catch (err) {
        console.warn('[cache] 构造快照失败：', err);
        return;
    }

    // 1) 本地同步写：保证刷新页面不丢数据
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (err) {
        console.warn('[cache] localStorage 保存失败：', err);
    }

    // 2) 云端异步写：失败仅警告，不影响本地与界面
    if (cloudReady()) {
        const userId = supabaseUser.id;
        supabaseClient.from('snapshots')
            .upsert({ user_id: userId, payload: snapshot }, { onConflict: 'user_id' })
            .then(({ error }) => {
                if (error) console.warn('[cache] Supabase 云端保存失败：', error);
            })
            .catch(err => console.warn('[cache] Supabase upsert 异常：', err));
    }
}

// 防抖：连续高频写时合并成一次写
let _saveTimer = null;
function saveStateDebounced() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => { _saveTimer = null; saveState(); }, 200);
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return null;
        return data;
    } catch (err) {
        console.warn('[cache] 读取失败：', err);
        return null;
    }
}

// 启动后异步尝试从云端拉取；若云端版本更新则覆盖本地
function syncFromSupabase() {
    if (!cloudReady()) return;
    const userId = supabaseUser.id;
    supabaseClient.from('snapshots')
        .select('payload')
        .eq('user_id', userId)
        .maybeSingle()
        .then(({ data, error }) => {
            if (error) { console.warn('[cache] 读取云端失败：', error); return; }
            if (!data || !data.payload || typeof data.payload !== 'object') return;
            const remote = data.payload;
            const local = loadState();
            const remoteTs = typeof remote.savedAt === 'number' ? remote.savedAt : 0;
            const localTs = local && typeof local.savedAt === 'number' ? local.savedAt : 0;
            if (remoteTs <= localTs) return; // 本地更新，无需覆盖
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
                if (typeof showToast === 'function') showToast('已从云端同步最新数据，刷新页面查看', 'success');
            } catch (err) {
                console.warn('[cache] 同步云端到本地失败：', err);
            }
        })
        .catch(err => console.warn('[cache] syncFromSupabase 异常：', err));
}

function clearStoredState() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
    // 异步清掉云端该用户的快照行（不影响其他表/其他用户）
    if (cloudReady()) {
        const userId = supabaseUser.id;
        supabaseClient.from('snapshots').delete().eq('user_id', userId)
            .then(({ error }) => { if (error) console.warn('[cache] 清空云端失败：', error); })
            .catch(err => console.warn('[cache] delete 异常：', err));
    }
}

function setStatus(text) {
    $('statusText').textContent = text;
}

// ===== 云端同步：状态条 / 登录 / 拉取 / 上传 =====

function updateCloudStatus(state, message) {
    const text = $('cloudStatusText');
    const icon = $('cloudStatusIcon');
    if (!text || !icon) return;
    text.classList.remove('is-online', 'is-offline', 'is-local-only', 'is-syncing', 'is-error', 'is-no-config');
    if (state) text.classList.add(state);
    text.textContent = message || '';
    const iconMap = {
        'is-online': '☁️✅',
        'is-offline': '☁️⛔',
        'is-local-only': '💾',
        'is-syncing': '🔄',
        'is-error': '⚠️',
        'is-no-config': '⚙️',
    };
    icon.textContent = iconMap[state] || '☁️';
}

// 显示/隐藏按钮的辅助
function setVisible(id, show) {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('hidden', !show);
}

// 启动时刷新一次状态条
function refreshCloudStatus() {
    // 顶部状态条（精简版）
    const userEl = $('cloudStatusUser');
    const logoutBtn = $('cloudStatusLogout');
    const goSettings = $('cloudStatusGoSettings');
    if (localOnlyMode()) {
        updateCloudStatus('is-local-only', '云端状态：仅本地存储');
        if (userEl) { userEl.hidden = true; userEl.textContent = ''; }
        if (logoutBtn) logoutBtn.classList.add('hidden');
        if (goSettings) goSettings.style.display = '';
    } else if (!getSupabaseConfig()) {
        updateCloudStatus('is-no-config', '云端状态：未配置');
        if (userEl) { userEl.hidden = true; userEl.textContent = ''; }
        if (logoutBtn) logoutBtn.classList.add('hidden');
        if (goSettings) goSettings.style.display = '';
    } else if (!supabaseClient) {
        updateCloudStatus('is-error', '云端状态：客户端初始化失败');
        if (userEl) { userEl.hidden = true; userEl.textContent = ''; }
        if (logoutBtn) logoutBtn.classList.add('hidden');
        if (goSettings) goSettings.style.display = '';
    } else if (supabaseUser) {
        updateCloudStatus('is-online', '云端状态：已登录');
        if (userEl) { userEl.hidden = false; userEl.textContent = supabaseUser.email || ''; }
        if (logoutBtn) logoutBtn.classList.remove('hidden');
        if (goSettings) goSettings.style.display = 'none';
    } else {
        updateCloudStatus('is-offline', '云端状态：未登录');
        if (userEl) { userEl.hidden = true; userEl.textContent = ''; }
        if (logoutBtn) logoutBtn.classList.add('hidden');
        if (goSettings) goSettings.style.display = '';
    }
    // 同步设置页状态（如果设置页 DOM 已加载）
    // 同步设置页状态（如果设置页 DOM 已加载）
    refreshSettingsStatus();
    // 同步侧边栏登录按钮的显示状态
    refreshNavLoginBtn();
}

// ===== 全站登录拦截：遮罩开关 =====

// 打开登录遮罩（同时锁定主内容）
function openLoginGate(hint) {
    const gate = $('loginGate');
    if (!gate) return;
    gate.classList.remove('hidden');
    // 锁住主内容，避免遮罩期间的闪烁
    const main = document.querySelector('.main');
    if (main) main.style.visibility = 'hidden';
    // 提示文案（管理员提示/未配置提示）
    const hintEl = $('loginGateHint');
    if (hintEl) hintEl.textContent = hint || '';
    // 同步本地按钮可用性
    refreshLoginGateLocalBtn();
    // 自动聚焦邮箱框（未配置时不要聚焦）
    if (getSupabaseConfig()) {
        setTimeout(() => $('loginGateEmail')?.focus(), 50);
    }
}

// 关闭登录遮罩（解锁主内容）
function closeLoginGate() {
    const gate = $('loginGate');
    if (!gate) return;
    gate.classList.add('hidden');
    const main = document.querySelector('.main');
    if (main) main.style.visibility = '';
    // 清掉状态行/提示
    setLoginGateStatus('', '');
    setLoginGateHint('');
}

// 同步"仅本地"按钮可用性（需勾选复选框）
function refreshLoginGateLocalBtn() {
    const cb = $('loginGateLocalOnly');
    const btn = $('loginGateLocalOnlyOk');
    if (cb && btn) btn.disabled = !cb.checked;
}

// 设置遮罩状态行文本 + className（className 含 is-ok / is-info）
function setLoginGateStatus(text, cls) {
    const el = $('loginGateStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'login-gate-status' + (cls ? ' ' + cls : '');
}

// 设置遮罩底部小提示（管理员邮箱/未配置等）
function setLoginGateHint(text) {
    const el = $('loginGateHint');
    if (el) el.textContent = text || '';
}

// 同步侧边栏"☁️ 登录"按钮的可见性/文字
// 已登录时隐藏，未登录或仅本地时显示（按钮始终可点，未配置 URL 时遮罩会提示）
function refreshNavLoginBtn() {
    const btn = $('navLoginBtn');
    if (!btn) return;
    if (supabaseUser) {
        btn.style.display = 'none';
    } else {
        btn.style.display = '';
        btn.textContent = '☁️ 登录云端';
        btn.disabled = false;
    }
}

// 点击侧边栏登录按钮：直接弹出首页登录遮罩
function openLoginFromNav() {
    // 清空输入
    const emailEl = $('loginGateEmail');
    const pwdEl = $('loginGatePassword');
    if (emailEl) emailEl.value = '';
    if (pwdEl) pwdEl.value = '';
    openLoginGate();
}

// 根据当前状态决定是否要打开登录遮罩
function gateOpenIfNeeded() {
    if (isAccessGranted()) {
        // 已登录或仅本地：确保遮罩关闭
        if (!$('loginGate')?.classList.contains('hidden')) closeLoginGate();
        return false;
    }
    // 未登录且非仅本地：打开遮罩
    let hint = '';
    if (!getSupabaseConfig()) {
        hint = '⚙️ 当前未配置 Supabase，请联系管理员在 Supabase 控制台完成配置后再使用，或选择「仅本地存储」。';
    }
    openLoginGate(hint);
    return true;
}

// 登录遮罩：点击登录按钮
async function submitLoginGate() {
    const email = ($('loginGateEmail').value || '').trim();
    const pwd = $('loginGatePassword').value || '';
    if (!getSupabaseConfig()) {
        setLoginGateStatus('请联系管理员先配置 Supabase URL 与 anon key，或使用「仅本地存储」', 'is-info');
        return;
    }
    if (!email || !pwd) {
        setLoginGateStatus('请填写邮箱和密码', '');
        return;
    }
    if (pwd.length < 6) {
        setLoginGateStatus('密码至少 6 位', '');
        return;
    }
    if (!supabaseClient) initSupabase();
    if (!supabaseClient) {
        setLoginGateStatus('Supabase 客户端初始化失败，请稍后重试', '');
        return;
    }
    setLoginGateStatus('登录中…', 'is-info');
    let result = await supabaseClient.auth.signInWithPassword({ email, password: pwd });
    if (result.error) {
        // 不存在则尝试注册（仅在已配置好 URL 时才有意义）
        const r2 = await supabaseClient.auth.signUp({ email, password: pwd });
        if (r2.error) {
            setLoginGateStatus('登录/注册失败：' + (r2.error.message || ''), '');
            refreshCloudStatus();
            return;
        }
        if (r2.data && r2.data.session && r2.data.session.user) {
            supabaseUser = r2.data.session.user;
        } else {
            setLoginGateStatus('注册成功，请去邮箱点击确认链接后再登录（如已关闭邮箱确认请忽略）', 'is-info');
            return;
        }
    } else {
        supabaseUser = result.data.session.user;
    }
    setLoginGateStatus('登录成功，正在进入…', 'is-ok');
    refreshCloudStatus();
    syncFromSupabase();
    // 关闭遮罩 + 进入默认页
    setTimeout(() => {
        closeLoginGate();
        // 路由层守卫会自动放行
        const cur = document.querySelector('.page:not(.hidden)')?.dataset.page;
        if (!cur || cur === 'placeholder') switchPage('duty');
    }, 300);
}

// 登录遮罩：点击"仅本地使用"按钮
function submitLoginGateLocalOnly() {
    setLocalOnlyMode(true);
    refreshCloudStatus();
    showToast('已切换为仅本地存储', 'info');
    closeLoginGate();
    const cur = document.querySelector('.page:not(.hidden)')?.dataset.page;
    if (!cur || cur === 'placeholder') switchPage('duty');
}

// 手动从云端拉取覆盖本地
function manualPullFromCloud() {
    if (!cloudReady()) {
        showToast('请先登录云端账号', 'warning');
        return;
    }
    updateCloudStatus('is-syncing', '云端状态：正在从云端拉取…');
    const userId = supabaseUser.id;
    supabaseClient.from('snapshots').select('payload').eq('user_id', userId).maybeSingle()
        .then(({ data, error }) => {
            if (error) throw error;
            if (!data || !data.payload || typeof data.payload !== 'object') {
                updateCloudStatus('is-online', '云端状态：云端暂无快照，无需覆盖');
                showToast('云端暂无数据快照', 'info');
                return;
            }
            const remote = data.payload;
            const remoteTs = typeof remote.savedAt === 'number' ? remote.savedAt : 0;
            const localRaw = localStorage.getItem(STORAGE_KEY);
            const localTs = localRaw ? (JSON.parse(localRaw).savedAt || 0) : 0;
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
            } catch (err) {
                updateCloudStatus('is-error', '云端状态：写入本地失败');
                showToast('写入本地失败：' + err.message, 'error');
                return;
            }
            showToast(`已从云端同步（云端 ${new Date(remoteTs).toLocaleString()} / 本地 ${new Date(localTs).toLocaleString()}），刷新页面查看`, 'success');
            updateCloudStatus('is-online', `云端状态：已同步（${new Date(remoteTs).toLocaleString()}）`);
            setTimeout(() => location.reload(), 1500);
        })
        .catch(err => {
            console.warn('[cloud] 拉取失败：', err);
            updateCloudStatus('is-error', '云端状态：拉取失败 ' + (err && err.message ? err.message : ''));
            showToast('从云端拉取失败：' + (err && err.message ? err.message : ''), 'error');
        });
}

// 主动推送本地到云端
function manualPushToCloud() {
    if (!cloudReady()) {
        showToast('请先登录云端账号', 'warning');
        return;
    }
    updateCloudStatus('is-syncing', '云端状态：正在上传本地到云端…');
    saveState();
    let snapshot;
    try { snapshot = JSON.parse(localStorage.getItem(STORAGE_KEY)); }
    catch (err) {
        updateCloudStatus('is-error', '云端状态：本地无快照');
        showToast('本地无数据可上传', 'error');
        return;
    }
    const userId = supabaseUser.id;
    supabaseClient.from('snapshots')
        .upsert({ user_id: userId, payload: snapshot }, { onConflict: 'user_id' })
        .then(({ error }) => {
            if (error) throw error;
            updateCloudStatus('is-online', `云端状态：已上传（${new Date(snapshot.savedAt).toLocaleString()}）`);
            showToast('本地数据已上传到云端', 'success');
        })
        .catch(err => {
            console.warn('[cloud] 上传失败：', err);
            updateCloudStatus('is-error', '云端状态：上传失败 ' + (err && err.message ? err.message : ''));
            showToast('上传失败：' + (err && err.message ? err.message : ''), 'error');
        });
}

// 登录对话框
function openLoginDialog() {
    const cfg = getSupabaseConfig();
    if (!cfg) {
        showToast('请先在"⚙️ 重新配置"里填写 Supabase URL 和 anon key', 'warning');
        openConfigDialog();
        return;
    }
    $('supabaseLoginEmail').value = '';
    $('supabaseLoginPassword').value = '';
    $('supabaseLoginDialog').classList.remove('hidden');
}

function closeLoginDialog() {
    $('supabaseLoginDialog').classList.add('hidden');
}

async function submitLoginDialog() {
    const email = ($('supabaseLoginEmail').value || '').trim();
    const pwd = $('supabaseLoginPassword').value || '';
    if (!email || !pwd) { showToast('请填写邮箱和密码', 'warning'); return; }
    if (pwd.length < 6) { showToast('密码至少 6 位', 'warning'); return; }
    updateCloudStatus('is-syncing', '云端状态：登录中…');
    let result = await supabaseClient.auth.signInWithPassword({ email, password: pwd });
    if (result.error) {
        // 不存在则尝试注册
        const r2 = await supabaseClient.auth.signUp({ email, password: pwd });
        if (r2.error) {
            updateCloudStatus('is-error', '云端状态：登录/注册失败 ' + r2.error.message);
            showToast('登录失败：' + r2.error.message, 'error');
            return;
        }
        if (r2.data && r2.data.session && r2.data.session.user) {
            supabaseUser = r2.data.session.user;
        } else {
            // 注册成功但需确认邮箱
            showToast('注册成功，请去邮箱点击确认链接后再登录', 'warning');
            updateCloudStatus('is-offline', '云端状态：注册成功，等待邮箱确认');
            closeLoginDialog();
            return;
        }
    } else {
        supabaseUser = result.data.session.user;
    }
    closeLoginDialog();
    showToast('登录成功：' + supabaseUser.email, 'success');
    refreshCloudStatus();
    syncFromSupabase();
}

// 退出登录
async function doLogout() {
    if (!supabaseClient) return;
    try {
        await supabaseClient.auth.signOut();
    } catch (err) { /* ignore */ }
    supabaseUser = null;
    refreshCloudStatus();
    showToast('已退出云端登录（数据仍保留在云端）', 'info');
}

// 配置对话框
function openConfigDialog() {
    const cfg = getSupabaseConfig();
    $('supabaseUrl').value = cfg ? cfg.url : '';
    $('supabaseAnonKey').value = cfg ? cfg.anonKey : '';
    $('supabaseConfigDialog').classList.remove('hidden');
}

function closeConfigDialog() {
    $('supabaseConfigDialog').classList.add('hidden');
}

function submitConfigDialog() {
    let url = ($('supabaseUrl').value || '').trim();
    const key = ($('supabaseAnonKey').value || '').trim();
    if (!/^https?:\/\/[^\s]+$/.test(url)) { showToast('URL 格式不正确，应以 http(s):// 开头', 'warning'); return; }
    // 容错：去掉结尾斜杠和可能的 "/rest/v1" 后缀
    url = url.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
    if (key.length < 20) { showToast('anon key 长度太短，请检查复制是否完整', 'warning'); return; }
    setSupabaseConfig(url, key);
    closeConfigDialog();
    showToast('Supabase 配置已保存', 'success');
    initSupabase();
    refreshCloudStatus();
}

// 启动时根据条件提示登录/配置（已废弃：登录拦截由 openLoginGate 全权负责）
function maybePromptCloud() { /* noop */ }

// ===== 系统设置页 =====

// 同步设置页状态（设置页 DOM 可能未渲染，因此做空值保护）
function refreshSettingsStatus() {
    const line = $('settingsCloudStatus');
    const btnPull = $('settingsCloudPull');
    const btnPush = $('settingsCloudPush');
    const loginBlock = $('settingsLoginBlock');
    const cbLocalOnly = $('settingsLocalOnly');
    const inputUrl = $('settingsSupabaseUrl');
    const inputKey = $('settingsSupabaseKey');
    const cloudCard = document.querySelector('.settings-card[data-card="cloud"]');
    if (!line) return;

    if (cbLocalOnly) cbLocalOnly.checked = localOnlyMode();

    const cfg = getSupabaseConfig();
    if (inputUrl && cfg) inputUrl.value = cfg.url;
    if (inputKey && cfg) inputKey.value = cfg.anonKey;

    // 云端存储整张卡仅超级管理员可见
    if (cloudCard) {
        cloudCard.style.display = isAdmin() ? '' : 'none';
    }

    // 已登录时整块登录表单隐藏（顶部状态条已有"退出登录"按钮）
    if (loginBlock) {
        loginBlock.style.display = supabaseUser ? 'none' : '';
    }

    let cls = '', text = '云端状态：检测中…';
    if (localOnlyMode()) {
        cls = 'is-local-only';
        text = '云端状态：仅本地存储（已关闭云端同步）';
    } else if (!cfg) {
        cls = 'is-no-config';
        text = '云端状态：未配置 Supabase，请填入 Project URL 和 anon key';
    } else if (!supabaseClient) {
        cls = 'is-error';
        text = '云端状态：Supabase 客户端初始化失败';
    } else if (supabaseUser) {
        cls = 'is-online';
        text = `云端状态：已登录 ${supabaseUser.email || ''}，自动实时同步中（顶部"退出登录"可登出）`;
    } else {
        cls = 'is-offline';
        text = '云端状态：未登录，填入邮箱和密码后点登录';
    }
    line.className = 'settings-status-line ' + cls;
    line.textContent = text;

    if (btnPull) btnPull.disabled = !cloudReady();
    if (btnPush) btnPush.disabled = !cloudReady();
}

// 设置页：保存 Supabase 配置
function settingsSaveCloudConfig() {
    const url = ($('settingsSupabaseUrl').value || '').trim();
    const key = ($('settingsSupabaseKey').value || '').trim();
    if (!/^https?:\/\/[^\s]+$/.test(url)) { showToast('URL 格式不正确', 'warning'); return; }
    if (key.length < 20) { showToast('anon key 太短，请检查是否复制完整', 'warning'); return; }
    setSupabaseConfig(url, key);
    showToast('Supabase 配置已保存', 'success');
    initSupabase();
    refreshSettingsStatus();
    refreshCloudStatus();
}

// 设置页：清除配置
function settingsClearCloudConfig() {
    if (!confirm('确定清除 Supabase 配置吗？\n（不影响云端已保存的数据）')) return;
    clearSupabaseConfig();
    $('settingsSupabaseUrl').value = '';
    $('settingsSupabaseKey').value = '';
    // 顺便退出登录
    if (supabaseClient && supabaseUser) {
        supabaseClient.auth.signOut().catch(() => {});
    }
    supabaseClient = null;
    supabaseUser = null;
    showToast('已清除 Supabase 配置', 'info');
    refreshSettingsStatus();
    refreshCloudStatus();
}

// 设置页：登录/注册
async function settingsLogin() {
    const email = ($('settingsLoginEmail').value || '').trim();
    const pwd = $('settingsLoginPassword').value || '';
    if (!getSupabaseConfig()) { showToast('请先保存 Supabase 配置', 'warning'); return; }
    if (!email || !pwd) { showToast('请填写邮箱和密码', 'warning'); return; }
    if (pwd.length < 6) { showToast('密码至少 6 位', 'warning'); return; }
    if (!supabaseClient) initSupabase();
    if (!supabaseClient) { showToast('Supabase 客户端未就绪', 'error'); return; }

    let result = await supabaseClient.auth.signInWithPassword({ email, password: pwd });
    if (result.error) {
        const r2 = await supabaseClient.auth.signUp({ email, password: pwd });
        if (r2.error) { showToast('登录/注册失败：' + r2.error.message, 'error'); refreshSettingsStatus(); return; }
        if (r2.data && r2.data.session && r2.data.session.user) {
            supabaseUser = r2.data.session.user;
        } else {
            showToast('注册成功，请去邮箱点击确认链接后再登录（如已关闭邮箱确认请忽略）', 'warning');
            refreshSettingsStatus();
            return;
        }
    } else {
        supabaseUser = result.data.session.user;
    }
    showToast('登录成功：' + supabaseUser.email, 'success');
    refreshSettingsStatus();
    refreshCloudStatus();
    syncFromSupabase();
}

// 退出云端登录（顶部状态条按钮调用）
async function logoutFromCloud() {
    if (!supabaseClient || !supabaseUser) return;
    try { await supabaseClient.auth.signOut(); } catch (err) { /* ignore */ }
    supabaseUser = null;
    showToast('已退出云端登录（云端数据保留）', 'info');
    refreshCloudStatus();
    // 退出后强制打开登录遮罩（如果用户没勾选仅本地）
    gateOpenIfNeeded();
    if (!isAccessGranted()) {
        switchPage('placeholder');
    }
}

// 设置页：JSON 备份导出
function settingsExportJson() {
    const data = loadState() || {};
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `class-workbench-backup-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('已导出 JSON 备份', 'success');
}

// 设置页：从 JSON 恢复
function settingsImportJson(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(String(e.target.result || ''));
            if (!data || typeof data !== 'object') throw new Error('文件内容不是对象');
            if (!confirm('从备份恢复会覆盖当前所有数据，确定继续？')) return;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            showToast('恢复成功，刷新页面查看', 'success');
            setTimeout(() => location.reload(), 1200);
        } catch (err) {
            showToast('恢复失败：' + err.message, 'error');
        }
    };
    reader.readAsText(file);
}

// 设置页：清空本地数据
function settingsResetAll() {
    if (!confirm('确定清空全部本地数据？此操作不可撤销。')) return;
    if (!confirm('再次确认：所有学生 / 值班 / 座位 / 考勤 / 积分都会丢失。继续？')) return;
    clearStoredState();
    // 同时清掉除 config 外的所有 workbench 键
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith('class-workbench') && k !== STORAGE_KEY && k !== LOCAL_ONLY_KEY && k !== SUPABASE_CONFIG_KEY && !k.endsWith('.supabaseSession')) {
                localStorage.removeItem(k);
            }
        }
    } catch (err) { /* ignore */ }
    showToast('已清空全部本地数据，刷新页面', 'success');
    setTimeout(() => location.reload(), 1200);
}

// 绑定设置页所有事件
function bindSettingsPage() {
    $('settingsCloudSave')?.addEventListener('click', settingsSaveCloudConfig);
    $('settingsCloudClear')?.addEventListener('click', settingsClearCloudConfig);
    $('settingsLoginOk')?.addEventListener('click', settingsLogin);
    $('cloudStatusLogout')?.addEventListener('click', logoutFromCloud);
    $('settingsCloudPull')?.addEventListener('click', () => manualPullFromCloud());
    $('settingsCloudPush')?.addEventListener('click', () => manualPushToCloud());

    const cbLocalOnly = $('settingsLocalOnly');
    if (cbLocalOnly) {
        cbLocalOnly.addEventListener('change', () => {
            setLocalOnlyMode(cbLocalOnly.checked);
            refreshCloudStatus();
            if (cbLocalOnly.checked) showToast('已切换为仅本地存储', 'info');
            else { refreshSettingsStatus(); syncFromSupabase(); }
        });
    }

    $('settingsExportJson')?.addEventListener('click', settingsExportJson);
    $('settingsImportJsonBtn')?.addEventListener('click', () => $('settingsImportJson').click());
    $('settingsImportJson')?.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        settingsImportJson(f);
        e.target.value = '';
    });
    $('settingsResetAll')?.addEventListener('click', settingsResetAll);
}

// 切页（如果路由系统已存在就复用；否则用最简实现兜底）
function switchPage(pageName) {
    // 先尝试触发已有的菜单点击
    const nav = document.querySelector(`.nav-item[data-page="${pageName}"]`);
    if (nav && !nav.classList.contains('disabled')) {
        nav.click();
        return;
    }
    // 兜底：手动切 class
    document.querySelectorAll('.page').forEach(p => {
        p.classList.toggle('hidden', p.dataset.page !== pageName);
    });
    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.toggle('active', n.dataset.page === pageName);
    });
}

// ===== 菜单路由 =====
const pageTitles = {
    placeholder: { title: '🔒 请先登录', sub: '登录或切换本地模式以继续' },
    duty: { title: '🗓️ 值班表', sub: '配置规则并生成值班表' },
    seating: { title: '🪑 座位表', sub: '按排列数随机排座' },
    students: { title: '👥 学生管理', sub: '查看与管理班级学生' },
    rollcall: { title: '🎯 随机点名', sub: '从非轮空学生中随机抽取' },
    attendance: { title: '✅ 考勤记录', sub: '每日打卡 · 周/月统计' },
    score: { title: '📊 积分统计', sub: '考勤/值班/点名自动联动 · 排行榜' },
    notice: { title: '📢 班级通知', sub: '即将上线' },
    settings: { title: '🔧 系统设置', sub: '即将上线' },
};

function switchPage(pageName) {
    // 路由守卫：未登录且非仅本地 → 强制打开登录遮罩，停留在占位页
    if (!isAccessGranted() && pageName !== 'placeholder') {
        gateOpenIfNeeded();
        const mainEl = document.querySelector('.main');
        if (mainEl) mainEl.style.visibility = 'hidden';
        // 仍然把占位页"显示"，方便遮罩打开前的过渡视觉
        document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
        document.querySelector('.page[data-page="placeholder"]')?.classList.remove('hidden');
        // 菜单激活态清空
        document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
        $('pageTitle').textContent = '🔒 请先登录';
        $('pageSubtitle').textContent = '登录或切换本地模式以继续';
        document.querySelectorAll('[data-show-on]').forEach(btn => { btn.style.display = 'none'; });
        return;
    }
    // 通过 gate：解锁主内容
    const mainEl = document.querySelector('.main');
    if (mainEl) mainEl.style.visibility = '';

    // 隐藏所有页面
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));

    // 显示目标页面
    const target = document.querySelector(`.page[data-page="${pageName}"]`);
    if (target) {
        target.classList.remove('hidden');
    } else {
        // 占位页面
        document.querySelector('.page[data-page="placeholder"]').classList.remove('hidden');
    }

    // 更新菜单激活状态
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === pageName);
    });

    // 更新标题
    const meta = pageTitles[pageName] || pageTitles.placeholder;
    $('pageTitle').textContent = meta.title;
    $('pageSubtitle').textContent = meta.sub;

    // 控制顶部按钮显示（仅值班表页面显示）
    document.querySelectorAll('[data-show-on]').forEach(btn => {
        btn.style.display = (btn.dataset.showOn === pageName) ? '' : 'none';
    });

    // 切换页面时刷新对应内容
    if (pageName === 'students') renderStudentManagementPage();
    if (pageName === 'seating') updateSeatCapacity();
    if (pageName === 'rollcall') renderRollcallPage();
    if (pageName === 'duty') {
        updateDutySlotInfo();
        // 刷新值班表（轮空列表）
        if (state.schedule) renderDutyTable();
    }
    if (pageName === 'attendance') renderAttendancePage();
    if (pageName === 'score') renderScorePage();

    state.currentPage = pageName;
}

// 菜单点击
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
        if (item.classList.contains('disabled')) {
            showToast('该功能即将上线', 'info');
            return;
        }
        switchPage(item.dataset.page);
    });
});

// 折叠菜单（PC 端 nav-toggle 按钮）
$('navToggle')?.addEventListener('click', () => {
    $('navMenu').classList.toggle('collapsed');
    closeMobileNav();
});

// ===== 移动端侧栏汉堡唤出 + 遮罩 =====
const navMenuEl = $('navMenu');
const navBackdropEl = $('navBackdrop');
function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }

function openMobileNav() {
    if (!isMobile() || !navMenuEl) return;
    navMenuEl.classList.add('mobile-open');
    navBackdropEl?.classList.add('show');
    document.body.style.overflow = 'hidden';
}
function closeMobileNav() {
    navMenuEl?.classList.remove('mobile-open');
    navBackdropEl?.classList.remove('show');
    document.body.style.overflow = '';
}

$('hamburger')?.addEventListener('click', openMobileNav);
navBackdropEl?.addEventListener('click', closeMobileNav);

// 移动端：点菜单项后收起
document.querySelectorAll('.nav-item').forEach(li => {
    li.addEventListener('click', () => { if (isMobile()) closeMobileNav(); });
});

// 视口尺寸变化时复位：变宽时清掉 mobile-open（防止 PC 端仍带 fixed 残留）
let __navMql = window.matchMedia('(max-width: 768px)');
__navMql.addEventListener('change', e => {
    if (!e.matches) closeMobileNav();
    // PC 端保持当前 collapsed 状态；窄屏恢复默认 collapsed
    if (e.matches && navMenuEl && !navMenuEl.classList.contains('collapsed') && !window.__navUserToggled) {
        navMenuEl.classList.add('collapsed');
    }
});

// ===== Excel 导入与解析 =====
// 学生管理页面的"导入学生"按钮触发
document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === 'btnImportStudents' || t.closest('#btnImportStudents')) {
        $('fileInput').click();
    }
    // 添加单个学生按钮
    if (t.id === 'btnAddStudent' || t.closest('#btnAddStudent')) {
        openAddStudentDialog();
    }
    // 添加职务按钮
    if (t.id === 'btnAddDuty' || t.closest('#btnAddDuty')) {
        openAddDutyDialog();
    }
    // 学生卡片删除按钮（事件委托）
    if (t.classList && t.classList.contains('student-card-del')) {
        e.stopPropagation();
        e.preventDefault();
        const idx = parseInt(t.dataset.idx);
        if (!isNaN(idx)) deleteStudent(idx);
        return;
    }
    // 职务 chip 删除按钮（事件委托）
    const delDuty = t.classList && t.classList.contains('duty-chip-del') ? t : t.closest && t.closest('.duty-chip-del');
    if (delDuty) {
        e.stopPropagation();
        e.preventDefault();
        const chip = delDuty.closest('[data-duty-chip]');
        const name = chip && chip.dataset.dutyChip;
        if (name) deleteDuty(name);
        return;
    }
    // 添加学生 dialog 按钮
    if (t.id === 'addStudentCancel' || t.closest('#addStudentCancel')) closeAddStudentDialog();
    if (t.id === 'addStudentSave' || t.closest('#addStudentSave')) submitAddStudent();
    // 添加职务 dialog 按钮
    if (t.id === 'addDutyCancel' || t.closest('#addDutyCancel')) closeAddDutyDialog();
    if (t.id === 'addDutySave' || t.closest('#addDutySave')) submitAddDuty();
});

// 添加学生 dialog：姓名输入框回车 = 保存
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const ad = $('addStudentDialog');
    if (ad && !ad.classList.contains('hidden') && (e.target.id === 'addStudentName' || e.target.id === 'addStudentGender')) {
        e.preventDefault();
        submitAddStudent();
    }
    const dd = $('addDutyDialog');
    if (dd && !dd.classList.contains('hidden') && (e.target.id === 'addDutyName' || e.target.id === 'addDutyCount')) {
        e.preventDefault();
        submitAddDuty();
    }
});

// ===== 手动添加单个学生 =====
function openAddStudentDialog() {
    const nameEl = $('addStudentName');
    const genEl = $('addStudentGender');
    if (nameEl) nameEl.value = '';
    if (genEl) genEl.value = '男';
    $('addStudentDialog')?.classList.remove('hidden');
    setTimeout(() => nameEl?.focus(), 50);
}
function closeAddStudentDialog() {
    $('addStudentDialog')?.classList.add('hidden');
}
function submitAddStudent() {
    const nameEl = $('addStudentName');
    const genEl = $('addStudentGender');
    const raw = (nameEl?.value || '').trim();
    if (!raw) { showToast('请填写姓名', 'warning'); nameEl?.focus(); return; }
    if (raw.length > 20) { showToast('姓名过长（≤20 字）', 'warning'); return; }
    const gender = genEl?.value || '';
    // 去重：name+gender 完全相同的视为重复
    const dup = state.students.find(s => s.name === raw && (s.gender || '') === gender);
    if (dup) { showToast('该姓名+性别已存在，未重复添加', 'warning'); return; }
    state.students.push({ name: raw, gender });
    // 同步各页面
    updateStudentStats();
    updateSeatCapacity();
    updateDutySlotInfo();
    renderStudentManagementPage();
    if ($('btnGenerate')) $('btnGenerate').disabled = state.students.length === 0;
    saveStateDebounced();
    showToast(`已添加：${raw}${gender ? '（' + gender + '）' : ''}`, 'success');
    closeAddStudentDialog();
}
function deleteStudent(idx) {
    if (isNaN(idx) || idx < 0 || idx >= state.students.length) return;
    const s = state.students[idx];
    if (!s) return;
    const ok = window.confirm(`确认删除学生「${s.name}」？\n该操作会影响值班表与考勤统计。`);
    if (!ok) return;
    state.students.splice(idx, 1);
    updateStudentStats();
    updateSeatCapacity();
    updateDutySlotInfo();
    renderStudentManagementPage();
    if (state.currentPage === 'rollcall') renderRollcallPage();
    if ($('btnGenerate')) $('btnGenerate').disabled = state.students.length === 0;
    saveStateDebounced();
    showToast(`已删除：${s.name}`, 'success');
}

// ===== 手动添加值班职务 =====
function openAddDutyDialog() {
    const nameEl = $('addDutyName');
    const countEl = $('addDutyCount');
    if (nameEl) nameEl.value = '';
    if (countEl) countEl.value = '1';
    $('addDutyDialog')?.classList.remove('hidden');
    setTimeout(() => nameEl?.focus(), 50);
}
function closeAddDutyDialog() {
    $('addDutyDialog')?.classList.add('hidden');
}
function submitAddDuty() {
    const nameEl = $('addDutyName');
    const countEl = $('addDutyCount');
    const raw = (nameEl?.value || '').trim();
    if (!raw) { showToast('请填写职务名', 'warning'); nameEl?.focus(); return; }
    if (raw.length > 20) { showToast('职务名过长（≤20 字）', 'warning'); return; }
    // 去重
    if (Object.prototype.hasOwnProperty.call(state.dutyCounts, raw)) {
        showToast(`职务「${raw}」已存在`, 'warning');
        return;
    }
    const count = Math.max(0, Math.min(5, parseInt(countEl?.value) || 1));
    state.dutyCounts[raw] = count;
    renderDutyChips();
    updateDutySlotInfo();
    saveStateDebounced();
    showToast(`已添加职务：${raw}（${count} 人）`, 'success');
    closeAddDutyDialog();
}

// ===== 删除值班职务 =====
function deleteDuty(name) {
    if (!Object.prototype.hasOwnProperty.call(state.dutyCounts, name)) return;
    const ok = window.confirm(`确认删除职务「${name}」？\n已生成的值班表中该职务将不再出现。`);
    if (!ok) return;
    delete state.dutyCounts[name];
    renderDutyChips();
    updateDutySlotInfo();
    saveStateDebounced();
    showToast(`已删除职务：${name}`, 'success');
}

// ===== 重渲染值班职务 chips =====
// state.dutyCounts 的 key 顺序就是 chip 渲染顺序；新职务添加后会追加在末尾，删除后从 DOM 移除
function renderDutyChips() {
    const wrap = $('dutyCheckboxes');
    if (!wrap) return;
    wrap.innerHTML = Object.keys(state.dutyCounts).map(name => {
        const safe = name.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
        const count = state.dutyCounts[name] || 0;
        return `<span class="duty-chip" data-duty-chip="${safe}">
            <span class="duty-chip-name">${safe}</span>
            <input type="number" class="duty-count" data-duty="${safe}" value="${count}" min="0" max="5">
            <button class="duty-chip-del" title="删除该职务">×</button>
        </span>`;
    }).join('');
}

$('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setStatus('正在解析Excel文件...');
    try {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

        const students = parseStudents(rows);

        if (students.length === 0) {
            showToast('未识别到学生数据，请检查文件格式', 'error');
            setStatus('导入失败');
            return;
        }

        state.students = students;
        updateStudentStats();
        updateSeatCapacity();
        updateDutySlotInfo();
        $('btnGenerate').disabled = false;
        setStatus(`已导入 ${students.length} 名学生`);
        showToast(`成功导入 ${students.length} 名学生`, 'success');

        saveState();
        // 如果当前在学生管理页面，刷新列表
        if (state.currentPage === 'students') renderStudentManagementPage();
    } catch (err) {
        console.error(err);
        showToast('文件解析失败：' + err.message, 'error');
        setStatus('导入失败');
    }
    e.target.value = '';
});

/**
 * 智能解析学生数据
 */
function parseStudents(rows) {
    const students = [];
    const seen = new Set();

    let nameCol1 = -1, genderCol1 = -1;
    let nameCol2 = -1, genderCol2 = -1;

    const headerRow = rows[0] || [];
    for (let i = 0; i < headerRow.length; i++) {
        const cell = String(headerRow[i] || '').trim();
        if (cell === '姓名') {
            if (nameCol1 === -1) nameCol1 = i;
            else if (nameCol2 === -1) nameCol2 = i;
        } else if (cell === '性别') {
            if (genderCol1 === -1) genderCol1 = i;
            else if (genderCol2 === -1) genderCol2 = i;
        }
    }

    if (nameCol1 === -1 || genderCol1 === -1) {
        for (let r = 0; r < Math.min(rows.length, 5); r++) {
            for (let c = 0; c < (rows[r] || []).length; c++) {
                const v = String(rows[r][c] || '').trim();
                if (v.includes('姓名') && nameCol1 === -1) nameCol1 = c;
                if (v.includes('性别') && genderCol1 === -1) genderCol1 = c;
            }
            if (nameCol1 !== -1 && genderCol1 !== -1) break;
        }
    }

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r] || [];
        if (!row.length) continue;

        const pairs = [
            [nameCol1, genderCol1],
            [nameCol2, genderCol2]
        ];

        for (const [nc, gc] of pairs) {
            if (nc === -1 || gc === -1) continue;
            const name = String(row[nc] || '').trim();
            const genderRaw = String(row[gc] || '').trim();
            if (!name) continue;

            if (['星期', '周', '职务', '周一', '周二', '周三', '周四', '周五'].includes(name)) continue;

            let displayName = name;
            if (/^\d+$/.test(name)) {
                displayName = '学生' + name;
            }

            let gender = normalizeGender(genderRaw);
            if (!gender) gender = guessGender(name);

            const key = displayName + '|' + gender;
            if (seen.has(key)) continue;
            seen.add(key);

            students.push({ name: displayName, gender });
        }
    }

    return students;
}

function normalizeGender(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    if (['男', 'M', 'm', 'male', 'Male', '男同学'].includes(s)) return '男';
    if (['女', 'F', 'f', 'female', 'Female', '女同学'].includes(s)) return '女';
    return '';
}

function guessGender(name) {
    return '';
}

// ===== 更新学生统计 =====
function updateStudentStats() {
    const stats = {
        total: state.students.length,
        male: state.students.filter(s => s.gender === '男').length,
        female: state.students.filter(s => s.gender === '女').length,
    };

    // 侧边栏
    $('navStudentCount').textContent = stats.total;

    // 顶部迷你统计已移除
    // 学生管理页面
    if ($('pageTotalCount')) $('pageTotalCount').textContent = stats.total;
    if ($('pageMaleCount')) $('pageMaleCount').textContent = stats.male;
    if ($('pageFemaleCount')) $('pageFemaleCount').textContent = stats.female;
}

// ===== 学生管理页面渲染 =====
function renderStudentManagementPage() {
    updateStudentStats();

    const list = $('pageStudentList');
    const hint = $('restingHint');

    if (state.students.length === 0) {
        list.innerHTML = '<div class="empty-state" style="grid-column: 1/-1; padding: 60px 20px;">' +
            '<div class="empty-icon">📂</div>' +
            '<p>暂无学生数据，请先导入</p></div>';
        if (hint) hint.style.display = 'none';
        return;
    }

    if (hint) hint.style.display = 'block';

    const restingCount = state.students.filter(s => s.resting).length;

    list.innerHTML = state.students.map((s, idx) => {
        const genderCls = s.gender === '男' ? 'male' : 'female';
        const genderText = s.gender || '未知';
        const resting = !!s.resting;
        const cardCls = resting ? 'student-card student-card-resting' : 'student-card';
        const restLabel = resting ? '🟡 轮空中' : '正常';
        return `<div class="${cardCls}" data-idx="${idx}">
            <div class="student-name">${s.name}</div>
            <span class="student-gender ${genderCls}">${genderText}</span>
            <label class="rest-toggle">
                <input type="checkbox" class="rest-checkbox" data-idx="${idx}" ${resting ? 'checked' : ''}>
                <span>${restLabel}</span>
            </label>
            <button class="student-card-del" data-idx="${idx}" title="删除该学生">×</button>
        </div>`;
    }).join('');

    // 绑定轮空切换事件
    list.querySelectorAll('.rest-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            state.students[idx].resting = e.target.checked;
            renderStudentManagementPage();
            updateDutySlotInfo();
            // 如果在随机点名页，同步刷新
            if (state.currentPage === 'rollcall') renderRollcallPage();
            // 如果已生成值班表，提示需要重新生成
            if (state.schedule) {
                showToast('轮空状态已更新，请重新生成值班表', 'warning');
                $('btnGenerate').disabled = false;
            }
            saveStateDebounced();
        });
    });

    // 顶部统计区补充"轮空人数"
    const statGrid = list.previousElementSibling;
    let restingStat = $('pageRestingCount');
    if (!restingStat && statGrid) {
        // 已在updateStudentStats中添加
    }
}

// 更新学生统计（包含轮空人数）
function updateStudentStats() {
    const stats = {
        total: state.students.length,
        male: state.students.filter(s => s.gender === '男').length,
        female: state.students.filter(s => s.gender === '女').length,
        resting: state.students.filter(s => s.resting).length,
    };

    $('navStudentCount').textContent = stats.total;

    if ($('pageTotalCount')) $('pageTotalCount').textContent = stats.total;
    if ($('pageMaleCount')) $('pageMaleCount').textContent = stats.male;
    if ($('pageFemaleCount')) $('pageFemaleCount').textContent = stats.female;

    let restingEl = $('pageRestingCount');
    if (!restingEl) {
        // 在学生管理页的统计区插入"轮空"卡片
        const grid = document.querySelector('.student-stats-grid');
        if (grid) {
            const div = document.createElement('div');
            div.className = 'stat-card stat-resting';
            div.innerHTML = `<div class="stat-card-num" id="pageRestingCount">0</div><div class="stat-card-label">轮空</div>`;
            grid.appendChild(div);
            restingEl = $('pageRestingCount');
        }
    }
    if (restingEl) restingEl.textContent = stats.resting;

    // 当前在随机点名页面时同步刷新统计与转盘
    if (state.currentPage === 'rollcall' && typeof renderRollcallPage === 'function') {
        renderRollcallPage();
    }
}

// 清空学生（一键重置本地所有记录，保留排班/座位/点名配置项）
$('btnClearStudents').addEventListener('click', () => {
    if (state.students.length === 0) {
        showToast('当前没有学生数据', 'info');
        return;
    }
    if (confirm(`确认清空全部 ${state.students.length} 名学生？\n\n将同时清空：\n· 值班表\n· 座位表\n· 随机点名记录\n· 考勤记录\n· 积分记录\n· 本地所有缓存\n\n此操作不可撤销。`)) {
        // 1) 重置所有运行时结果数据（配置项保留：起始日期/周期/策略/职务数/座位行列/点名选项）
        state.students = [];
        state.schedule = null;
        state.seating = null;
        state.rollcall.history = [];
        state.rollcall.lastResult = null;
        state.attendance = { view: 'week', anchorDate: null, records: {}, initializedAt: null };
        state.score = { view: 'ranking', log: [] };

        // 2) 清空 localStorage 中本应用的所有键（含历史版本残留）
        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.startsWith('class-workbench')) localStorage.removeItem(k);
            }
        } catch (err) { /* ignore */ }

        // 3) 重置各页面 DOM 与状态
        updateStudentStats();
        updateSeatCapacity();
        updateDutySlotInfo();
        renderStudentManagementPage();
        $('dutyTableContainer').innerHTML = '<div class="empty-state"><div class="empty-icon">📅</div><p>请先导入学生数据，然后点击"生成值班表"</p></div>';
        $('seatingContainer').innerHTML = '<div class="empty-state"><div class="empty-icon">🪑</div><p>请先导入学生数据，设置排数和列数后点击"随机排座"</p></div>';
        $('btnGenerate').disabled = true;
        $('btnExport').disabled = true;
        $('btnPrint').disabled = true;
        $('btnSeatExport').disabled = true;
        $('btnSeatPrint').disabled = true;
        $('currentWeek').textContent = '';

        // 4) 同步刷新当前所在页面（其它页面在切换时也会重新渲染）
        if (state.currentPage === 'rollcall' && typeof renderRollcallPage === 'function') {
            renderRollcallPage();
        }
        if (state.currentPage === 'attendance' && typeof renderAttendancePage === 'function') {
            renderAttendancePage();
        }
        if (state.currentPage === 'score' && typeof renderScorePage === 'function') {
            renderScorePage();
        }
        setStatus('已重置全部本地记录');

        showToast('已清空全部本地记录，恢复到最初状态', 'success');
    }
});

// ===== 考勤记录 =====
const ATTENDANCE_STATUS = ['present', 'late', 'leave', 'makeup']; // null → present → late → leave → makeup → null
const ATTENDANCE_LABELS = {
    present: '✓ 出勤',
    late: '⏰ 迟到',
    leave: '📨 请假',
    makeup: '🔁 补到',
};
const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parseYmd(s) {
    if (!s || typeof s !== 'string') return null;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
}

function getWeekDates(anchorYmd) {
    const d = parseYmd(anchorYmd) || new Date();
    // 把日期对齐到本周一
    const dow = d.getDay(); // 0=Sun
    const offsetToMon = (dow + 6) % 7;
    d.setDate(d.getDate() - offsetToMon);
    const arr = [];
    for (let i = 0; i < 5; i++) {
        const x = new Date(d);
        x.setDate(d.getDate() + i);
        arr.push(ymd(x));
    }
    return arr;
}

function getMonthDates(anchorYmd) {
    const d = parseYmd(anchorYmd) || new Date();
    const y = d.getFullYear();
    const m = d.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    const arr = [];
    for (let i = 1; i <= last; i++) arr.push(`${y}-${pad2(m + 1)}-${pad2(i)}`);
    return arr;
}

function formatAnchorLabel(anchorYmd, view) {
    const d = parseYmd(anchorYmd) || new Date();
    if (view === 'month') return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
    const dates = getWeekDates(anchorYmd);
    const a = parseYmd(dates[0]);
    const b = parseYmd(dates[4]);
    return `第 ${Math.ceil((((a - new Date(a.getFullYear(), 0, 1)) / 86400000) + new Date(a.getFullYear(), 0, 1).getDay() + 1) / 7) || 1} 周（${dates[0]} ~ ${dates[4]}）`;
}

function shiftAnchor(anchorYmd, view, delta) {
    const d = parseYmd(anchorYmd) || new Date();
    if (view === 'month') d.setMonth(d.getMonth() + delta);
    else d.setDate(d.getDate() + 7 * delta);
    return ymd(d);
}

function getAttendanceCell(dateStr, studentName) {
    const dayMap = state.attendance.records[dateStr];
    if (!dayMap) return { status: null, note: '' };
    const cell = dayMap[studentName];
    return cell ? { status: cell.status || null, note: cell.note || '' } : { status: null, note: '' };
}

function setAttendanceCell(dateStr, studentName, status, note = '') {
    if (!state.attendance.records[dateStr]) state.attendance.records[dateStr] = {};
    if (status === null && !note) {
        // 完全清空时移除该键，保持 records 精简
        const dayMap = state.attendance.records[dateStr];
        if (dayMap[studentName]) {
            delete dayMap[studentName];
            if (Object.keys(dayMap).length === 0) delete state.attendance.records[dateStr];
        }
    } else {
        state.attendance.records[dateStr][studentName] = { status, note };
    }
}

function nextStatus(current) {
    const i = ATTENDANCE_STATUS.indexOf(current);
    return i === -1 ? ATTENDANCE_STATUS[0] : ATTENDANCE_STATUS[(i + 1) % ATTENDANCE_STATUS.length];
}

function activeStudents() {
    // 不计轮空
    return state.students.filter(s => !s.resting);
}

function renderAttendanceControls() {
    const view = state.attendance.view;
    const wkBtn = $('attendanceViewWeek');
    const moBtn = $('attendanceViewMonth');
    if (wkBtn) wkBtn.classList.toggle('active', view === 'week');
    if (moBtn) moBtn.classList.toggle('active', view === 'month');

    const anchor = state.attendance.anchorDate || ymd(new Date());
    state.attendance.anchorDate = anchor;
    const dateInput = $('attendanceAnchorDate');
    if (dateInput) dateInput.value = anchor;

    const label = $('attendanceAnchorLabel');
    if (label) label.textContent = formatAnchorLabel(anchor, view);
}

function renderAttendanceTable() {
    const container = $('attendanceTableContainer');
    if (!container) return;

    if (state.students.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>请先在「学生管理」导入学生数据</p></div>';
        return;
    }

    const view = state.attendance.view;
    const dates = view === 'month' ? getMonthDates(state.attendance.anchorDate) : getWeekDates(state.attendance.anchorDate);
    const today = ymd(new Date());

    // 表头：第一列"学生"，其余每个日期一列
    const thead = ['<tr><th class="att-th-student">学生</th>'];
    dates.forEach(d => {
        const dt = parseYmd(d);
        const dow = dt.getDay();
        const isWeekend = dow === 0 || dow === 6;
        const isToday = d === today;
        const cls = ['att-th-date'];
        if (isWeekend) cls.push('weekend');
        if (isToday) cls.push('today');
        thead.push(`<th class="${cls.join(' ')}">${d.slice(5)}<br><span class="att-th-dow">${DAY_NAMES[dow]}</span></th>`);
    });
    thead.push('<th class="att-th-stat">出勤</th><th class="att-th-stat">迟到</th><th class="att-th-stat">请假</th><th class="att-th-stat">补到</th><th class="att-th-stat">出勤率</th>');
    thead.push('</tr>');

    // 表体
    const tbody = [];
    state.students.forEach((s, idx) => {
        const cells = [];
        let cntP = 0, cntL = 0, cntLv = 0, cntM = 0, cntTracked = 0;
        dates.forEach(d => {
            const cell = getAttendanceCell(d, s.name);
            const status = cell.status;
            if (status) cntTracked++;
            if (status === 'present') cntP++;
            else if (status === 'late') cntL++;
            else if (status === 'leave') cntLv++;
            else if (status === 'makeup') cntM++;
            const statusCls = status ? `cell-${status}` : 'cell-empty';
            const noteAttr = cell.note ? ` data-note="${escapeAttr(cell.note)}"` : '';
            const label = status ? ATTENDANCE_LABELS[status] : '-';
            const noteMark = cell.note ? '<span class="att-note-mark" title="' + escapeAttr(cell.note) + '">📝</span>' : '';
            cells.push(`<td class="att-cell ${statusCls}" data-date="${d}" data-student="${escapeAttr(s.name)}" data-idx="${idx}"${noteAttr}><span class="att-cell-label">${label}</span>${noteMark}<span class="att-cell-menu-btn" title="选择状态">⋮</span></td>`);
        });
        const rate = cntTracked === 0 ? '-' : Math.round((cntP / cntTracked) * 100) + '%';
        const checked = state.attendance.selected[s.name] ? 'checked' : '';
        tbody.push(`<tr${s.resting ? ' class="att-row-resting"' : ''}><td class="att-td-student"><label class="att-student-check"><input type="checkbox" class="att-row-select" data-student="${escapeAttr(s.name)}" ${checked}><span class="att-student-name">${escapeHtml(s.name)}</span></label></td>${cells.join('')}<td class="att-td-stat att-stat-present">${cntP}</td><td class="att-td-stat att-stat-late">${cntL}</td><td class="att-td-stat att-stat-leave">${cntLv}</td><td class="att-td-stat att-stat-makeup">${cntM}</td><td class="att-td-stat att-stat-rate">${rate}</td></tr>`);
    });

    container.innerHTML = `<div class="attendance-table-scroll"><table class="attendance-table"><thead>${thead.join('')}</thead><tbody>${tbody.join('')}</tbody></table></div>`;

    // 单元格点击：事件委托
    const scroll = container.querySelector('.attendance-table-scroll');
    if (scroll && !scroll.dataset.bound) {
        scroll.addEventListener('click', onAttendanceCellClick);
        scroll.dataset.bound = '1';
    }
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function onAttendanceCellClick(e) {
    const td = e.target.closest('td.att-cell');
    if (!td) return;
    const date = td.dataset.date;
    const studentName = td.dataset.student;
    if (!date || !studentName) return;

    // 点 ⋮ 按钮 → 弹出状态菜单
    if (e.target.classList.contains('att-cell-menu-btn')) {
        e.stopPropagation();
        openAttendanceCellMenu(date, studentName, td);
        return;
    }

    // 单击主体 → 维持原来的循环切换（向后兼容老用户习惯）
    const cur = getAttendanceCell(date, studentName);
    const nxt = nextStatus(cur.status);

    if (nxt === 'leave' || nxt === 'makeup') {
        openAttendanceNoteDialog(date, studentName, nxt, cur.note || '');
    } else {
        setAttendanceCell(date, studentName, nxt, '');
        renderAttendancePage();
        saveStateDebounced();
    }
}

// 弹出 cell 5 状态菜单
function openAttendanceCellMenu(date, studentName, anchorTd) {
    const menu = $('attendanceCellMenu');
    if (!menu) return;
    menu.dataset.date = date;
    menu.dataset.student = studentName;
    $('attCellMenuLabel').textContent = `${date} · ${studentName}`;
    // 定位到 anchorTd 旁边
    const rect = anchorTd.getBoundingClientRect();
    menu.style.top = (window.scrollY + rect.bottom + 4) + 'px';
    menu.style.left = (window.scrollX + rect.left) + 'px';
    menu.classList.remove('hidden');
}
function closeAttendanceCellMenu() {
    const menu = $('attendanceCellMenu');
    if (menu) menu.classList.add('hidden');
}
function applyAttendanceCellMenu(status) {
    const menu = $('attendanceCellMenu');
    if (!menu) return;
    const date = menu.dataset.date;
    const studentName = menu.dataset.student;
    if (!date || !studentName) return;

    if (!status) {
        // 清除记录
        setAttendanceCell(date, studentName, null, '');
    } else if (status === 'leave' || status === 'makeup') {
        const cur = getAttendanceCell(date, studentName);
        openAttendanceNoteDialog(date, studentName, status, cur.note || '');
        closeAttendanceCellMenu();
        return;
    } else {
        setAttendanceCell(date, studentName, status, '');
    }
    closeAttendanceCellMenu();
    renderAttendancePage();
    saveStateDebounced();
}

function openAttendanceNoteDialog(date, studentName, status, prefilledNote) {
    const dlg = $('attendanceNoteDialog');
    if (!dlg) return;
    dlg.dataset.date = date;
    dlg.dataset.student = studentName;
    dlg.dataset.status = status;
    $('attendanceNoteLabel').textContent = `${date} · ${studentName} · ${ATTENDANCE_LABELS[status]}`;
    $('attendanceNoteInput').value = prefilledNote || '';
    $('attendanceNoteInput').placeholder = status === 'leave' ? '请假事由（可选，如 病假/事假）' : '补到说明（可选）';
    dlg.classList.remove('hidden');
    setTimeout(() => $('attendanceNoteInput').focus(), 50);
}

function closeAttendanceNoteDialog() {
    const dlg = $('attendanceNoteDialog');
    if (dlg) dlg.classList.add('hidden');
}

function confirmAttendanceNote() {
    const dlg = $('attendanceNoteDialog');
    if (!dlg) return;
    const date = dlg.dataset.date;
    const studentName = dlg.dataset.student;
    const status = dlg.dataset.status;
    const note = $('attendanceNoteInput').value.trim();
    // 事由可选：留空也保存，按钮文案提示「可选」
    setAttendanceCell(date, studentName, status, note);
    closeAttendanceNoteDialog();
    renderAttendancePage();
    saveStateDebounced();
}

function cancelAttendanceNote() {
    closeAttendanceNoteDialog();
}

function updateAttendanceStats() {
    const active = activeStudents();
    const total = active.length;
    const dates = state.attendance.view === 'month'
        ? getMonthDates(state.attendance.anchorDate)
        : getWeekDates(state.attendance.anchorDate);
    const today = ymd(new Date());

    let totalPresent = 0, totalTracked = 0;
    let todayPresent = 0;
    let periodLeave = 0, periodLate = 0;

    active.forEach(s => {
        dates.forEach(d => {
            const cell = getAttendanceCell(d, s.name);
            if (cell.status) {
                totalTracked++;
                if (cell.status === 'present') {
                    totalPresent++;
                    if (d === today) todayPresent++;
                } else if (cell.status === 'leave') periodLeave++;
                else if (cell.status === 'late') periodLate++;
            }
        });
    });

    const rate = totalTracked === 0 ? '-' : Math.round((totalPresent / totalTracked) * 100) + '%';
    if ($('attTotalActive')) $('attTotalActive').textContent = total;
    if ($('attTodayPresent')) $('attTodayPresent').textContent = `${todayPresent} / ${total}`;
    if ($('attPeriodLeave')) $('attPeriodLeave').textContent = periodLeave;
    if ($('attOverallRate')) $('attOverallRate').textContent = rate;
}

function renderAttendancePage() {
    renderAttendanceControls();
    updateAttendanceStats();
    renderAttendanceTable();
}

function initAttendanceFromStudents() {
    if (state.students.length === 0) {
        showToast('请先导入学生数据', 'warning');
        return;
    }
    if (Object.keys(state.attendance.records).length > 0) {
        if (!confirm('已有考勤记录确认要再次初始化吗？\n（已有记录不会被清空，仅补齐缺失学生）')) return;
    } else {
        if (!confirm('将从学生名单初始化考勤表，确认？')) return;
    }
    if (!state.attendance.initializedAt) state.attendance.initializedAt = new Date().toISOString();
    // 仅初始化锚点为空；记录保持按天按需创建
    showToast('考勤表已就绪', 'success');
    renderAttendancePage();
    saveStateDebounced();
}

// ===== 一键全员出勤 =====
function openAttendanceAllPresent() {
    if (state.students.length === 0) {
        showToast('请先导入学生数据', 'warning');
        return;
    }
    const today = ymd(new Date());
    const fromEl = $('attAllFrom');
    const toEl = $('attAllTo');
    if (fromEl && !fromEl.value) fromEl.value = today;
    if (toEl && !toEl.value) toEl.value = today;
    $('attendanceAllPresentDialog').classList.remove('hidden');
}
function closeAttendanceAllPresent() {
    $('attendanceAllPresentDialog').classList.add('hidden');
}
function setAttendanceAllPresentRange(quick) {
    const today = ymd(new Date());
    const fromEl = $('attAllFrom');
    const toEl = $('attAllTo');
    if (!fromEl || !toEl) return;
    if (quick === 'today') {
        fromEl.value = today; toEl.value = today;
    } else if (quick === 'week') {
        const dates = getWeekDates(today);
        fromEl.value = dates[0]; toEl.value = dates[dates.length - 1];
    } else if (quick === 'month') {
        const dates = getMonthDates(today);
        fromEl.value = dates[0]; toEl.value = dates[dates.length - 1];
    }
}
function confirmAttendanceAllPresent() {
    const from = $('attAllFrom').value;
    const to = $('attAllTo').value;
    const skipExisting = $('attAllSkip').checked;
    if (!from || !to) { showToast('请选择起止日期', 'warning'); return; }
    if (from > to) { showToast('起始日期不能晚于结束日期', 'warning'); return; }

    // 生成日期数组
    const dates = [];
    let cur = parseYmd(from);
    const end = parseYmd(to);
    while (cur <= end) {
        dates.push(ymd(cur));
        cur.setDate(cur.getDate() + 1);
    }

    const active = activeStudents();
    let set = 0, skipped = 0;
    dates.forEach(d => {
        if (!state.attendance.records[d]) state.attendance.records[d] = {};
        active.forEach(s => {
            const cur = state.attendance.records[d][s.name];
            if (skipExisting && cur && cur.status && cur.status !== 'present') { skipped++; return; }
            state.attendance.records[d][s.name] = { status: 'present', note: '' };
            set++;
        });
    });

    closeAttendanceAllPresent();
    renderAttendancePage();
    saveStateDebounced();
    showToast(`✅ 一键出勤完成：写入 ${set} 条${skipped ? `，跳过 ${skipped} 条已标记状态` : ''}`, 'success');
}


function exportAttendanceExcel(mode) {
    if (state.students.length === 0) {
        showToast('暂无考勤数据可导出', 'warning');
        return;
    }
    mode = mode || 'all';
    // 决定导出哪些学生
    let targets;
    if (mode === 'selected') {
        targets = state.students.filter(s => state.attendance.selected[s.name]);
        if (targets.length === 0) {
            showToast('尚未选中任何学生，请在表格左侧勾选', 'warning');
            return;
        }
    } else {
        targets = state.students.slice();
    }
    const dates = state.attendance.view === 'month'
        ? getMonthDates(state.attendance.anchorDate)
        : getWeekDates(state.attendance.anchorDate);
    const data = [];
    const scopeLabel = mode === 'selected' ? `（已选 ${targets.length} 人）` : '（全部学生）';
    data.push([`考勤记录${scopeLabel}（${dates[0]} ~ ${dates[dates.length - 1]}）`]);
    const head = ['学生'];
    dates.forEach(d => {
        const dt = parseYmd(d);
        head.push(`${d} ${DAY_NAMES[dt.getDay()]}`);
    });
    data.push(head);
    targets.forEach(s => {
        const row = [s.name];
        dates.forEach(d => {
            const cell = getAttendanceCell(d, s.name);
            if (!cell.status) { row.push(''); return; }
            row.push(cell.note ? `${ATTENDANCE_LABELS[cell.status]}(${cell.note})` : ATTENDANCE_LABELS[cell.status]);
        });
        data.push(row);
    });
    // 每日出勤汇总（仅计被导出的非轮空学生）
    data.push([]);
    data.push(['每日出勤 X/Y']);
    dates.forEach(d => {
        let p = 0, total = 0;
        targets.forEach(s => {
            if (s.resting) return;
            const c = getAttendanceCell(d, s.name);
            if (c.status) { total++; if (c.status === 'present') p++; }
        });
        data.push([d, `${p} / ${total}`]);
    });

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 16 }, ...dates.map(() => ({ wch: 14 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '考勤');
    const fname = `考勤_${mode === 'selected' ? '选中' : '全部'}_${dates[0]}_${dates[dates.length - 1]}${state.attendance.view === 'month' ? '_月' : '_周'}.xlsx`;
    XLSX.writeFile(wb, fname);
    showToast('Excel 导出成功', 'success');
}

function printAttendance() { window.print(); }

// ===== 积分统计 =====
// 规则从 state.score.rules 读取（持久化、可编辑）；找不到时回退到默认值
const SCORE_RULES_DEFAULT = {
    attendance: { present: +1, late: -1, makeup: +2, leave: 0 },   // leave 不计分
    duty:       +2,                                                // 完成一次值日
    rollcall:   +1,                                                // 被点到（出勤）
};
function getScoreRules() {
    const r = state.score && state.score.rules;
    if (!r || typeof r !== 'object') return JSON.parse(JSON.stringify(SCORE_RULES_DEFAULT));
    return {
        attendance: {
            present: Number(r.attendance && r.attendance.present) || 0,
            late:    Number(r.attendance && r.attendance.late)    || 0,
            makeup:  Number(r.attendance && r.attendance.makeup)  || 0,
            leave:   Number(r.attendance && r.attendance.leave)   || 0,
        },
        duty:     Number(r.duty)     || 0,
        rollcall: Number(r.rollcall) || 0,
    };
}

const SCORE_REASON_PRESETS = ['+表扬', '+作业优秀', '+积极发言', '-纪律', '-作业未交', '-迟到'];

function scoreKey(date, studentName, source, reason) {
    return `${date}|${studentName}|${source}|${reason || ''}`;
}

function hasScoreEntry(date, studentName, source, reason) {
    const k = scoreKey(date, studentName, source, reason);
    return state.score.log.some(e => scoreKey(e.date, e.studentName, e.source, e.reason) === k);
}

function addScoreEntry(date, studentName, source, delta, reason) {
    if (hasScoreEntry(date, studentName, source, reason)) return false;
    state.score.log.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        date, studentName, source, delta, reason: reason || ''
    });
    return true;
}

function removeScoreEntriesByKey(date, studentName, source, reason) {
    const k = scoreKey(date, studentName, source, reason);
    state.score.log = state.score.log.filter(e => scoreKey(e.date, e.studentName, e.source, e.reason) !== k);
}

// 从考勤 records 补齐所有联动分；幂等：已存在的不会重复添加
function reconcileAttendanceScores() {
    if (!state.attendance.records) return 0;
    const rules = getScoreRules().attendance;
    let added = 0;
    for (const date in state.attendance.records) {
        const dayMap = state.attendance.records[date];
        for (const name in dayMap) {
            const cell = dayMap[name];
            const status = cell && cell.status;
            if (!status || !(status in rules)) continue;
            const delta = rules[status];
            if (delta === 0) continue;
            const reason = `考勤·${ATTENDANCE_LABELS[status].replace(/^[^ ]+ /, '')}`;
            if (addScoreEntry(date, name, 'attendance', delta, reason)) added++;
        }
    }
    return added;
}

// 从值班表 schedule 补齐
function reconcileDutyScores() {
    if (!state.schedule || !state.schedule.schedule) return 0;
    const ruleDuty = getScoreRules().duty;
    let added = 0;
    for (const weekKey in state.schedule.schedule) {
        state.schedule.schedule[weekKey].forEach(dayData => {
            const date = dayData.fullDate;
            dayData.assignments.forEach(a => {
                a.students.forEach(stu => {
                    const reason = `值班·${a.duty}`;
                    if (addScoreEntry(date, stu.name, 'duty', ruleDuty, reason)) added++;
                });
            });
        });
    }
    return added;
}

// 从点名 history 补齐
function reconcileRollcallScores() {
    // 点名命中不再自动加分 —— 由老师点名后在结果区手动点击「加分」控制
    return 0;
}

function reconcileScoreLog() {
    const before = state.score.log.length;
    reconcileAttendanceScores();
    reconcileDutyScores();
    reconcileRollcallScores();
    return state.score.log.length - before;
}

function aggregateByStudent() {
    // 返回 { studentName: { total, plus, minus, recent: [delta, ...] } }
    const map = {};
    state.score.log.forEach(e => {
        if (!map[e.studentName]) map[e.studentName] = { total: 0, plus: 0, minus: 0, recent: [] };
        map[e.studentName].total += e.delta;
        if (e.delta > 0) map[e.studentName].plus += e.delta;
        else if (e.delta < 0) map[e.studentName].minus += e.delta;
        map[e.studentName].recent.push(e.delta);
    });
    // recent 只保留最近 5 条
    Object.values(map).forEach(v => { v.recent = v.recent.slice(-5); });
    return map;
}

function aggregateByDate(days) {
    // 返回 { 'YYYY-MM-DD': { date, deltas: { name: total } } }
    const map = {};
    state.score.log.forEach(e => {
        if (!map[e.date]) map[e.date] = { date: e.date, deltas: {} };
        map[e.date].deltas[e.studentName] = (map[e.date].deltas[e.studentName] || 0) + e.delta;
    });
    return map;
}

function getRecentDateRange(n) {
    const arr = [];
    const d = new Date();
    for (let i = n - 1; i >= 0; i--) {
        const x = new Date(d);
        x.setDate(d.getDate() - i);
        arr.push(ymd(x));
    }
    return arr;
}

function updateScoreStats(agg) {
    const all = Object.values(agg);
    const total = all.reduce((s, v) => s + v.total, 0);
    const plus  = all.reduce((s, v) => s + v.plus, 0);
    const minus = all.reduce((s, v) => s + v.minus, 0);
    const topName = Object.keys(agg).reduce((best, name) => {
        if (!best) return name;
        return agg[name].total > agg[best].total ? name : best;
    }, null);
    const topVal = topName ? agg[topName].total : 0;
    if ($('scoreGrandTotal')) $('scoreGrandTotal').textContent = total;
    if ($('scoreTotalPlus')) $('scoreTotalPlus').textContent = '+' + plus;
    if ($('scoreTotalMinus')) $('scoreTotalMinus').textContent = minus;
    if ($('scoreTopStudent')) $('scoreTopStudent').textContent = topName ? `${topName} ${topVal}` : '—';
}

function renderScoreRanking() {
    const container = $('scoreTableContainer');
    if (!container) return;
    if (state.students.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><p>请先在「学生管理」导入学生数据</p></div>';
        return;
    }
    const agg = aggregateByStudent();
    // 确保每个学生都有行（即使 0 分）
    const rows = state.students.map(s => {
        const a = agg[s.name] || { total: 0, plus: 0, minus: 0, recent: [] };
        const trend = a.recent.map(d => `<span class="score-trend ${d > 0 ? 'plus' : (d < 0 ? 'minus' : 'zero')}">${d > 0 ? '+' : ''}${d}</span>`).join('');
        const medal = s.resting ? '<span class="score-rest-mark">轮空</span>' : '';
        return `<tr data-student="${escapeAttr(s.name)}" class="score-row"><td class="score-rank">—</td><td class="score-name"><span class="att-student-name">${escapeHtml(s.name)}</span>${medal}</td><td class="score-total ${a.total > 0 ? 'plus' : (a.total < 0 ? 'minus' : 'zero')}">${a.total}</td><td class="score-plus">+${a.plus}</td><td class="score-minus">${a.minus}</td><td class="score-trend-cell">${trend || '<span class="score-trend zero">-</span>'}</td><td class="score-actions-cell"><button class="btn btn-mini btn-mini-plus" data-act="plus">+</button><button class="btn btn-mini btn-mini-minus" data-act="minus">−</button></td></tr>`;
    });
    // 排序：按 total 降序，0 分和未出现的靠后
    rows.sort((a, b) => {
        const an = nameFromRow(a), bn = nameFromRow(b);
        const av = (agg[an] || { total: 0 }).total;
        const bv = (agg[bn] || { total: 0 }).total;
        if (bv !== av) return bv - av;
        return an.localeCompare(bn, 'zh-CN');
    });

    container.innerHTML = `<div class="attendance-table-scroll"><table class="score-table"><thead><tr><th>排名</th><th>学生</th><th>总分</th><th>加分</th><th>减分</th><th>近期</th><th>操作</th></tr></thead><tbody>${rows.map((r, i) => r.replace('<td class="score-rank">—</td>', `<td class="score-rank">${i + 1}</td>`)).join('')}</tbody></table></div>`;

    bindScoreRowActions(container);
}

function nameFromRow(rowHtml) {
    const m = rowHtml.match(/data-student="([^"]+)"/);
    return m ? decodeURIComponent(m[1]).replace(/&quot;/g, '"').replace(/&#39;/g, "'") : '';
}

function bindScoreRowActions(container) {
    const scroll = container.querySelector('.attendance-table-scroll');
    if (!scroll || scroll.dataset.bound) return;
    scroll.dataset.bound = '1';
    scroll.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (btn) {
            // 点 +/- 按钮只弹加减分，不弹明细
            const tr = btn.closest('tr.score-row');
            if (!tr) return;
            e.stopPropagation();
            openScoreAdjustDialog(tr.dataset.student, btn.dataset.act === 'plus' ? 1 : -1);
            return;
        }
        // 点行其他位置 → 弹该学生的积分明细
        const tr = e.target.closest('tr.score-row');
        if (!tr) return;
        openScoreDetailDialog(tr.dataset.student);
    });
    // hover 提示整行可点击
    scroll.addEventListener('mousemove', () => {});
}

function renderScoreDetail() {
    const container = $('scoreTableContainer');
    if (!container) return;
    if (state.students.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><p>请先在「学生管理」导入学生数据</p></div>';
        return;
    }
    const days = getRecentDateRange(30);
    const dayMap = aggregateByDate(30);
    const thead = ['<tr><th class="att-th-student">学生</th>'];
    days.forEach(d => {
        const isToday = d === ymd(new Date());
        thead.push(`<th class="att-th-date${isToday ? ' today' : ''}">${d.slice(5)}</th>`);
    });
    thead.push('<th class="att-th-stat">加分</th><th class="att-th-stat">减分</th><th class="att-th-stat">净分</th></tr>');

    const tbody = [];
    state.students.forEach(s => {
        const cells = [];
        let plus = 0, minus = 0;
        days.forEach(d => {
            const day = dayMap[d];
            const v = day && day.deltas[s.name];
            if (v > 0) plus += v;
            else if (v < 0) minus += v;
            const cls = v > 0 ? 'cell-present' : (v < 0 ? 'cell-late' : 'cell-empty');
            const label = v ? (v > 0 ? '+' + v : v) : '-';
            cells.push(`<td class="att-cell ${cls}">${label}</td>`);
        });
        tbody.push(`<tr${s.resting ? ' class="att-row-resting"' : ''}><td class="att-td-student"><span class="att-student-name">${escapeHtml(s.name)}</span></td>${cells.join('')}<td class="att-td-stat att-stat-present">+${plus}</td><td class="att-td-stat att-stat-late">${minus}</td><td class="att-td-stat att-stat-rate">${plus + minus}</td></tr>`);
    });

    container.innerHTML = `<div class="attendance-table-scroll"><table class="score-table"><thead>${thead.join('')}</thead><tbody>${tbody.join('')}</tbody></table></div>`;
}

function renderScoreControls() {
    const view = state.score.view;
    const rk = $('scoreViewRanking');
    const dt = $('scoreViewDetail');
    if (rk) rk.classList.toggle('active', view === 'ranking');
    if (dt) dt.classList.toggle('active', view === 'detail');
}

function renderScorePage() {
    reconcileScoreLog();
    renderScoreControls();
    renderScoreRulesTip();
    updateScoreStats(aggregateByStudent());
    if (state.score.view === 'detail') renderScoreDetail();
    else renderScoreRanking();
}

function openScoreAdjustDialog(studentName, sign) {
    const dlg = $('scoreAdjustDialog');
    if (!dlg) return;
    dlg.dataset.student = studentName;
    dlg.dataset.sign = String(sign);
    $('scoreAdjustLabel').textContent = `${studentName} · ${sign > 0 ? '加分' : '减分'}`;
    $('scoreAdjustDelta').value = '1';
    $('scoreAdjustReason').value = '';
    // 渲染原因预设
    const presetBox = $('scoreAdjustPresets');
    if (presetBox) {
        presetBox.innerHTML = SCORE_REASON_PRESETS.map(p => `<button type="button" class="score-preset-btn" data-text="${escapeAttr(p)}">${escapeHtml(p)}</button>`).join('');
    }
    dlg.classList.remove('hidden');
    setTimeout(() => $('scoreAdjustDelta').focus(), 50);
}

function closeScoreAdjustDialog() { const d = $('scoreAdjustDialog'); if (d) d.classList.add('hidden'); }

function confirmScoreAdjust() {
    const dlg = $('scoreAdjustDialog');
    if (!dlg) return;
    const studentName = dlg.dataset.student;
    const sign = parseInt(dlg.dataset.sign, 10) || 1;
    const amount = Math.max(1, Math.min(99, parseInt($('scoreAdjustDelta').value, 10) || 1));
    const reason = $('scoreAdjustReason').value.trim() || (sign > 0 ? '手动加分' : '手动减分');
    const delta = sign * amount;
    const date = ymd(new Date());
    if (!addScoreEntry(date, studentName, 'manual', delta, reason)) {
        showToast('该记录已存在', 'info');
    }
    closeScoreAdjustDialog();
    renderScorePage();
    saveStateDebounced();
}

// ===== 学生积分明细弹窗 =====
function openScoreDetailDialog(studentName) {
    const dlg = $('scoreDetailDialog');
    if (!dlg) return;
    // 该学生的所有积分记录（按时间倒序）
    const entries = state.score.log
        .filter(e => e.studentName === studentName)
        .sort((a, b) => {
            // 倒序：日期降序 + ts 降序
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            return (b.ts || 0) - (a.ts || 0);
        });
    const total = entries.reduce((s, e) => s + e.delta, 0);
    const plus = entries.filter(e => e.delta > 0).reduce((s, e) => s + e.delta, 0);
    const minus = entries.filter(e => e.delta < 0).reduce((s, e) => s + e.delta, 0);

    // 统计各来源
    const bySource = {};
    entries.forEach(e => {
        if (!bySource[e.source]) bySource[e.source] = { count: 0, sum: 0 };
        bySource[e.source].count++;
        bySource[e.source].sum += e.delta;
    });
    const sourceRows = Object.keys(bySource).sort((a, b) => bySource[b].sum - bySource[a].sum)
        .map(s => `<div class="score-detail-source"><span class="score-source-tag tag-${s}">${sourceLabel(s)}</span><span class="score-source-count">${bySource[s].count} 条</span><span class="score-source-sum ${bySource[s].sum > 0 ? 'plus' : (bySource[s].sum < 0 ? 'minus' : 'zero')}">${bySource[s].sum > 0 ? '+' : ''}${bySource[s].sum}</span></div>`)
        .join('');

    const listHtml = entries.length === 0
        ? '<div class="score-detail-empty">暂无积分记录</div>'
        : entries.map(e => {
            const tag = `<span class="score-source-tag tag-${e.source}">${sourceLabel(e.source)}</span>`;
            const reason = e.reason ? `<span class="score-detail-reason">${escapeHtml(e.reason)}</span>` : '<span class="score-detail-reason muted">（无理由）</span>';
            const deltaCls = e.delta > 0 ? 'plus' : (e.delta < 0 ? 'minus' : 'zero');
            const deltaText = e.delta > 0 ? '+' + e.delta : e.delta;
            return `<div class="score-detail-item">
                <div class="score-detail-date">${e.date}</div>
                <div class="score-detail-tag">${tag}</div>
                <div class="score-detail-reason-wrap">${reason}</div>
                <div class="score-detail-delta ${deltaCls}">${deltaText}</div>
            </div>`;
        }).join('');

    dlg.querySelector('#scoreDetailTitle').textContent = `📋 ${studentName} 的积分明细`;
    dlg.querySelector('#scoreDetailSummary').innerHTML = `
        <div class="score-detail-card"><div class="score-detail-card-num ${total > 0 ? 'plus' : (total < 0 ? 'minus' : 'zero')}">${total}</div><div class="score-detail-card-label">净分</div></div>
        <div class="score-detail-card"><div class="score-detail-card-num plus">+${plus}</div><div class="score-detail-card-label">总加分</div></div>
        <div class="score-detail-card"><div class="score-detail-card-num minus">${minus}</div><div class="score-detail-card-label">总减分</div></div>
        <div class="score-detail-card"><div class="score-detail-card-num">${entries.length}</div><div class="score-detail-card-label">记录数</div></div>
    `;
    dlg.querySelector('#scoreDetailSourceSummary').innerHTML = sourceRows || '';
    dlg.querySelector('#scoreDetailList').innerHTML = listHtml;
    dlg.querySelector('#scoreDetailFooter').textContent = `共 ${entries.length} 条记录，加分 ${plus} / 减分 ${minus}`;
    dlg.classList.remove('hidden');
}

function closeScoreDetailDialog() {
    const dlg = $('scoreDetailDialog');
    if (dlg) dlg.classList.add('hidden');
}

function exportScoreExcel() {
    if (state.students.length === 0) { showToast('暂无积分数据', 'warning'); return; }
    const agg = aggregateByStudent();
    const rows = state.students.map(s => {
        const a = agg[s.name] || { total: 0, plus: 0, minus: 0, recent: [] };
        return [s.name, a.plus, a.minus, a.total];
    }).sort((a, b) => b[3] - a[3]);
    const data = [
        ['积分统计（' + ymd(new Date()) + '）'],
        ['学生', '加分', '减分', '净分'],
        ...rows,
        [],
        ['明细日志'],
        ['日期', '学生', '来源', '分值', '原因'],
        ...state.score.log.slice().sort((a, b) => a.date.localeCompare(b.date)).map(e => [e.date, e.studentName, sourceLabel(e.source), e.delta, e.reason])
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '积分');
    XLSX.writeFile(wb, `积分统计_${ymd(new Date())}.xlsx`);
    showToast('Excel 导出成功', 'success');
}

function sourceLabel(s) {
    return { attendance: '考勤', duty: '值班', rollcall: '点名', manual: '手动' }[s] || s;
}
function printScore() { window.print(); }

// ===== 积分规则编辑 =====
// 用当前规则生成顶部那行简短提示
function renderScoreRulesTip() {
    const el = $('scoreRulesTip');
    if (!el) return;
    const r = getScoreRules();
    const a = r.attendance;
    const fmt = v => (v > 0 ? `+${v}` : `${v}`);
    el.textContent = `出勤${fmt(a.present)} / 迟到${fmt(a.late)} / 补到${fmt(a.makeup)} / 请假${fmt(a.leave)} · 值日${fmt(r.duty)} · 点名手动加分 · 点「⚙️ 规则」可改`;
}

// 把当前规则写回 state.score.rules（保证结构完整）
function writeScoreRules(rules) {
    state.score.rules = {
        attendance: {
            present: Number(rules.attendance.present) || 0,
            late:    Number(rules.attendance.late)    || 0,
            makeup:  Number(rules.attendance.makeup)  || 0,
            leave:   Number(rules.attendance.leave)   || 0,
        },
        duty:     Number(rules.duty)     || 0,
        rollcall: Number(rules.rollcall) || 0,
    };
}

function openScoreRulesDialog() {
    const dlg = $('scoreRulesDialog');
    if (!dlg) return;
    const r = getScoreRules();
    $('ruleAttPresent').value = r.attendance.present;
    $('ruleAttLate').value    = r.attendance.late;
    $('ruleAttMakeup').value  = r.attendance.makeup;
    $('ruleAttLeave').value   = r.attendance.leave;
    $('ruleDuty').value       = r.duty;
    // rollcall 不在 UI 中暴露（点名命中由老师手动加分）
    dlg.classList.remove('hidden');
}

function closeScoreRulesDialog() {
    const dlg = $('scoreRulesDialog');
    if (dlg) dlg.classList.add('hidden');
}

function resetScoreRulesDialog() {
    const r = SCORE_RULES_DEFAULT;
    $('ruleAttPresent').value = r.attendance.present;
    $('ruleAttLate').value    = r.attendance.late;
    $('ruleAttMakeup').value  = r.attendance.makeup;
    $('ruleAttLeave').value   = r.attendance.leave;
    $('ruleDuty').value       = r.duty;
}

// 保存规则：先清掉所有联动分（attendance/duty/rollcall），按新规则重新生成
function saveScoreRules() {
    const oldRules = getScoreRules();
    const newRules = {
        attendance: {
            present: Number($('ruleAttPresent').value),
            late:    Number($('ruleAttLate').value),
            makeup:  Number($('ruleAttMakeup').value),
            leave:   Number($('ruleAttLeave').value),
        },
        duty:     Number($('ruleDuty').value),
        rollcall: oldRules.rollcall || 0,
    };
    // 1) 写规则
    writeScoreRules(newRules);
    // 2) 清掉所有联动源记录（手动 source=manual 保留）
    const before = state.score.log.length;
    state.score.log = state.score.log.filter(e => e.source === 'manual');
    const removed = before - state.score.log.length;
    // 3) 按新规则重新生成联动分
    const added = reconcileScoreLog();
    closeScoreRulesDialog();
    renderScoreRulesTip();
    renderScorePage();
    saveState();
    showToast(`规则已更新：清掉 ${removed} 条旧联动，加回 ${added} 条（手动分 ${state.score.log.filter(e => e.source === 'manual').length} 条保留）`, 'success');
}

// ===== 值班表生成 =====
/**
 * 顶部「每周坑位 / 可排人数」提示。
 * 坑位多于可排人数时必然出现补位，少于时必然有人轮空，提前把差额说清楚。
 */
function updateDutySlotInfo() {
    const el = $('dutySlotInfo');
    if (!el) return;

    let perDay = 0;
    document.querySelectorAll('#dutyCheckboxes .duty-count').forEach(input => {
        perDay += parseInt(input.value) || 0;
    });
    const slots = perDay * 5;
    const active = state.students.filter(s => !s.resting).length;

    let suffix = '';
    if (active > 0 && slots > active) suffix = `　→ 每周 ${slots - active} 个补位`;
    else if (active > slots) suffix = `　→ 每周 ${active - slots} 人轮空`;

    el.textContent = `每周坑位 ${slots} ／ 可排 ${active} 人${suffix}`;
    el.classList.toggle('warn', active > 0 && slots > active);
}

// 职务人数调整：事件委托，覆盖动态新增的 chip
document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains('duty-count')) return;
    if (!t.closest || !t.closest('#dutyCheckboxes')) return;
    const name = t.dataset.duty;
    const v = parseInt(t.value) || 0;
    state.dutyCounts[name] = v;
    updateDutySlotInfo();
    saveStateDebounced();
});

function generateDutyTable() {
    if (state.students.length === 0) {
        showToast('请先导入学生数据', 'warning');
        return;
    }

    setStatus('正在生成值班表...');

    const startDate = $('startDate').value;
    const weekCycle = parseInt($('weekCycle').value);
    const strategy = $('strategy').value;
    const duties = [];

    document.querySelectorAll('#dutyCheckboxes .duty-count').forEach(input => {
        const duty = input.dataset.duty;
        const count = parseInt(input.value) || 0;
        if (count > 0) duties.push({ name: duty, count });
    });

    if (duties.length === 0) {
        showToast('请至少设置一个职务（人数>0）', 'warning');
        return;
    }

    if (startDate) state.startDate = startDate;
    if (!state.startDate) {
        const now = new Date();
        const day = now.getDay() || 7;
        const monday = new Date(now);
        monday.setDate(now.getDate() - day + 1);
        state.startDate = monday.toISOString().slice(0, 10);
        $('startDate').value = state.startDate;
    }

    state.weekCycle = weekCycle;

    state.schedule = generateSchedule({
        students: state.students,
        duties,
        startDate: state.startDate,
        weekCount: weekCycle,
        strategy,
    });

    $('navWeekCount').textContent = weekCycle;
    $('btnExport').disabled = false;
    $('btnPrint').disabled = false;
    setStatus('值班表已生成');
    showToast('值班表生成成功！', 'success');

    saveState();

    // 跳转到值班表页面
    switchPage('duty');
    renderDutyTable();
}

$('btnGenerate').addEventListener('click', generateDutyTable);

/**
 * 智能排班算法（轮空+下周优先）
 */
function generateSchedule({ students, duties, startDate, weekCount, strategy }) {
    const days = ['周一', '周二', '周三', '周四', '周五'];
    const schedule = {};
    const startDateObj = new Date(startDate);

    // 排除轮空学生
    const activeStudents = students.filter(s => !s.resting);

    const assignedCount = {};
    activeStudents.forEach(s => assignedCount[s.name] = 0);

    let restQueue = [];

    for (let w = 0; w < weekCount; w++) {
        const weekKey = `第${w + 1}周`;
        schedule[weekKey] = [];

        const usedThisWeek = new Set();
        const weekRest = [];

        for (let d = 0; d < days.length; d++) {
            const dateObj = new Date(startDateObj);
            dateObj.setDate(startDateObj.getDate() + w * 7 + d);
            const dateStr = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;

            const dayData = {
                day: days[d],
                date: dateStr,
                fullDate: dateObj.toISOString().slice(0, 10),
                assignments: duties.map(d => ({ duty: d.name, students: [] }))
            };

            // 当天已排过班的学生集合，补位时不能再次使用
            const usedToday = new Set();

            for (const dutyCfg of duties) {
                for (let k = 0; k < dutyCfg.count; k++) {
                    const picked = pickStudentAdvanced({
                        students: activeStudents, restQueue, assignedCount, usedThisWeek, usedToday, strategy, duty: dutyCfg.name,
                    });
                    if (picked) {
                        dayData.assignments.find(a => a.duty === dutyCfg.name).students.push(picked);
                        usedThisWeek.add(picked.name);
                        usedToday.add(picked.name);
                    }
                }
            }

            schedule[weekKey].push(dayData);
        }

        activeStudents.forEach(s => {
            if (!usedThisWeek.has(s.name)) weekRest.push(s);
        });
        restQueue = weekRest;
    }

    return {
        schedule,
        startDate,
        weekCount,
        duties: duties.map(d => d.name),
        days
    };
}

function pickStudentAdvanced({ students, restQueue, assignedCount, usedThisWeek, usedToday, strategy, duty }) {
    // 基础筛选：非轮空 + 本周未排 + 当天未排
    const basePool = students.filter(s =>
        !s.resting &&
        !usedThisWeek.has(s.name) &&
        !(usedToday && usedToday.has(s.name))
    );

    // 第一优先：上周轮空、本周优先补回来
    let pool = restQueue.filter(s => basePool.some(b => b.name === s.name));

    // 第二优先：在 basePool 里按性别策略挑选
    if (pool.length === 0) {
        const physicalDuties = ['扫地', '倒垃圾'];
        if (strategy === 'duty-based' && physicalDuties.includes(duty)) {
            // 体力活优先男生；男生空则用女生；都空则用整个 basePool
            const males = basePool.filter(s => s.gender === '男');
            const females = basePool.filter(s => s.gender === '女');
            pool = males.length > 0 ? males : females;
            if (pool.length === 0) pool = basePool;
        } else {
            // 普通岗位：优选人数少的性别；如果该性别在 basePool 里空了，回退到另一性别
            const males = basePool.filter(s => s.gender === '男');
            const females = basePool.filter(s => s.gender === '女');
            if (males.length === 0 && females.length === 0) {
                pool = [];
            } else if (males.length === 0) {
                pool = females;
            } else if (females.length === 0) {
                pool = males;
            } else {
                const maleTotal = males.reduce((sum, s) => sum + (assignedCount[s.name] || 0), 0);
                const femaleTotal = females.reduce((sum, s) => sum + (assignedCount[s.name] || 0), 0);
                // 优选总分配次数少的性别；若该性别在 basePool 中已无未用学生，回退另一性别
                const preferMales = maleTotal <= femaleTotal;
                pool = preferMales ? males : females;
                if (pool.length === 0) pool = preferMales ? females : males;
            }
        }
    }

    // 正常路径：选本周已分配次数最少的人（每人本周最多 1 次，第二次排班会进补位）
    // 返回副本，不能改动 students 里的原对象，否则同一学生在别处出现时会串上补位标记
    if (pool.length > 0) {
        const minCount = Math.min(...pool.map(s => assignedCount[s.name] || 0));
        const candidates = pool.filter(s => (assignedCount[s.name] || 0) === minCount);
        const picked = candidates[Math.floor(Math.random() * candidates.length)];
        assignedCount[picked.name] = (assignedCount[picked.name] || 0) + 1;
        return { ...picked, _makeup: false };
    }

    // 🔴 补位：所有人都已本周排过 → 从非轮空 + 当天未排里随机选（允许本周已用过的）
    const allAvail = students.filter(s =>
        !s.resting &&
        !(usedToday && usedToday.has(s.name))
    );
    if (allAvail.length === 0) return null;
    const minCount = Math.min(...allAvail.map(s => assignedCount[s.name] || 0));
    const candidates = allAvail.filter(s => (assignedCount[s.name] || 0) === minCount);
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    assignedCount[picked.name] = (assignedCount[picked.name] || 0) + 1;
    return { ...picked, _makeup: true };
}

// ===== 渲染值班表 =====
function renderDutyTable() {
    const container = $('dutyTableContainer');
    const { schedule, startDate, weekCount, duties } = state.schedule;

    $('currentWeek').innerHTML = `
        <span>📅 起始日期：<strong>${startDate}</strong> ｜ 共 <strong>${weekCount}</strong> 周 ｜ 每周 5 天</span>
        <span style="color:#10b981;">✓ 已生成</span>
    `;

    const weekRestMap = computeWeekRest(schedule);

    let html = '';
    const weekKeys = Object.keys(schedule);

    for (const weekKey of weekKeys) {
        html += `<div class="week-section" style="margin-bottom: 24px;">`;
        html += `<h3 style="color: #4f46e5; margin-bottom: 12px; font-size: 16px;">📅 ${weekKey}</h3>`;
        html += `<table class="duty-table">`;
        html += `<thead><tr><th>星期</th>`;
        duties.forEach(duty => { html += `<th>${duty}</th>`; });
        html += `</tr></thead>`;
        html += `<tbody>`;

        schedule[weekKey].forEach(dayData => {
            html += '<tr>';
            html += `<td class="day-cell">${dayData.day}<br><span style="font-size:11px;color:#6b7280;">${dayData.date}</span></td>`;

            dayData.assignments.forEach(a => {
                const studentsHtml = a.students.map(stu => {
                    if (!stu) return '';
                    const genderTag = stu.gender
                        ? `<span class="gender ${stu.gender === '男' ? 'male' : 'female'}">${stu.gender}</span>`
                        : '';
                    const makeupTag = stu._makeup
                        ? `<span class="makeup-tag" title="岗位不足，自动补位">补位</span>`
                        : '';
                    return `<div class="student-entry">${stu.name}${genderTag}${makeupTag}</div>`;
                }).join('');
                html += `<td class="duty-staff-cell">${studentsHtml || '—'}</td>`;
            });

            html += '</tr>';
        });

        html += `</tbody></table>`;

        const restList = weekRestMap[weekKey] || [];
        if (restList.length > 0) {
            html += `<div class="week-rest-box">`;
            html += `<strong>🟡 本周轮空 (${restList.length} 人)：</strong> `;
            html += restList.map(s => {
                const tag = s.gender === '男' ? '♂' : s.gender === '女' ? '♀' : '';
                return `<span class="rest-name">${s.name} ${tag}</span>`;
            }).join('');
            html += `<span class="rest-hint">→ 下周优先安排</span>`;
            html += `</div>`;
        }

        html += `</div>`;
    }

    container.innerHTML = html;
}

function computeWeekRest(schedule) {
    const restMap = {};
    for (const weekKey in schedule) {
        const usedNames = new Set();
        schedule[weekKey].forEach(dayData => {
            dayData.assignments.forEach(a => {
                a.students.forEach(stu => {
                    if (stu) usedNames.add(stu.name);
                });
            });
        });
        restMap[weekKey] = state.students.filter(s => !usedNames.has(s.name));
    }
    return restMap;
}

// ===== 导出 Excel =====
$('btnExport').addEventListener('click', () => {
    if (!state.schedule) return;

    const { schedule, startDate, weekCount, duties } = state.schedule;
    const wb = XLSX.utils.book_new();

    for (const weekKey in schedule) {
        const data = [];
        data.push(['值班表（' + weekKey + '）']);
        data.push(['星期', ...duties]);

        schedule[weekKey].forEach(dayData => {
            const row = [dayData.day + ' ' + dayData.date];
            dayData.assignments.forEach(a => {
                const studentsText = a.students.map(s => {
                    return s.gender ? `${s.name}(${s.gender})` : s.name;
                }).join('\n');
                row.push(studentsText || '');
            });
            data.push(row);
        });

        const ws = XLSX.utils.aoa_to_sheet(data);
        ws['!cols'] = [{ wch: 12 }, ...duties.map(() => ({ wch: 18 }))];
        XLSX.utils.book_append_sheet(wb, ws, weekKey);
    }

    const filename = `值班表_${startDate}_${weekCount}周.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast('Excel导出成功', 'success');
});

// ===== 打印 =====
$('btnPrint').addEventListener('click', () => window.print());

// ===== 座位表 =====
function readSeatConfig() {
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    return {
        rows: clamp(parseInt($('seatRows').value) || 1, 1, 20),
        cols: clamp(parseInt($('seatCols').value) || 1, 1, 20),
        mode: $('seatMode').value,
    };
}

// 顶部「座位 / 人数」实时提示，人数超出座位时标红
function updateSeatCapacity() {
    const el = $('seatCapacity');
    if (!el) return;
    const { rows, cols } = readSeatConfig();
    const total = rows * cols;
    el.textContent = `${total} / ${state.students.length}`;
    el.classList.toggle('warn', state.students.length > total);
}

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * 按排列数把学生铺到座位网格上
 * random       —— 完全随机
 * gender-mix   —— 棋盘式男女穿插，某一性别用完后自动用另一性别补
 * gender-block —— 男生一片、女生一片，按行依次铺开
 */
function buildSeating({ students, rows, cols, mode }) {
    const total = rows * cols;
    const seats = Array.from({ length: rows }, () => Array(cols).fill(null));
    const seated = new Set();

    const place = (queue) => {
        let idx = 0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (idx >= queue.length) return;
                seats[r][c] = queue[idx];
                seated.add(queue[idx]);
                idx++;
            }
        }
    };

    if (mode === 'gender-mix') {
        const males = shuffle(students.filter(s => s.gender === '男'));
        const females = shuffle(students.filter(s => s.gender === '女'));
        // 性别未知的并入人数较少的一边，保证不被漏排
        shuffle(students.filter(s => s.gender !== '男' && s.gender !== '女'))
            .forEach(s => (males.length <= females.length ? males : females).push(s));

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const preferMale = (r + c) % 2 === 0;
                const first = preferMale ? males : females;
                const second = preferMale ? females : males;
                const picked = first.shift() || second.shift();
                if (!picked) continue;
                seats[r][c] = picked;
                seated.add(picked);
            }
        }
    } else if (mode === 'gender-block') {
        const males = shuffle(students.filter(s => s.gender === '男'));
        const females = shuffle(students.filter(s => s.gender === '女'));
        const others = shuffle(students.filter(s => s.gender !== '男' && s.gender !== '女'));
        place([...males, ...females, ...others]);
    } else {
        place(shuffle(students));
    }

    const overflow = students.filter(s => !seated.has(s));
    return { rows, cols, mode, total, seats, overflow };
}

function generateSeating() {
    if (state.students.length === 0) {
        showToast('请先在「学生管理」导入学生数据', 'warning');
        return;
    }

    const { rows, cols, mode } = readSeatConfig();
    state.seatingConfig = { rows, cols, mode };
    state.seating = buildSeating({ students: state.students, rows, cols, mode });

    $('btnSeatExport').disabled = false;
    $('btnSeatPrint').disabled = false;
    renderSeating();
    updateSeatCapacity();
    saveState();

    const { overflow } = state.seating;
    if (overflow.length > 0) {
        showToast(`座位不足，有 ${overflow.length} 人未安排`, 'warning');
        setStatus(`座位表已生成（${overflow.length} 人未安排）`);
    } else {
        showToast('座位表生成成功！', 'success');
        setStatus('座位表已生成');
    }
}

function renderSeating() {
    const container = $('seatingContainer');
    if (!state.seating) return;

    const { rows, cols, seats, overflow } = state.seating;

    let html = '<div class="podium">讲 台</div>';
    html += '<div class="seat-grid">';

    for (let r = 0; r < rows; r++) {
        html += '<div class="seat-row">';
        html += `<div class="seat-row-label">第${r + 1}排</div>`;
        for (let c = 0; c < cols; c++) {
            const stu = seats[r][c];
            const seatNo = r * cols + c + 1;
            if (!stu) {
                html += `<div class="seat seat-empty">
                    <div class="seat-no">${seatNo}</div>
                    <div class="seat-name">空位</div>
                </div>`;
                continue;
            }
            const cls = stu.gender === '男' ? 'seat-male' : stu.gender === '女' ? 'seat-female' : '';
            const genderTag = stu.gender
                ? `<span class="seat-gender ${stu.gender === '男' ? 'male' : 'female'}">${stu.gender}</span>`
                : '';
            html += `<div class="seat ${cls}">
                <div class="seat-no">${seatNo}</div>
                <div class="seat-name">${stu.name}</div>
                ${genderTag}
            </div>`;
        }
        html += '</div>';
    }

    html += '</div>';

    if (overflow.length > 0) {
        html += `<div class="seat-overflow-box"><strong>⚠️ 座位不足，${overflow.length} 人未安排：</strong> `;
        html += overflow.map(s => `<span class="rest-name">${s.name}</span>`).join('');
        html += '</div>';
    }

    container.innerHTML = html;
}

$('btnSeatGenerate').addEventListener('click', generateSeating);
function onSeatConfigChange() {
    state.seatingConfig = readSeatConfig();
    updateSeatCapacity();
    saveStateDebounced();
}
$('seatRows').addEventListener('input', onSeatConfigChange);
$('seatCols').addEventListener('input', onSeatConfigChange);
$('seatMode').addEventListener('change', onSeatConfigChange);

$('btnSeatExport').addEventListener('click', () => {
    if (!state.seating) return;
    const { rows, cols, seats, overflow } = state.seating;

    const data = [];
    data.push([`座位表（${rows} 排 × ${cols} 列）`]);
    data.push(['讲台']);
    data.push(['', ...Array.from({ length: cols }, (_, i) => `第${i + 1}列`)]);

    for (let r = 0; r < rows; r++) {
        const row = [`第${r + 1}排`];
        for (let c = 0; c < cols; c++) {
            const stu = seats[r][c];
            row.push(stu ? (stu.gender ? `${stu.name}(${stu.gender})` : stu.name) : '');
        }
        data.push(row);
    }

    if (overflow.length > 0) {
        data.push([]);
        data.push(['未安排', ...overflow.map(s => s.name)]);
    }

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 10 }, ...Array.from({ length: cols }, () => ({ wch: 14 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '座位表');
    XLSX.writeFile(wb, `座位表_${rows}排${cols}列.xlsx`);
    showToast('Excel导出成功', 'success');
});

$('btnSeatPrint').addEventListener('click', () => window.print());

// ===== 随机点名（转盘） =====

/**
 * 颜色盘：交替使用男女配色让扇区有节奏感
 */
const ROLL_PALETTE = [
    '#4f46e5', '#ec4899',
    '#0ea5e9', '#f43f5e',
    '#8b5cf6', '#f97316',
    '#10b981', '#facc15',
    '#06b6d4', '#a855f7',
    '#22c55e', '#fb7185',
    '#3b82f6', '#d946ef',
    '#14b8a6', '#eab308',
];

/**
 * 计算当前候选池（排除轮空 + 可选地排除已点过的人）
 */
function getRollCandidates() {
    const excludeCalled = $('rollExcludeCalled') ? $('rollExcludeCalled').checked : true;
    const called = new Set(state.rollcall.history);
    return state.students.filter(s => !s.resting && (!excludeCalled || !called.has(s.name)));
}

/**
 * 渲染转盘页面：统计、候选池、Canvas
 */
function renderRollcallPage() {
    const total = state.students.length;
    const resting = state.students.filter(s => s.resting).length;
    const active = state.students.filter(s => !s.resting).length;
    const called = state.rollcall.history.length;
    const excludeCalled = $('rollExcludeCalled') ? $('rollExcludeCalled').checked : true;
    const candidates = getRollCandidates();

    if ($('rollTotalCount')) $('rollTotalCount').textContent = candidates.length;
    if ($('rollCalledCount')) $('rollCalledCount').textContent = called;
    if ($('rollRestingCount')) $('rollRestingCount').textContent = resting;

    renderRollHistory();
    drawWheel(candidates);

    // 顶部候选数提示：只在还没抽过 / 没有历史结果时刷新文案
    if ($('rollResultName') && !state.rollcall.spinning && state.rollcall.history.length === 0) {
        if (total === 0) {
            $('rollResultName').textContent = '请先导入学生数据';
        } else if (active === 0) {
            $('rollResultName').textContent = '所有学生都已轮空';
        } else if (candidates.length === 0) {
            $('rollResultName').textContent = excludeCalled
                ? '候选池已抽完，点击「重置记录」再来一轮'
                : '无可用学生';
        } else {
            $('rollResultName').textContent = `候选 ${candidates.length} 人，点击「启动转盘」`;
        }
        if ($('rollResultMeta')) $('rollResultMeta').textContent = '';
    }
    // 抽完之后：用最近一次结果填回姓名区，避免被 renderRollcallPage 清掉
    if ($('rollResultName') && !state.rollcall.spinning && state.rollcall.history.length > 0) {
        const last = state.rollcall.lastResult;
        if (last) {
            $('rollResultName').textContent = last.name;
            if ($('rollResultMeta')) {
                const tag = last.gender ? last.gender : '未知';
                $('rollResultMeta').textContent = `第 ${state.rollcall.history.length} 位 · ${tag}`;
            }
        }
    }
    renderRollAwardButton();
}

/**
 * 绘制转盘扇区
 */
function drawWheel(candidates) {
    const canvas = $('wheelCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const radius = Math.min(cx, cy) - 6;

    ctx.clearRect(0, 0, W, H);

    if (!candidates || candidates.length === 0) {
        // 空状态：画一圈提示
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#f3f4f6';
        ctx.fill();
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#9ca3af';
        ctx.font = '600 18px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('暂无候选', cx, cy);
        return;
    }

    const n = candidates.length;
    const arc = (Math.PI * 2) / n;

    candidates.forEach((stu, i) => {
        const start = i * arc - Math.PI / 2;
        const end = start + arc;

        // 扇区填充
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, start, end);
        ctx.closePath();
        ctx.fillStyle = ROLL_PALETTE[i % ROLL_PALETTE.length];
        ctx.fill();

        // 扇区分隔线
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // 姓名文字：转盘坐标系里沿径向排列
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(start + arc / 2);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.font = '600 14px "Microsoft YaHei", sans-serif';
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 3;
        // 名字过长截断，避免溢出
        const name = (stu.name || '').toString();
        const maxLen = n > 16 ? 3 : n > 10 ? 4 : 6;
        const showName = name.length > maxLen ? name.slice(0, maxLen - 1) + '…' : name;
        ctx.fillText(showName, radius - 14, 0);
        ctx.restore();
    });

    // 外圈
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.stroke();
}

/**
 * 启动旋转
 */
function spinWheel() {
    if (state.rollcall.spinning) return;

    const candidates = getRollCandidates();
    if (candidates.length === 0) {
        const autoReset = $('rollAutoReset') ? $('rollAutoReset').checked : true;
        if (autoReset && state.rollcall.history.length > 0) {
            state.rollcall.history = [];
            renderRollcallPage();
            showToast('全部点完，已自动重置记录', 'info');
            saveState();
        } else {
            showToast('当前没有可抽取的学生', 'warning');
        }
        return;
    }

    // 随机选出一个候选人，再算到指针的角度
    const winnerIdx = Math.floor(Math.random() * candidates.length);
    const winner = candidates[winnerIdx];

    const n = candidates.length;
    const arc = (Math.PI * 2) / n;
    // 扇区中心角（Canvas 0 弧度是 3 点钟方向，转盘绘制从 -90°/12 点开始，所以扇区中心为 -PI/2 + arc*(i+0.5)）
    const sectorCenter = -Math.PI / 2 + arc * (winnerIdx + 0.5);
    // 目标：让扇区中心最终指向正上方（-PI/2）。当前累计旋转 = state.rollcall.angle。
    // 总旋转 = 当前角度 + 多圈 + (sectorCenter - (-PI/2))，因为总旋转是顺时针累加，sectorCenter 是逆时针绘制时的角度。
    const current = state.rollcall.angle;
    const baseTurns = 6 + Math.floor(Math.random() * 3); // 6~8 圈
    // 让扇区中心最终落到正上方（12 点钟，Canvas 角度 -PI/2）。
    // CSS rotate 是顺时针为正；扇区 i 原本在 sectorCenter = -PI/2 + arc*(i+0.5)。
    // 解方程 sectorCenter + angle ≡ -PI/2 (mod 2π) → angle ≡ -arc*(i+0.5)
    const target = baseTurns * Math.PI * 2 - arc * (winnerIdx + 0.5);
    const finalAngle = current + target;

    state.rollcall.spinning = true;
    if ($('btnRollSpin')) $('btnRollSpin').disabled = true;
    if ($('rollResultName')) $('rollResultName').textContent = '🎲 转动中...';
    if ($('rollResultMeta')) $('rollResultMeta').textContent = '';

    const canvas = $('wheelCanvas');
    if (!canvas) return;
    const startAngle = current;
    const endAngle = finalAngle;
    const duration = 4200; // ms
    const startTime = performance.now();

    function tick(now) {
        const t = Math.min(1, (now - startTime) / duration);
        // 缓动函数：先快后慢（easeOutCubic）
        const eased = 1 - Math.pow(1 - t, 3);
        const angle = startAngle + (endAngle - startAngle) * eased;
        canvas.style.transform = `rotate(${angle}rad)`;
        if (t < 1) {
            requestAnimationFrame(tick);
        } else {
            state.rollcall.angle = endAngle % (Math.PI * 2);
            canvas.style.transform = `rotate(${endAngle}rad)`;
            finishSpin(winner);
        }
    }
    requestAnimationFrame(tick);
}

/**
 * 旋转结束：更新历史、刷新页面
 */
function finishSpin(winner) {
    state.rollcall.spinning = false;
    if ($('btnRollSpin')) $('btnRollSpin').disabled = false;

    const autoReset = $('rollAutoReset') ? $('rollAutoReset').checked : true;
    state.rollcall.history.push(winner.name);
    state.rollcall.lastResult = winner;

    if ($('rollResultName')) {
        $('rollResultName').textContent = winner.name;
    }
    if ($('rollResultMeta')) {
        const tag = winner.gender ? `${winner.gender}` : '未知';
        $('rollResultMeta').textContent = `第 ${state.rollcall.history.length} 位 · ${tag}`;
    }
    renderRollAwardButton();

    renderRollcallPage();
    saveState();

    // 全部点完后自动重置
    const remaining = getRollCandidates();
    if (remaining.length === 0 && autoReset && state.rollcall.history.length >= state.students.filter(s => !s.resting).length) {
        showToast('🎉 已被点完一轮，自动重置记录', 'success');
    }
}

/**
 * 点命中的手动加分按钮：显示/隐藏 + 已加过状态
 * 状态以「今天 + 该学生」是否已有 rollcall 加分记录判断（刷新后依然正确）
 */
function renderRollAwardButton() {
    const btn = $('btnRollAward');
    if (!btn) return;
    const last = state.rollcall.lastResult;
    const meta = $('rollResultMeta');
    if (!last || state.rollcall.spinning || !meta || !meta.textContent) {
        btn.classList.add('hidden');
        return;
    }
    btn.classList.remove('hidden');
    const awarded = hasScoreEntry(ymd(new Date()), last.name, 'manual', '点名回答');
    btn.disabled = awarded;
    btn.textContent = awarded ? '✓ 本轮已加分' : '⭐ +1 加分';
}

/**
 * 老师点击「+1 加分」：给命中的学生手动加 1 分
 */
function awardRollPoint() {
    const last = state.rollcall.lastResult;
    if (!last) return;
    const ok = addScoreEntry(ymd(new Date()), last.name, 'manual', 1, '点名回答');
    if (ok) {
        saveState();
        renderRollAwardButton();
        showToast(`已给 ${last.name} 加 1 分（点名回答）`, 'success');
    } else {
        showToast('该生本轮已加过分', 'info');
        renderRollAwardButton();
    }
}

/**
 * 重置点名记录
 */
function resetRollcall() {
    if (state.rollcall.spinning) {
        showToast('转盘旋转中，请稍候', 'warning');
        return;
    }
    if (state.rollcall.history.length === 0) {
        showToast('当前没有记录', 'info');
        return;
    }
    if (!confirm('确认清空所有点名记录？')) return;
    state.rollcall.history = [];
    state.rollcall.lastResult = null;
    renderRollcallPage();
    showToast('点名记录已清空', 'success');
    saveState();
}

/**
 * 渲染右侧历史列表
 */
function renderRollHistory() {
    const list = $('rollHistoryList');
    const count = $('rollHistoryCount');
    if (!list) return;
    if (count) count.textContent = state.rollcall.history.length;

    if (state.rollcall.history.length === 0) {
        list.innerHTML = '<div class="rollcall-history-empty">还没有记录</div>';
        return;
    }
    list.innerHTML = state.rollcall.history.map((name, idx) => {
        return `<div class="rollcall-history-item">
            <span class="rollcall-history-idx">${idx + 1}</span>
            <span class="rollcall-history-name">${name}</span>
        </div>`;
    }).join('');
}

$('btnRollSpin').addEventListener('click', spinWheel);
$('btnRollReset').addEventListener('click', resetRollcall);
if ($('btnRollAward')) $('btnRollAward').addEventListener('click', awardRollPoint);
['rollExcludeCalled', 'rollAutoReset'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', renderRollcallPage);
});

// 考勤按钮绑定
if ($('attendanceViewWeek')) $('attendanceViewWeek').addEventListener('click', () => { state.attendance.view = 'week'; renderAttendancePage(); saveStateDebounced(); });
if ($('attendanceViewMonth')) $('attendanceViewMonth').addEventListener('click', () => { state.attendance.view = 'month'; renderAttendancePage(); saveStateDebounced(); });
if ($('attendanceAnchorDate')) $('attendanceAnchorDate').addEventListener('change', (e) => {
    if (e.target.value) { state.attendance.anchorDate = e.target.value; renderAttendancePage(); saveStateDebounced(); }
});
if ($('btnAttendancePrev')) $('btnAttendancePrev').addEventListener('click', () => {
    state.attendance.anchorDate = shiftAnchor(state.attendance.anchorDate || ymd(new Date()), state.attendance.view, -1);
    renderAttendancePage(); saveStateDebounced();
});
if ($('btnAttendanceToday')) $('btnAttendanceToday').addEventListener('click', () => {
    state.attendance.anchorDate = ymd(new Date()); renderAttendancePage(); saveStateDebounced();
});
if ($('btnAttendanceNext')) $('btnAttendanceNext').addEventListener('click', () => {
    state.attendance.anchorDate = shiftAnchor(state.attendance.anchorDate || ymd(new Date()), state.attendance.view, 1);
    renderAttendancePage(); saveStateDebounced();
});
if ($('btnAttendanceInit')) $('btnAttendanceInit').addEventListener('click', initAttendanceFromStudents);
if ($('btnAttendancePrint')) $('btnAttendancePrint').addEventListener('click', printAttendance);

// 一键出勤
if ($('btnAttendanceAllPresent')) $('btnAttendanceAllPresent').addEventListener('click', openAttendanceAllPresent);
if ($('attendanceAllPresentCancel')) $('attendanceAllPresentCancel').addEventListener('click', closeAttendanceAllPresent);
if ($('attendanceAllPresentOk')) $('attendanceAllPresentOk').addEventListener('click', confirmAttendanceAllPresent);
document.querySelectorAll('[data-quick-range]').forEach(btn => {
    btn.addEventListener('click', () => setAttendanceAllPresentRange(btn.dataset.quickRange));
});

// 导出下拉
const _attExportBtn = $('btnAttendanceExport');
const _attExportMenu = $('attendanceExportMenu');
if (_attExportBtn && _attExportMenu) {
    _attExportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _attExportMenu.classList.toggle('hidden');
        renderAttendanceExportSelectedCount();
    });
    document.addEventListener('click', (e) => {
        if (!_attExportMenu.classList.contains('hidden') && !_attExportMenu.contains(e.target) && e.target !== _attExportBtn) {
            _attExportMenu.classList.add('hidden');
        }
    });
    _attExportMenu.querySelectorAll('.btn-dropdown-item[data-export-mode]').forEach(it => {
        it.addEventListener('click', () => {
            _attExportMenu.classList.add('hidden');
            exportAttendanceExcel(it.dataset.exportMode);
        });
    });
}
function renderAttendanceExportSelectedCount() {
    const el = $('attendanceExportSelectedCount');
    if (!el) return;
    const n = state.attendance.selected ? Object.keys(state.attendance.selected).length : 0;
    el.textContent = `已选 ${n} 人`;
}

// 学生复选框：事件委托（重渲染后依然生效）
const _attTableContainer = $('attendanceTableContainer');
if (_attTableContainer && !_attTableContainer._selectBound) {
    _attTableContainer.addEventListener('change', (e) => {
        const cb = e.target.closest('.att-row-select');
        if (!cb) return;
        const name = cb.dataset.student;
        if (!name) return;
        if (cb.checked) state.attendance.selected[name] = true;
        else delete state.attendance.selected[name];
        saveStateDebounced();
        renderAttendanceExportSelectedCount();
    });
    _attTableContainer._selectBound = true;
}

// cell 5 状态菜单
const _attCellMenu = $('attendanceCellMenu');
if (_attCellMenu && !_attCellMenu._menuBound) {
    // 在菜单内 click 全部拦下，不冒泡到 document 触发「点外部关闭 note 弹窗」
    _attCellMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.att-cell-menu-item');
        if (!item) return;
        e.stopPropagation();
        e.preventDefault();
        applyAttendanceCellMenu(item.dataset.status);
    });
    // mousedown 也拦一份，防止 document 上有 mousedown 监听抢逻辑
    _attCellMenu.addEventListener('mousedown', (e) => e.stopPropagation());
    _attCellMenu._menuBound = true;
}
document.addEventListener('click', (e) => {
    if (!_attCellMenu || _attCellMenu.classList.contains('hidden')) return;
    if (_attCellMenu.contains(e.target)) return;
    if (e.target.classList && e.target.classList.contains('att-cell-menu-btn')) return;
    closeAttendanceCellMenu();
});

if ($('attendanceNoteOk')) $('attendanceNoteOk').addEventListener('click', confirmAttendanceNote);
if ($('attendanceNoteCancel')) $('attendanceNoteCancel').addEventListener('click', cancelAttendanceNote);
if ($('attendanceNoteInput')) $('attendanceNoteInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmAttendanceNote();
    else if (e.key === 'Escape') cancelAttendanceNote();
});
document.addEventListener('click', (e) => {
    const dlg = $('attendanceNoteDialog');
    if (!dlg || dlg.classList.contains('hidden')) return;
    if (dlg.contains(e.target)) return;
    // 点 cell 本身、cell 菜单按钮、cell 菜单项时不关闭（避免打开即关）
    if (e.target.closest('.att-cell, .att-cell-menu-btn, .att-cell-menu-item, #attendanceCellMenu')) return;
    closeAttendanceNoteDialog();
});

// 积分按钮绑定
if ($('scoreViewRanking')) $('scoreViewRanking').addEventListener('click', () => { state.score.view = 'ranking'; renderScorePage(); saveStateDebounced(); });
if ($('scoreViewDetail')) $('scoreViewDetail').addEventListener('click', () => { state.score.view = 'detail'; renderScorePage(); saveStateDebounced(); });
if ($('btnScoreReconcile')) $('btnScoreReconcile').addEventListener('click', () => {
    const added = reconcileScoreLog();
    renderScorePage();
    saveStateDebounced();
    showToast(added > 0 ? `已补齐 ${added} 条联动积分` : '已是最新', added > 0 ? 'success' : 'info');
});
if ($('btnScoreExport')) $('btnScoreExport').addEventListener('click', exportScoreExcel);
if ($('btnScorePrint')) $('btnScorePrint').addEventListener('click', printScore);
if ($('btnScoreRules')) $('btnScoreRules').addEventListener('click', openScoreRulesDialog);
if ($('scoreRulesSave')) $('scoreRulesSave').addEventListener('click', saveScoreRules);
if ($('scoreRulesCancel')) $('scoreRulesCancel').addEventListener('click', closeScoreRulesDialog);
if ($('scoreRulesReset')) $('scoreRulesReset').addEventListener('click', resetScoreRulesDialog);
if ($('scoreAdjustOk')) $('scoreAdjustOk').addEventListener('click', confirmScoreAdjust);
if ($('scoreAdjustCancel')) $('scoreAdjustCancel').addEventListener('click', closeScoreAdjustDialog);
// 积分明细弹窗关闭
if ($('scoreDetailClose')) $('scoreDetailClose').addEventListener('click', closeScoreDetailDialog);
document.addEventListener('click', (e) => {
    const dlg = $('scoreDetailDialog');
    if (!dlg || dlg.classList.contains('hidden')) return;
    if (dlg.contains(e.target)) return;
    // 行点击、+/- 按钮不算外部
    if (e.target.closest('tr.score-row, .btn-mini')) return;
    closeScoreDetailDialog();
});
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.score-preset-btn');
    if (btn) {
        const reason = $('scoreAdjustReason');
        if (reason) reason.value = btn.dataset.text;
    }
});
document.addEventListener('click', (e) => {
    const dlg = $('scoreAdjustDialog');
    if (dlg && !dlg.classList.contains('hidden') && !dlg.contains(e.target) && !e.target.closest('.btn-mini')) closeScoreAdjustDialog();
    const rdlg = $('scoreRulesDialog');
    if (rdlg && !rdlg.classList.contains('hidden') && !rdlg.contains(e.target) && e.target !== $('btnScoreRules') && !e.target.closest('#btnScoreRules')) closeScoreRulesDialog();
});

// ===== 初始化 =====
(function init() {
    const cached = loadState();

    if (cached) {
        // 恢复业务数据；spinning 这种瞬时态保持默认 false
        if (Array.isArray(cached.students)) state.students = cached.students;
        if (cached.schedule && typeof cached.schedule === 'object') state.schedule = cached.schedule;
        if (cached.seating && typeof cached.seating === 'object') state.seating = cached.seating;
        if (typeof cached.startDate === 'string') state.startDate = cached.startDate;
        if (typeof cached.weekCycle === 'number') state.weekCycle = cached.weekCycle;
        if (cached.rollcall && typeof cached.rollcall === 'object') {
            state.rollcall.history = Array.isArray(cached.rollcall.history) ? cached.rollcall.history : [];
            state.rollcall.angle = typeof cached.rollcall.angle === 'number' ? cached.rollcall.angle : 0;
            state.rollcall.lastResult = cached.rollcall.lastResult || null;
        }
        if (cached.dutyCounts && typeof cached.dutyCounts === 'object') {
            Object.assign(state.dutyCounts, cached.dutyCounts);
        }
        if (cached.seatingConfig && typeof cached.seatingConfig === 'object') {
            Object.assign(state.seatingConfig, cached.seatingConfig);
        }
        if (cached.attendance && typeof cached.attendance === 'object') {
            state.attendance.view = cached.attendance.view === 'month' ? 'month' : 'week';
            state.attendance.anchorDate = typeof cached.attendance.anchorDate === 'string' ? cached.attendance.anchorDate : null;
            state.attendance.records = (cached.attendance.records && typeof cached.attendance.records === 'object') ? cached.attendance.records : {};
            state.attendance.initializedAt = cached.attendance.initializedAt || null;
        }
        if (cached.score && typeof cached.score === 'object') {
            state.score.view = cached.score.view === 'detail' ? 'detail' : 'ranking';
            state.score.log = Array.isArray(cached.score.log) ? cached.score.log : [];
            if (cached.score.rules && typeof cached.score.rules === 'object') {
                state.score.rules = {
                    attendance: {
                        present: Number(cached.score.rules.attendance && cached.score.rules.attendance.present) || 0,
                        late:    Number(cached.score.rules.attendance && cached.score.rules.attendance.late)    || 0,
                        makeup:  Number(cached.score.rules.attendance && cached.score.rules.attendance.makeup)  || 0,
                        leave:   Number(cached.score.rules.attendance && cached.score.rules.attendance.leave)   || 0,
                    },
                    duty:     Number(cached.score.rules.duty)     || 0,
                    rollcall: Number(cached.score.rules.rollcall) || 0,
                };
            }
        }
    }

    // 把恢复出来的配置写回控件
    document.querySelectorAll('#dutyCheckboxes .duty-count').forEach(input => {
        const duty = input.dataset.duty;
        if (state.dutyCounts[duty] !== undefined) input.value = state.dutyCounts[duty];
    });
    if (state.seatingConfig.rows !== undefined) $('seatRows').value = state.seatingConfig.rows;
    if (state.seatingConfig.cols !== undefined) $('seatCols').value = state.seatingConfig.cols;
    if (state.seatingConfig.mode !== undefined) $('seatMode').value = state.seatingConfig.mode;
    if (state.startDate) $('startDate').value = state.startDate;
    if (state.weekCycle !== undefined) $('weekCycle').value = String(state.weekCycle);

    // 把已经存在的值班表 / 座位表 / 学生数据反映到 UI
    updateStudentStats();
    updateSeatCapacity();
    updateDutySlotInfo();
    $('btnGenerate').disabled = state.students.length === 0;
    if (state.schedule) {
        $('btnExport').disabled = false;
        $('btnPrint').disabled = false;
        $('navWeekCount').textContent = state.schedule.weekCount;
    }
    if (state.seating) {
        $('btnSeatExport').disabled = false;
        $('btnSeatPrint').disabled = false;
    }

    // 默认起始日期：仅在没有缓存时使用下周
    if (!state.startDate) {
        const now = new Date();
        const day = now.getDay() || 7;
        const monday = new Date(now);
        monday.setDate(now.getDate() - day + 1 + 7);
        $('startDate').value = monday.toISOString().slice(0, 10);
    }

    if (state.students.length > 0) {
        const savedAt = cached && cached.savedAt ? new Date(cached.savedAt) : null;
        const timeStr = savedAt ? `${savedAt.getMonth() + 1}/${savedAt.getDate()} ${String(savedAt.getHours()).padStart(2, '0')}:${String(savedAt.getMinutes()).padStart(2, '0')}` : '';
        setStatus(timeStr ? `已恢复 ${state.students.length} 名学生（${timeStr} 保存）` : `已恢复 ${state.students.length} 名学生`);
    } else {
        setStatus('就绪 - 请导入Excel文件');
    }

    // ===== 全站登录拦截 =====
    // 首次渲染先到占位页（业务页隐藏）；登录遮罩会根据 isAccessGranted() 决定开关
    switchPage('placeholder');
    // 锁住主内容，避免遮罩期间业务页内容闪烁
    const mainEl = document.querySelector('.main');
    if (mainEl) mainEl.style.visibility = 'hidden';

    // 初始化 Supabase 客户端（异步恢复 session；恢复成功会自动关闭遮罩）
    initSupabase();
    // 同步顶部条
    refreshCloudStatus();
    // 立即判定遮罩开关（处理仅本地模式）
    gateOpenIfNeeded();
    // 仅在已通过 gate 时才显示默认业务页
    if (isAccessGranted()) {
        if (mainEl) mainEl.style.visibility = '';
        switchPage('duty');
    }

    // 窄屏默认收起侧栏（不要在窄屏展开时挤压主内容）
    if (isMobile() && navMenuEl) navMenuEl.classList.add('collapsed');

    // 如果之前已经生成了值班表，重新渲染
    if (state.schedule) renderDutyTable();
    // 如果之前已经生成了座位表，重新渲染
    if (state.seating) renderSeating();
    // 考勤页面：先把锚点对齐到今天/本月，渲染一次备用
    if (typeof renderAttendancePage === 'function') renderAttendancePage();
    // 积分页面：触发一次 reconcile（不会重复加分，仅补缺失）
    if (typeof renderScorePage === 'function') renderScorePage();

    // 顶部"→ 系统设置"链接
    const goSettings = $('cloudStatusGoSettings');
    if (goSettings) {
        goSettings.addEventListener('click', (e) => {
            e.preventDefault();
            switchPage('settings');
        });
    }

    // 配置对话框
    $('supabaseConfigCancel')?.addEventListener('click', closeConfigDialog);
    $('supabaseConfigOk')?.addEventListener('click', submitConfigDialog);

    // 登录对话框
    $('supabaseLoginCancel')?.addEventListener('click', closeLoginDialog);
    $('supabaseLoginOk')?.addEventListener('click', submitLoginDialog);

    // 系统设置页：云端配置
    bindSettingsPage();

    // ===== 全站登录拦截遮罩：事件绑定 =====
    $('loginGateOk')?.addEventListener('click', submitLoginGate);
    $('loginGateLocalOnlyOk')?.addEventListener('click', submitLoginGateLocalOnly);
    $('loginGateLocalOnly')?.addEventListener('change', refreshLoginGateLocalBtn);
    // 邮箱/密码框回车提交
    $('loginGatePassword')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitLoginGate();
    });
    $('loginGateEmail')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('loginGatePassword')?.focus();
    });

    // ===== 侧边栏登录按钮 =====
    $('navLoginBtn')?.addEventListener('click', openLoginFromNav);
})();
