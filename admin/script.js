const API_BASE = "/api";

// 全局缓存
let cachedAccounts = [];
let cachedRules = [];
let cachedTasks = [];
let cachedGroups = []; 

// [新增] 分页相关状态
// const PAGE_SIZE = 10; // 已移除固定常量
let pageState = {
    acc: { page: 1, size: 30, data: [], filtered: [] },
    rule: { page: 1, size: 30, data: [], filtered: [] },
    task: { page: 1, size: 20, data: [], filtered: [] }
};

function changePageSize(type, size) {
    pageState[type].size = parseInt(size);
    pageState[type].page = 1;
    if (type === 'acc') renderAccountsTable();
    if (type === 'rule') renderRulesTable();
    if (type === 'task') renderTasksTable();
}

function clearSearch(inputId, filterFunc) {
    $(`#${inputId}`).val('');
    filterFunc('');
}

function changePage(type, delta) {
    const s = pageState[type];
    const maxPage = Math.ceil(s.filtered.length / s.size) || 1;
    let newPage = s.page + delta;
    if (newPage < 1) newPage = 1;
    if (newPage > maxPage) newPage = maxPage;
    
    s.page = newPage;
    if (type === 'acc') renderAccountsTable();
    if (type === 'rule') renderRulesTable();
    if (type === 'task') renderTasksTable();
}

// ================== 认证模块 ==================

function doLogin() {
    try {
        const u = $("#admin-user").val();
        const p = $("#admin-pass").val();
        if(!u || !p) return showToast("请输入账号密码");
        
        // 简单防呆
        if (/[^\x00-\xff]/.test(u) || /[^\x00-\xff]/.test(p)) {
            return alert("错误：用户名或密码暂不支持中文，请在后台设置为纯英文/数字。");
        }
        
        const token = "Basic " + btoa(u + ":" + p);
        
        const btn = $(event.target);
        const orgText = btn.text();
        btn.text("登录中...").prop("disabled", true);

        fetch(`${API_BASE}/login`, { method: 'POST', headers: { "Authorization": token } })
        .then(r => {
            btn.text(orgText).prop("disabled", false);
            if(r.ok) {
                localStorage.setItem("auth_token", token);
                $("#login-overlay").fadeOut();
                initApp();
            } else {
                if(r.status === 401) showToast("账号或密码错误");
                else showToast("服务器错误: " + r.status);
            }
        })
        .catch(err => {
            btn.text(orgText).prop("disabled", false);
            alert("连接失败: " + err.message);
        });

    } catch(e) {
        alert("代码错误: " + e.message);
        console.error(e);
    }
}

function doLogout() {
    localStorage.removeItem("auth_token");
    location.reload();
}

function getHeaders() {
    return { 
        "Authorization": localStorage.getItem("auth_token"),
        "Content-Type": "application/json"
    };
}

// ================== 初始化 & 导航 ==================

function initApp() {
    loadAccounts();
    loadGroups(); 
}

function showSection(id) {
    $(".content-section").removeClass("active");
    $(`#${id}`).addClass("active");
    $(".list-group-item").removeClass("active");
    $(event.currentTarget).addClass("active");
    
    if(id === 'section-accounts') loadAccounts();
    if(id === 'section-rules') loadRules();
    if(id === 'section-groups') loadGroups();
    if(id === 'section-send') loadTasks();
    if(id === 'section-receive') loadInboxList();
}

// ================== 1. 账号管理 ==================

function loadAccounts() {
    fetch(`${API_BASE}/accounts?limit=100`, { headers: getHeaders() })
    .then(r => r.json())
    .then(res => {
        // [修改] 初始化分页数据
        cachedAccounts = res.data || [];
        pageState.acc.data = cachedAccounts;
        pageState.acc.filtered = cachedAccounts;
        pageState.acc.page = 1;
        renderAccountsTable();
        
        // 更新下拉列表
        const dataList = $("#account-list-options");
        dataList.empty();
        cachedAccounts.forEach(acc => {
            dataList.append(`<option value="${escapeHtml(acc.name)}">${acc.email||''}</option>`);
        });
    });
}

