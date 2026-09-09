/**
 * 班级工作台 - 智能排班系统 v20260909-2320
 * 主要功能：
 * 1. Excel导入解析（识别姓名、性别）
 * 2. 智能排班算法（轮空+下周优先）
 * 3. 多页面菜单（值班表含排班配置 / 座位表 / 学生管理 / 随机点名）
 * 4. 座位表随机排座（完全随机 / 男女穿插 / 男女分区）
 * 5. 随机点名转盘
 * 6. localStorage 持久化（学生/值班表/座位表/点名历史/排班配置）
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

// ===== 本地缓存（localStorage） =====
const STORAGE_KEY = 'class-workbench.v1';

function saveState() {
    try {
        // 只保存业务数据，不保存 spinning 这种瞬时状态
        const snapshot = {
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
            savedAt: Date.now(),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (err) {
        // localStorage 不可用（隐私模式 / 配额满）时静默失败，不影响功能
        console.warn('[cache] 保存失败：', err);
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

function clearStoredState() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
}

function setStatus(text) {
    $('statusText').textContent = text;
}

// ===== 菜单路由 =====
const pageTitles = {
    duty: { title: '🗓️ 值班表', sub: '配置规则并生成值班表' },
    seating: { title: '🪑 座位表', sub: '按排列数随机排座' },
    students: { title: '👥 学生管理', sub: '查看与管理班级学生' },
    rollcall: { title: '🎯 随机点名', sub: '从非轮空学生中随机抽取' },
    attendance: { title: '✅ 考勤记录', sub: '每日打卡 · 周/月统计' },
    score: { title: '📊 积分统计', sub: '即将上线' },
    notice: { title: '📢 班级通知', sub: '即将上线' },
    settings: { title: '🔧 系统设置', sub: '即将上线' },
};

function switchPage(pageName) {
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

// 折叠菜单
$('navToggle').addEventListener('click', () => {
    $('navMenu').classList.toggle('collapsed');
});

// ===== Excel 导入与解析 =====
// 学生管理页面的"导入学生"按钮触发
document.addEventListener('click', (e) => {
    if (e.target && (e.target.id === 'btnImportStudents' || e.target.closest('#btnImportStudents'))) {
        $('fileInput').click();
    }
});

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
    if (confirm(`确认清空全部 ${state.students.length} 名学生？\n\n将同时清空：\n· 值班表\n· 座位表\n· 随机点名记录\n· 考勤记录\n· 本地所有缓存\n\n此操作不可撤销。`)) {
        // 1) 重置所有运行时结果数据（配置项保留：起始日期/周期/策略/职务数/座位行列/点名选项）
        state.students = [];
        state.schedule = null;
        state.seating = null;
        state.rollcall.history = [];
        state.rollcall.lastResult = null;
        state.attendance = { view: 'week', anchorDate: null, records: {}, initializedAt: null };

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
            cells.push(`<td class="att-cell ${statusCls}" data-date="${d}" data-student="${escapeAttr(s.name)}" data-idx="${idx}"${noteAttr}><span class="att-cell-label">${label}</span>${noteMark}</td>`);
        });
        const rate = cntTracked === 0 ? '-' : Math.round((cntP / cntTracked) * 100) + '%';
        tbody.push(`<tr${s.resting ? ' class="att-row-resting"' : ''}><td class="att-td-student"><span class="att-student-name">${escapeHtml(s.name)}</span><span class="att-student-gender ${s.gender === '男' ? 'male' : 'female'}">${s.gender || ''}</span></td>${cells.join('')}<td class="att-td-stat att-stat-present">${cntP}</td><td class="att-td-stat att-stat-late">${cntL}</td><td class="att-td-stat att-stat-leave">${cntLv}</td><td class="att-td-stat att-stat-makeup">${cntM}</td><td class="att-td-stat att-stat-rate">${rate}</td></tr>`);
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

function openAttendanceNoteDialog(date, studentName, status, prefilledNote) {
    const dlg = $('attendanceNoteDialog');
    if (!dlg) return;
    dlg.dataset.date = date;
    dlg.dataset.student = studentName;
    dlg.dataset.status = status;
    $('attendanceNoteLabel').textContent = `${date} · ${studentName} · ${ATTENDANCE_LABELS[status]}`;
    $('attendanceNoteInput').value = prefilledNote || '';
    $('attendanceNoteInput').placeholder = status === 'leave' ? '请填写请假事由（病假/事假等）' : '请填写补到说明';
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
    if (!note) {
        showToast(status === 'leave' ? '请假需填写事由' : '补到需填写说明', 'warning');
        return;
    }
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
        if (!confirm('已有考勤记录，确认要再次初始化吗？\n（已有记录不会被清空，仅补齐缺失学生）')) return;
    } else {
        if (!confirm('将从学生名单初始化考勤表，确认？')) return;
    }
    if (!state.attendance.initializedAt) state.attendance.initializedAt = new Date().toISOString();
    // 仅初始化锚点为空；记录保持按天按需创建
    showToast('考勤表已就绪', 'success');
    renderAttendancePage();
    saveStateDebounced();
}

function exportAttendanceExcel() {
    if (state.students.length === 0) {
        showToast('暂无考勤数据可导出', 'warning');
        return;
    }
    const dates = state.attendance.view === 'month'
        ? getMonthDates(state.attendance.anchorDate)
        : getWeekDates(state.attendance.anchorDate);
    const data = [];
    data.push([`考勤记录（${dates[0]} ~ ${dates[dates.length - 1]}）`]);
    const head = ['学生'];
    dates.forEach(d => {
        const dt = parseYmd(d);
        head.push(`${d} ${DAY_NAMES[dt.getDay()]}`);
    });
    data.push(head);
    state.students.forEach(s => {
        const row = [`${s.name}${s.gender ? '(' + s.gender + ')' : ''}`];
        dates.forEach(d => {
            const cell = getAttendanceCell(d, s.name);
            if (!cell.status) { row.push(''); return; }
            row.push(cell.note ? `${ATTENDANCE_LABELS[cell.status]}(${cell.note})` : ATTENDANCE_LABELS[cell.status]);
        });
        data.push(row);
    });
    // 每日出勤汇总
    data.push([]);
    data.push(['每日出勤 X/Y']);
    dates.forEach(d => {
        let p = 0, total = 0;
        activeStudents().forEach(s => {
            const c = getAttendanceCell(d, s.name);
            if (c.status) { total++; if (c.status === 'present') p++; }
        });
        data.push([d, `${p} / ${total}`]);
    });

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 16 }, ...dates.map(() => ({ wch: 14 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '考勤');
    const fname = `考勤_${dates[0]}_${dates[dates.length - 1]}${state.attendance.view === 'month' ? '_月' : '_周'}.xlsx`;
    XLSX.writeFile(wb, fname);
    showToast('Excel 导出成功', 'success');
}

function printAttendance() { window.print(); }

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

document.querySelectorAll('#dutyCheckboxes .duty-count').forEach(input => {
    input.addEventListener('input', () => {
        state.dutyCounts[input.dataset.duty] = parseInt(input.value) || 0;
        updateDutySlotInfo();
        saveStateDebounced();
    });
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

    renderRollcallPage();
    saveState();

    // 全部点完后自动重置
    const remaining = getRollCandidates();
    if (remaining.length === 0 && autoReset && state.rollcall.history.length >= state.students.filter(s => !s.resting).length) {
        showToast('🎉 已被点完一轮，自动重置记录', 'success');
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
        const stu = state.students.find(s => s.name === name);
        const genderCls = stu && stu.gender === '男' ? 'male'
            : stu && stu.gender === '女' ? 'female' : '';
        const tag = stu && stu.gender ? stu.gender : '';
        return `<div class="rollcall-history-item">
            <span class="rollcall-history-idx">${idx + 1}</span>
            <span class="rollcall-history-name">${name}</span>
            ${tag ? `<span class="student-gender ${genderCls}">${tag}</span>` : ''}
        </div>`;
    }).join('');
}

$('btnRollSpin').addEventListener('click', spinWheel);
$('btnRollReset').addEventListener('click', resetRollcall);
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
if ($('btnAttendanceExport')) $('btnAttendanceExport').addEventListener('click', exportAttendanceExcel);
if ($('btnAttendancePrint')) $('btnAttendancePrint').addEventListener('click', printAttendance);
if ($('attendanceNoteOk')) $('attendanceNoteOk').addEventListener('click', confirmAttendanceNote);
if ($('attendanceNoteCancel')) $('attendanceNoteCancel').addEventListener('click', cancelAttendanceNote);
if ($('attendanceNoteInput')) $('attendanceNoteInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmAttendanceNote();
    else if (e.key === 'Escape') cancelAttendanceNote();
});
document.addEventListener('click', (e) => {
    const dlg = $('attendanceNoteDialog');
    if (dlg && !dlg.classList.contains('hidden') && !dlg.contains(e.target) && !e.target.closest('.att-cell')) closeAttendanceNoteDialog();
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

    // 显式初始化到值班表页面，确保顶部按钮可见
    switchPage('duty');
    // 如果之前已经生成了值班表，重新渲染
    if (state.schedule) renderDutyTable();
    // 如果之前已经生成了座位表，重新渲染
    if (state.seating) renderSeating();
    // 考勤页面：先把锚点对齐到今天/本月，渲染一次备用
    if (typeof renderAttendancePage === 'function') renderAttendancePage();
})();