function renderAccountsTable() {
    const { filtered, page, size } = pageState.acc;
    const start = (page - 1) * size;
    const end = start + size;
    const list = filtered.slice(start, end);
    const tbody = $("#account-list-body");
    tbody.empty();

    if(list.length === 0) {
        tbody.html('<tr><td colspan="6" class="text-center p-4 text-muted">暂无账号或无匹配项</td></tr>');
    } else {
        list.forEach(acc => {
            let configStr = '-';
            if (acc.client_id) {
                const secretMask = acc.client_secret ? '******' : '';
                const tokenMask = acc.refresh_token ? acc.refresh_token.substring(0, 8) + '...' : '';
                configStr = `${acc.client_id}, ${secretMask}, ${tokenMask}`;
            }
            const isChecked = (acc.status === undefined || acc.status == 1) ? 'checked' : '';
            const statusBadge = `<div class="form-check form-switch"><input class="form-check-input" type="checkbox" ${isChecked} onchange="updateAccountStatus(${acc.id}, this.checked)"></div>`;
            tbody.append(`
                <tr>
                    <td><input type="checkbox" class="acc-check" value="${acc.id}"></td>
                    <td class="fw-bold text-primary cursor-pointer" onclick="openEditAccount(${acc.id})">${escapeHtml(acc.name)}</td>
                    <td style="cursor:pointer; max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" onclick="copyAccountInfo(${acc.id}, 'email')" title="点击复制: ${escapeHtml(acc.email||'-')}">${escapeHtml(acc.email||'-')}</td>
                    <td class="api-config-cell" style="cursor:pointer" onclick="copyAccountInfo(${acc.id}, 'creds')" title="点击复制凭据">${configStr}</td>
                    <td>${statusBadge}</td>
                    <td>
                        <button class="btn btn-sm btn-light text-primary" onclick="openEditAccount(${acc.id})"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm btn-light text-danger" onclick="delAccount(${acc.id})"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `);
        });
    }
    $("#acc-page-info").text(`共 ${filtered.length} 条 (第 ${page}/${Math.ceil(filtered.length/size)||1} 页)`);
}

// [修改] 过滤账号 (支持分页)
function filterAccounts(val) {
    const k = val.toLowerCase();
    pageState.acc.filtered = pageState.acc.data.filter(item => {
        const text = (item.name + " " + (item.email||"")).toLowerCase();
        return text.includes(k);
    });
    pageState.acc.page = 1;
    renderAccountsTable();
}

function openAddModal() {
    $("#acc-id").val("");
    $("#acc-name").val("");
    $("#acc-email").val("");
    $("#acc-api-config").val("");
    new bootstrap.Modal(document.getElementById('addAccountModal')).show();
}

function openEditAccount(id) {
    const acc = cachedAccounts.find(a => a.id == id);
    if(!acc) return;
    
    $("#acc-id").val(acc.id);
    $("#acc-name").val(acc.name);
    $("#acc-email").val(acc.email);
    
    const config = [acc.client_id, acc.client_secret, acc.refresh_token].filter(x=>x).join(', ');
    $("#acc-api-config").val(config);
    
    new bootstrap.Modal(document.getElementById('addAccountModal')).show();
}

function saveAccount() {
    const rawConfig = $("#acc-api-config").val().trim();
    const parts = rawConfig.split(/[,，|]/).map(s => s.trim());
    
    const data = {
        id: $("#acc-id").val() || undefined,
        name: $("#acc-name").val(),
        email: $("#acc-email").val(),
        client_id: parts[0] || "",
        client_secret: parts[1] || "",
        refresh_token: parts[2] || ""
    };

    if(!data.name) return showToast("名称不能为空");

    fetch(`${API_BASE}/accounts`, { 
        method: data.id ? 'PUT' : 'POST', 
        headers: getHeaders(), 
        body: JSON.stringify(data) 
    }).then(r => r.json()).then(res => {
        if(res.ok) {
            bootstrap.Modal.getInstance(document.getElementById('addAccountModal')).hide();
            showToast("保存成功");
            loadAccounts();
        } else {
            // [修改] 显示具体错误
            alert("保存失败: " + res.error);
        }
    });
}

function delAccount(id) {
    if(!confirm("确定删除此账号？")) return;
    fetch(`${API_BASE}/accounts?id=${id}`, { method: 'DELETE', headers: getHeaders() })
    .then(() => { showToast("已删除"); loadAccounts(); });
}
function updateAccountStatus(id, checked) {
    const status = checked ? 1 : 0;
    fetch(`${API_BASE}/accounts`, { 
        method: 'PUT', headers: getHeaders(), body: JSON.stringify({ id, status }) 
    }).then(r => r.json()).then(res => {
        if(res.ok) showToast(checked ? "已启用" : "已禁用");
        else { showToast("修改失败"); loadAccounts(); }
    });
}
function batchDelAccounts() {
    const ids = $(".acc-check:checked").map((_,el) => el.value).get();
    if(ids.length === 0) return showToast("请先勾选");
    if(!confirm(`确定删除选中的 ${ids.length} 个账号？`)) return;
    
    Promise.all(ids.map(id => fetch(`${API_BASE}/accounts?id=${id}`, { method: 'DELETE', headers: getHeaders() })))
    .then(() => { showToast("批量删除完成"); loadAccounts(); });
}

function openBatchAccountModal() {
    $("#import-acc-json").val("");
    $("#import-acc-file-input").val("");
    new bootstrap.Modal(document.getElementById('batchAccountImportModal')).show();
}

function submitBatchAccountImport() {
    const activeTab = $("#importTabs .active").attr("data-bs-target");
    if (activeTab === "#tab-paste") {
        processAccountImport($("#import-acc-json").val());
    } else {
        const file = document.getElementById('import-acc-file-input').files[0];
        if(!file) return showToast("请选择文件");
        const reader = new FileReader();
        reader.onload = e => processAccountImport(e.target.result);
        reader.readAsText(file);
    }
}

function processAccountImport(text) {
    if(!text.trim()) return showToast("内容为空");
    try {
        const lines = text.split('\n').filter(l => l.trim());
        const json = lines.map(line => {
            const p = line.split('\t').map(s => s.trim());
            const creds = (p[2] || "").split(/[,，|]/).map(s => s.trim());
            return {
                name: p[0],
                email: p[1] || "",
                client_id: creds[0] || "",
                client_secret: creds[1] || "",
                refresh_token: creds[2] || ""
            };
        });
        
        fetch(`${API_BASE}/accounts`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(json) })
        .then(r => r.json()).then(res => {
            if(res.ok) {
                bootstrap.Modal.getInstance(document.getElementById('batchAccountImportModal')).hide();
                // [修改] 提示导入结果及跳过的邮箱
                let msg = `导入成功 ${res.added_count || 0} 个账号。`;
                if (res.skipped && res.skipped.length > 0) {
                    msg += `\n以下邮箱因已存在而跳过:\n` + res.skipped.join('\n');
                }
                alert(msg);
                loadAccounts();
            } else alert("导入失败: " + res.error);
        });
    } catch(e) { alert("解析错误"); }
}

function exportAccounts() {
    const content = cachedAccounts.map(acc => {
        const creds = `${acc.client_id||''},${acc.client_secret||''},${acc.refresh_token||''}`;
        return `${acc.name}\t${acc.email||''}\t${creds}`;
    }).join('\n');
    downloadFile(content, "accounts_backup.txt");
}

// ================== 2. 规则管理 ==================

function loadRules() {
    fetch(`${API_BASE}/rules`, { headers: getHeaders() })
    .then(r => r.json()).then(list => {
        cachedRules = list || [];
        pageState.rule.data = cachedRules;
        pageState.rule.filtered = cachedRules;
        pageState.rule.page = 1;
        renderRulesTable();
    });
}

function renderRulesTable() {
    const { filtered, page, size } = pageState.rule;
    const start = (page - 1) * size;
    const list = filtered.slice(start, start + size);
    const tbody = $("#rule-list-body");
    tbody.empty();
    
    if(list.length === 0) {
        tbody.html('<tr><td colspan="8" class="text-center p-4 text-muted">暂无规则或无匹配项</td></tr>');
    } else {
        const host = window.location.origin;
        list.forEach(r => {
            const link = `${host}/${r.query_code}`;
            const isExpired = r.valid_until && Date.now() > r.valid_until;
            const acc = cachedAccounts.find(a => a.name === r.name);
            const hiddenEmail = acc ? escapeHtml(acc.email) : "";

            let validStr = '<span class="text-success">永久</span>';
            if (r.valid_until) {
                if (isExpired) {
                    validStr = `<span class="text-danger">已过期</span>`;
                } else {
                    const days = Math.ceil((r.valid_until - Date.now()) / 86400000);
                    const d = new Date(r.valid_until);
                    const dateStr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
                    validStr = `${days}天 (${dateStr})`;
                }
            }
            
            let matchInfo = [];
            if(r.group_id) {
                const group = cachedGroups.find(g => g.id == r.group_id);
                const groupName = group ? group.name : `(ID:${r.group_id})`;
                matchInfo.push(`<span class="badge bg-primary text-white" title="策略组">组: ${escapeHtml(groupName)}</span>`);
            } else {
                if(r.match_sender) matchInfo.push(`<span class="badge bg-light text-dark border" title="发件人">发: ${escapeHtml(r.match_sender)}</span>`);
                if(r.match_receiver) matchInfo.push(`<span class="badge bg-light text-dark border" title="收件人">收: ${escapeHtml(r.match_receiver)}</span>`);
                if(r.match_body) matchInfo.push(`<span class="badge bg-light text-dark border" title="正文关键字">文: ${escapeHtml(r.match_body)}</span>`);
            }
            const matchHtml = matchInfo.length ? matchInfo.join('<br>') : '<span class="text-muted small">-</span>';
            const fullLinkStr = `${r.alias}---${link}`;
            
            tbody.append(`
                <tr data-email="${hiddenEmail}">
                    <td><input type="checkbox" class="rule-check" value="${r.id}"></td>
                    <td class="text-primary" style="cursor:pointer" onclick="copyStr('${escapeHtml(r.name)}', '已复制账号名！')" title="点击复制">${escapeHtml(r.name)}</td>
                    <td class="text-primary" style="cursor:pointer" onclick="copyStr('${escapeHtml(r.alias)}', '已复制别名！')" title="点击复制">${escapeHtml(r.alias)}</td>
                    <td>
                        <div class="input-group input-group-sm" style="width:160px">
                            <input class="form-control bg-white" style="padding:.25rem .39rem;" value="${r.query_code}" readonly>
                            <button class="btn btn-outline-secondary" onclick="window.open('${link}')" title="打开链接"><i class="fas fa-external-link-alt"></i></button>
                            <button class="btn btn-outline-secondary" onclick="copyStr('${fullLinkStr}', '已复制完整链接！')" title="复制: 别名---链接"><i class="fas fa-copy"></i></button>
                        </div>
                    </td>
                    <td class="small">${matchHtml}</td>
                    <td>${r.fetch_limit}</td>
                    <td>${validStr}</td>
                    <td>
                        <button class="btn btn-sm btn-light text-primary" onclick="openEditRule(${r.id})"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm btn-light text-danger" onclick="delRule(${r.id})"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `);
        });
    }
    $("#rule-page-info").text(`共 ${filtered.length} 条 (第 ${page}/${Math.ceil(filtered.length/size)||1} 页)`);
}

// [修改] 过滤规则 (支持分页)
function filterRules(val) {
    const k = val.toLowerCase();
    pageState.rule.filtered = pageState.rule.data.filter(r => {
        // 1. 基础信息：账号名、别名、查询码、邮箱
        const acc = cachedAccounts.find(a => a.name === r.name);
        const email = acc ? acc.email : "";
        
        // 2. 策略组名称
        let groupName = "";
        if (r.group_id) {
            const g = cachedGroups.find(x => x.id == r.group_id);
            if (g) groupName = g.name;
        }

        // 3. 拼接所有内容进行搜索 (包含: 基础信息 + 组名 + 自定义匹配的发/收/文)
        const content = (
            r.name + " " + 
            r.alias + " " + 
            r.query_code + " " + 
            email + " " + 
            groupName + " " + 
            (r.match_sender || "") + " " + 
            (r.match_receiver || "") + " " + 
            (r.match_body || "")
        ).toLowerCase();

        return content.includes(k);
    });
    pageState.rule.page = 1;
    renderRulesTable();
}

function openAddRuleModal() {
    $("#ruleModalTitle").text("添加收件规则");
    $("#rule-id").val("");
    $("#rule-name").val("");
    $("#rule-alias").val("");
    $("#rule-code").val("");
    $("#rule-limit").val("5");
    $("#rule-valid").val("");
    $("#rule-match-sender").val("");
    $("#rule-match-receiver").val("");
    $("#rule-match-body").val("");

    $("#rule-group-select").val("");
    toggleRuleMode();

    new bootstrap.Modal(document.getElementById('addRuleModal')).show();
}

function openEditRule(id) {
    const r = cachedRules.find(x => x.id == id);
    if(!r) return;
    
    $("#rule-id").val(r.id);
    $("#rule-name").val(r.name);
    $("#rule-alias").val(r.alias);
    $("#rule-code").val(r.query_code);
    $("#rule-limit").val(r.fetch_limit);
    
    let days = "";
    if(r.valid_until && r.valid_until > Date.now()) {
        days = Math.ceil((r.valid_until - Date.now()) / 86400000);
    }
    $("#rule-valid").val(days);

    $("#rule-group-select").val(r.group_id || "");
    toggleRuleMode();

    $("#rule-match-sender").val(r.match_sender);
    $("#rule-match-receiver").val(r.match_receiver);
    $("#rule-match-body").val(r.match_body);
    
    $("#ruleModalTitle").text("编辑收件规则");
    new bootstrap.Modal(document.getElementById('addRuleModal')).show();
}

function saveRule() {
    const validDays = parseInt($("#rule-valid").val());
    const validUntil = validDays ? Date.now() + (validDays * 86400000) : null;

    const data = {
        name: $("#rule-name").val(),
        alias: $("#rule-alias").val(),
        query_code: $("#rule-code").val(),
        fetch_limit: $("#rule-limit").val(),
        valid_until: validUntil,
        match_sender: $("#rule-match-sender").val(),
        match_receiver: $("#rule-match-receiver").val(),
        match_body: $("#rule-match-body").val(),
        group_id: $("#rule-group-select").val() || null 
    };

    if(!data.name) return showToast("必须填写绑定账号名");

    const id = $("#rule-id").val();
    if(id) data.id = id;
    const method = id ? 'PUT' : 'POST';

    fetch(`${API_BASE}/rules`, { method: method, headers: getHeaders(), body: JSON.stringify(data) })
    .then(r => r.json()).then(res => {
        if(res.success) {
            bootstrap.Modal.getInstance(document.getElementById('addRuleModal')).hide();
            showToast("保存成功");
            loadRules();
        } else alert("失败: " + res.error);
    });
}

function delRule(id) {
    if(confirm("删除规则?")) fetch(`${API_BASE}/rules`, { method:'DELETE', headers: getHeaders(), body: JSON.stringify([id]) }).then(()=>loadRules());
}

function batchDelRules() {
    const ids = $(".rule-check:checked").map((_,el) => parseInt(el.value)).get();
    if(ids.length===0) return showToast("请先选择");
    if(confirm(`删除 ${ids.length} 条规则?`)) {
        fetch(`${API_BASE}/rules`, { method:'DELETE', headers: getHeaders(), body: JSON.stringify(ids) }).then(()=>loadRules());
    }
}

function openBatchRuleModal() {
    $("#import-rule-text").val("");
    $("#import-rule-file-input").val("");
    new bootstrap.Modal(document.getElementById('batchRuleImportModal')).show();
}

function submitBatchRuleImport() {
    const activeTab = $("#ruleImportTabs .active").attr("data-bs-target");
    if(activeTab === "#tab-rule-paste") {
        processRuleImport($("#import-rule-text").val());
    } else {
        const file = document.getElementById('import-rule-file-input').files[0];
        if(!file) return showToast("请选择文件");
        const r = new FileReader();
        reader.onload = e => processRuleImport(e.target.result);
        r.readAsText(file);
    }
}

function processRuleImport(text) {
    try {
        const lines = text.split('\n').filter(l => l.trim());
        const items = lines.map(l => {
            const p = l.split('\t').map(s=>s.trim());
            const days = parseInt(p[4]);
            const gId = (cachedGroups.find(g => g.name === (p[8]||'')) || {}).id || null;
            return {
                name: p[0], alias: p[1]||'', query_code: p[2]||'', fetch_limit: p[3]||'5',
                valid_until: days ? Date.now() + days*86400000 : null,
                match_sender: p[5]||'', match_receiver: p[6]||'', match_body: p[7]||'', group_id: gId
            };
        });
        
        Promise.all(items.map(item => fetch(`${API_BASE}/rules`, { method:'POST', headers:getHeaders(), body:JSON.stringify(item) })))
        .then(() => {
            bootstrap.Modal.getInstance(document.getElementById('batchRuleImportModal')).hide();
            alert("导入完成");
            loadRules();
        });
    } catch(e) { alert("解析错误"); }
}

function exportRules() {
    const content = cachedRules.map(r => {
        const days = r.valid_until ? Math.ceil((r.valid_until - Date.now())/86400000) : '';
        const gName = (cachedGroups.find(g => g.id == r.group_id) || {}).name || '';
        return `${r.name}\t${r.alias}\t${r.query_code}\t${r.fetch_limit}\t${days}\t${r.match_sender||''}\t${r.match_receiver||''}\t${r.match_body||''}\t${gName}`;
    }).join('\n');
    downloadFile(content, "rules_backup.txt");
}

// ================== 3. 发件任务 ==================

function toLocalISOString(date) {
    const pad = (n) => n < 10 ? '0' + n : n;
    return date.getFullYear() + '-' +
        pad(date.getMonth() + 1) + '-' +
        pad(date.getDate()) + 'T' +
        pad(date.getHours()) + ':' +
        pad(date.getMinutes());
}

function getSelectedAccountId() {
    const name = $("#send-from").val();
    const acc = cachedAccounts.find(a => a.name == name);
    return acc ? acc.id : null;
}

function loadTasks() {
    if(!cachedAccounts.length) loadAccounts();

    fetch(`${API_BASE}/tasks?limit=100`, { headers: getHeaders() }).then(r=>r.json()).then(res => {
        cachedTasks = res.data || [];
        pageState.task.data = cachedTasks;
        pageState.task.filtered = cachedTasks;
        pageState.task.page = 1;
        renderTasksTable();
    });
}

function renderTasksTable() {
    const { filtered, page, size } = pageState.task;
    const start = (page - 1) * size;
    const list = filtered.slice(start, start + size);
    const tbody = $("#task-list-body");
    tbody.empty();

    if(list.length === 0) {
        tbody.html('<tr><td colspan="7" class="text-center p-4 text-muted">暂无任务或无匹配项</td></tr>');
    } else {
        list.forEach(t => {
            const next = new Date(t.next_run_at).toLocaleString();
            const statusMap = { 'pending': '等待中', 'success': '成功', 'error': '失败', 'running': '运行中' };
            const statusText = statusMap[t.status] || t.status;
            const statusClass = t.status==='success'?'text-success':(t.status==='error'?'text-danger':'text-warning');
            const countsDisplay = `<div style="font-size: 0.75rem; color: #666; margin-top: 2px;">成功:${t.success_count||0} / 失败:${t.fail_count||0}</div>`;          
            const loopSwitch = `
            <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" ${t.is_loop ? 'checked' : ''} onchange="toggleTaskLoop(${t.id}, this.checked)">
            </div>`;

            tbody.append(`
                <tr>
                    <td><input type="checkbox" class="task-check" value="${t.id}"></td>
                    <td>${escapeHtml(t.account_name || 'ID:'+t.account_id)}</td>
                    <td class="text-truncate" style="max-width:150px">${escapeHtml(t.subject||'-')}</td>
                    <td class="small">${next}</td>
                    <td>${loopSwitch}</td>
                    <td class="${statusClass} fw-bold">
                        ${statusText}
                        ${countsDisplay}
                    </td>
                    <td>
                        <button class="btn btn-sm btn-outline-primary py-0" title="执行" onclick="manualRun(${t.id})"><i class="fas fa-play"></i></button>
                        <button class="btn btn-sm btn-outline-secondary py-0" title="编辑" onclick="editTask(${t.id})"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm btn-outline-danger py-0" title="删除" onclick="delTask(${t.id})"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `);
        });
    }
    $("#task-page-info").text(`共 ${filtered.length} 条 (第 ${page}/${Math.ceil(filtered.length/size)||1} 页)`);
}

// [修改] 过滤任务 (支持分页)
function filterTasks(val) {
    const k = val.toLowerCase();
    pageState.task.filtered = pageState.task.data.filter(t => {
        const text = ((t.account_name||"") + " " + (t.subject||"") + " " + (t.to_email||"")).toLowerCase();
        return text.includes(k);
    });
    pageState.task.page = 1;
    renderTasksTable();
}

function toggleTaskLoop(id, isLoop) {
    const task = cachedTasks.find(t => t.id === id);
    if (!task) return;
    
    const data = { ...task, is_loop: isLoop };
    fetch(`${API_BASE}/tasks`, { method: 'PUT', headers: getHeaders(), body: JSON.stringify(data) })
        .then(r => r.json()).then(res => {
            if(res.ok) { 
                showToast("循环状态已更新"); 
                task.is_loop = isLoop;
            } else { 
                showToast("更新失败: " + res.error); 
                loadTasks();
            }
        });
}

function saveTask() {
    const id = $("#edit-task-id").val();
    const accId = getSelectedAccountId();
    if(!accId) return alert("没有些号！");

    const delay = $("#delay-config").val(); 
    const localDateStr = $("#date-a").val();
    let utcDateStr = "";
    if (localDateStr) {
        utcDateStr = new Date(localDateStr).toISOString();
    }

    const data = {
        account_id: accId,
        to_email: $("#send-to").val(),
        subject: $("#send-subject").val() || "Remind",
        content: $("#send-content").val() || ("Reminder of current time: " + new Date().toISOString()),
        is_loop: $("#loop-switch").is(":checked"),
        delay_config: delay,
        base_date: utcDateStr
    };

    if(!data.to_email) return showToast("请补全收件人");
    if(id) data.id = id;

    const method = id ? 'PUT' : 'POST';

    fetch(`${API_BASE}/tasks`, { method: method, headers: getHeaders(), body: JSON.stringify(data) })
    .then(r => r.json()).then(res => {
        if(res.ok) { 
            showToast(id ? "任务已更新" : "已加入队列"); 
            if(id) cancelEditTask(); 
            loadTasks(); 
        }
        else alert("失败: " + res.error);
    });
}

function editTask(id) {
    const task = cachedTasks.find(t => t.id == id);
    if(!task) return;
    
    $("#edit-task-id").val(task.id);
    $("#send-from").val(task.account_name || '');
    $("#send-to").val(task.to_email);
    $("#send-subject").val(task.subject);
    $("#send-content").val(task.content);
    
    const timeVal = task.next_run_at || task.base_date;
    if (timeVal) {
        const dateObj = new Date(timeVal);
        if (!isNaN(dateObj.getTime())) {
            $("#date-a").val(toLocalISOString(dateObj));
        } else {
            $("#date-a").val("");
        }
    } else {
        $("#date-a").val("");
    }
    $("#delay-config").val(task.delay_config);
    $("#loop-switch").prop("checked", !!task.is_loop);
    
    $("#task-card-title").text("编辑任务 (ID: " + id + ")");
    $("#btn-save-task").html('<i class="fas fa-save"></i> 更新任务');
    $("#btn-cancel-edit").removeClass("d-none");
    
    if(!$("#section-send").hasClass("active")) showSection('section-send');
}

function cancelEditTask() {
    $("#edit-task-id").val("");
    $("#task-card-title").text("创建任务 / 立即发送");
    $("#btn-save-task").html('<i class="fas fa-clock"></i> 添加任务');
    $("#btn-cancel-edit").addClass("d-none");
    
    $("#send-from").val("");
    $("#send-to").val("");
    $("#send-subject").val("");
    $("#send-content").val("");
    $("#date-a").val("");
    $("#delay-config").val("");
    $("#loop-switch").prop("checked", false);
}

function manualRun(id) {
    if(!confirm("立即执行?")) return;
    fetch(`${API_BASE}/tasks`, { method: 'PUT', headers: getHeaders(), body: JSON.stringify({ id: id, action: 'execute' }) })
        .then(r=>r.json()).then(res=>{
        if(res.ok) { showToast("执行成功"); loadTasks(); }
        else showToast("失败: "+res.error);
    });
}

function sendNow() {
    const accId = getSelectedAccountId();
    if(!accId) return alert("没有些号！");

    const btn = $(event.target);
    const org = btn.html();
    btn.html('<i class="fas fa-spinner fa-spin"></i>').prop('disabled', true);
    
    const data = {
        account_id: accId,
        to_email: $("#send-to").val(),
        subject: $("#send-subject").val() || "Remind",
        content: $("#send-content").val() || ("Reminder of current time: " + new Date().toISOString()),
        immediate: true
    };
    
    fetch(`${API_BASE}/tasks`, { method:'POST', headers: getHeaders(), body: JSON.stringify(data) })
    .then(r => r.json()).then(res => {
        btn.html(org).prop('disabled', false);
        if(res.ok) alert("发送成功");
        else alert("失败: " + res.error);
    });
}

function delTask(id) {
    if(confirm("删除任务?")) fetch(`${API_BASE}/tasks?id=${id}`, { method:'DELETE', headers: getHeaders() }).then(()=>loadTasks());
}

function batchDelTasks() {
    const ids = $(".task-check:checked").map((_,el) => el.value).get();
    if(ids.length===0) return showToast("请先选择");
    if(confirm(`删除 ${ids.length} 个任务?`)) {
        fetch(`${API_BASE}/tasks?ids=${ids.join(',')}`, { method:'DELETE', headers: getHeaders() }).then(()=>loadTasks());
    }
}

function openBatchTaskModal() {
    $("#batch-task-json").val("");
    new bootstrap.Modal(document.getElementById('batchTaskModal')).show();
}

function submitBatchTasks() {
    try {
        const json = JSON.parse($("#batch-task-json").val());
        if(!Array.isArray(json)) throw new Error("必须是数组");
        
        fetch(`${API_BASE}/tasks`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(json) }) 
        .then(() => {
            bootstrap.Modal.getInstance(document.getElementById('batchTaskModal')).hide();
            alert("批量添加成功");
            loadTasks();
        });
    } catch(e) { alert("JSON 格式错误"); }
}

// ================== 4. 收件箱 ==================

function loadInboxList() {
    const listEl = $("#inbox-account-list");
    listEl.empty();
    
    if(cachedAccounts.length === 0) {
        fetch(`${API_BASE}/accounts?limit=100`, { headers: getHeaders() }).then(r=>r.json()).then(res => {
            cachedAccounts = res.data || [];
            renderInboxList(cachedAccounts);
        });
    } else {
        renderInboxList(cachedAccounts);
    }
}

function renderInboxList(list) {
    const el = $("#inbox-account-list");
    el.empty();
    list.forEach(acc => {
        if (acc.status != null && acc.status == 0) return;
        el.append(`
            <a href="#" class="list-group-item list-group-item-action" onclick="viewInbox(${acc.id}, '${escapeHtml(acc.name)}', this)">
                <div class="d-flex w-100 justify-content-between">
                    <h6 class="mb-1 text-truncate">${escapeHtml(acc.name)}</h6>
                    <small><i class="fas fa-chevron-right"></i></small>
                </div>
                <small class="text-muted d-block text-truncate" title="${escapeHtml(acc.email||'')}">${escapeHtml(acc.email||'')}</small>
            </a>
        `);
    });
}

function filterInboxAccounts(val) {
    const k = val.toLowerCase();
    $("#inbox-account-list a").each(function() {
        $(this).toggle($(this).text().toLowerCase().includes(k));
    });
}

let currentLimit = 2;

function setLimit(n) {
    const num = parseInt(n);
    if(num > 0) {
        currentLimit = num;
        showToast(`已设置为显示 ${num} 封`);
        const activeId = $("#inbox-account-list .active").attr("onclick"); 
        if(activeId) {
            $("#inbox-account-list .active").click();
        }
    }
}

function viewInbox(id, name, el) {
    $("#inbox-account-list a").removeClass("active");
    if(el) $(el).addClass("active");
    
    const box = $("#email-content-view");
    box.html(`<div class="text-center mt-5"><div class="spinner-border text-primary"></div><p>正在同步 ${escapeHtml(name)}...</p></div>`);
    
    fetch(`${API_BASE}/emails?account_id=${id}&limit=${currentLimit}`, { headers: getHeaders() })
    .then(r => r.json()).then(res => {
        if(res.error) return box.html(`<div class="text-center mt-5 text-danger"><p>错误: ${res.error}</p></div>`);
        if(!res.length) return box.html(`<div class="text-center mt-5 text-muted"><p>收件箱为空</p></div>`);
        
        let html = `<div class="p-3 border-bottom d-flex justify-content-between bg-light"><strong>${escapeHtml(name)}</strong> <small>最新10封</small></div><div class="p-3" style="overflow-y:auto">`;
        
        res.forEach((m, index) => {
            html += `
                <div class="card mb-3 shadow-sm border-0">
                    <div class="card-body p-3">
                        <h6 class="card-title text-primary">${escapeHtml(m.subject||'(无主题)')}</h6>
                        <h6 class="card-subtitle mb-2 text-muted small">${escapeHtml(m.sender)} | ${new Date(m.received_at).toLocaleString()}</h6>
                        <div id="email-shadow-host-${index}" class="card-text small bg-light p-2 rounded overflow-auto" style="min-height:50px;"></div>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        box.html(html);
        res.forEach((m, index) => {
            const host = document.getElementById(`email-shadow-host-${index}`);
            if (host) {
                try {
                    const shadow = host.attachShadow({mode: 'open'});
                    shadow.innerHTML = `
                        <style>
                            :host { display: block; font-family: -apple-system, sans-serif; }
                            img { max-width: 100%; height: auto; }
                            p { margin: 0 0 10px 0; }
                            body { background-color: transparent; margin: 0; color: #333; }
                        </style>
                        ${m.htmlContent || m.body}
                    `;
                } catch(e) { console.error("Shadow DOM error:", e); }
            }
        });
    });
}    

// ================== 通用工具 ==================

function toggleAll(type) {
    const checked = $(`#check-all-${type}`).is(":checked");
    $(`.${type}-check`).prop("checked", checked);
}

// 注意：原有的 filterAccounts, filterRules, filterTasks 已被替换为支持分页的版本，并移至各自模块区域

function generateRandomRuleCode() {
    $("#rule-code").val(Math.random().toString(36).substring(2, 12).toUpperCase());
}

function escapeHtml(text) {
    if(!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function downloadFile(content, filename) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function showToast(msg) {
    $("#mouse-toast").text(msg).fadeIn().delay(300).fadeOut();
}

function copyAccountInfo(id, type) {
    const acc = cachedAccounts.find(a => a.id == id);
    if(!acc) return;
    let text = "";
    if(type === 'email') text = acc.email;
    if(type === 'creds') text = `${acc.client_id || ''}, ${acc.client_secret || ''}, ${acc.refresh_token || ''}`;
    
    if(text) {
        navigator.clipboard.writeText(text).then(() => showToast("已复制！")).catch(()=>showToast("复制失败"));
    }
}

function copyStr(str, msg) {
    if(!str) return;
    navigator.clipboard.writeText(str).then(() => showToast(msg || "已复制！")).catch(()=>showToast("复制失败"));
}

$(document).mousemove(function(e){
    $("#mouse-toast").css({top: e.pageY + 15, left: e.pageX + 15});
});

$("#admin-pass").keyup(function(event) {
    if (event.keyCode === 13) {
        doLogin();
    }
});

// ================== 策略组逻辑 (新增) ==================

function loadGroups() {
    fetch(`${API_BASE}/groups`, { headers: getHeaders() })
    .then(r => r.json())
    .then(res => {
        cachedGroups = res.data || [];
        renderGroupList();
        updateRuleModalGroupSelect();
    });
}

function renderGroupList() {
    const tbody = $("#group-list-body");
    tbody.empty();
    if(cachedGroups.length === 0) {
        tbody.html('<tr><td colspan="5" class="text-center text-muted p-4">暂无策略组</td></tr>');
        return;
    }
    cachedGroups.forEach(g => {
        tbody.append(`
            <tr>
                <td class="fw-bold">${escapeHtml(g.name)}</td>
                <td>${escapeHtml(g.match_sender || '-')}</td>
                <td>${escapeHtml(g.match_receiver || '-')}</td>
                <td>${escapeHtml(g.match_body || '-')}</td>
                <td>
                    <button class="btn btn-sm btn-light text-primary" onclick="openEditGroup(${g.id})"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-sm btn-light text-danger" onclick="delGroup(${g.id})"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `);
    });
}

function updateRuleModalGroupSelect() {
    const sel = $("#rule-group-select");
    const currentVal = sel.val();
    sel.empty();
    sel.append('<option value="">(自定义模式)</option>');
    cachedGroups.forEach(g => {
        sel.append(`<option value="${g.id}">${escapeHtml(g.name)}</option>`);
    });
    if(currentVal) sel.val(currentVal);
}

function toggleRuleMode() {
    const groupId = $("#rule-group-select").val();
    if (groupId) {
        $("#custom-match-fields").addClass("d-none");
        $("#group-match-hint").removeClass("d-none");
    } else {
        $("#custom-match-fields").removeClass("d-none");
        $("#group-match-hint").addClass("d-none");
    }
}

function openAddGroupModal() {
    $("#groupModalTitle").text("新建策略组");
    $("#group-id").val("");
    $("#group-name").val("");
    $("#group-match-sender").val("");
    $("#group-match-receiver").val("");
    $("#group-match-body").val("");
    new bootstrap.Modal(document.getElementById('addGroupModal')).show();
}

function openEditGroup(id) {
    const g = cachedGroups.find(x => x.id == id);
    if(!g) return;
    $("#groupModalTitle").text("编辑策略组");
    $("#group-id").val(g.id);
    $("#group-name").val(g.name);
    $("#group-match-sender").val(g.match_sender);
    $("#group-match-receiver").val(g.match_receiver);
    $("#group-match-body").val(g.match_body);
    new bootstrap.Modal(document.getElementById('addGroupModal')).show();
}

function saveGroup() {
    const data = {
        name: $("#group-name").val(),
        match_sender: $("#group-match-sender").val(),
        match_receiver: $("#group-match-receiver").val(),
        match_body: $("#group-match-body").val()
    };
    if(!data.name) return showToast("组名不能为空");
    
    const id = $("#group-id").val();
    if(id) data.id = id;
    
    fetch(`${API_BASE}/groups`, { method: id ? 'PUT' : 'POST', headers: getHeaders(), body: JSON.stringify(data) })
    .then(r => r.json()).then(res => {
        if(res.ok) {
            bootstrap.Modal.getInstance(document.getElementById('addGroupModal')).hide();
            showToast("保存成功");
            loadGroups();
        } else alert("保存失败");
    });
}

function delGroup(id) {
    if(!confirm("确定删除？关联规则将自动转为自定义模式。")) return;
    fetch(`${API_BASE}/groups?id=${id}`, { method: 'DELETE', headers: getHeaders() })
    .then(() => { showToast("已删除"); loadGroups(); });
}

// 启动
if(localStorage.getItem("auth_token")) {
    $("#login-overlay").hide();
    initApp();
}
