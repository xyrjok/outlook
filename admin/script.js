const API_BASE = "/api";

// 全局缓存
let cachedAccounts = [];
let cachedRules = [];
let cachedTasks = [];

// ================== 认证模块 ==================

function doLogin() {
    const u = $("#admin-user").val();
    const p = $("#admin-pass").val();
    if(!u || !p) return showToast("请输入账号密码");
    
    const token = "Basic " + btoa(u + ":" + p);
    
    fetch(`${API_BASE}/login`, { method: 'POST', headers: { "Authorization": token } })
    .then(r => {
        if(r.ok) {
            localStorage.setItem("auth_token", token);
            $("#login-overlay").fadeOut();
            initApp();
        } else {
            showToast("账号或密码错误");
        }
    }).catch(() => showToast("连接失败"));
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
    // 预加载其他数据可选
}

function showSection(id) {
    $(".content-section").removeClass("active");
    $(`#${id}`).addClass("active");
    $(".list-group-item").removeClass("active");
    $(event.currentTarget).addClass("active");
    
    if(id === 'section-accounts') loadAccounts();
    if(id === 'section-rules') loadRules();
    if(id === 'section-send') loadTasks();
    if(id === 'section-receive') loadInboxList();
}

// ================== 1. 账号管理 (Microsoft) ==================

function loadAccounts() {
    fetch(`${API_BASE}/accounts?limit=100`, { headers: getHeaders() })
    .then(r => r.json())
    .then(res => {
        const list = res.data || [];
        cachedAccounts = list;
        
        // 渲染表格
        const tbody = $("#account-list-body");
        tbody.empty();
        
        // 同步更新发信下拉框
        const sendSel = $("#send-from");
        sendSel.empty(); // 清空旧选项
        sendSel.append('<option value="">请选择发件账号...</option>');

        if(list.length === 0) {
            tbody.html('<tr><td colspan="6" class="text-center p-4 text-muted">暂无账号</td></tr>');
            return;
        }

        list.forEach(acc => {
            // 拼接凭据显示字符串
            let configStr = '-';
            if (acc.client_id) {
                const secretMask = acc.client_secret ? '******' : '';
                const tokenMask = acc.refresh_token ? acc.refresh_token.substring(0, 8) + '...' : '';
                configStr = `${acc.client_id}, ${secretMask}, ${tokenMask}`;
            }

            const statusBadge = acc.refresh_token 
                ? '<span class="badge bg-success">已配置</span>' 
                : '<span class="badge bg-secondary">未配置</span>';

            tbody.append(`
                <tr>
                    <td><input type="checkbox" class="acc-check" value="${acc.id}"></td>
                    <td class="fw-bold text-primary cursor-pointer" onclick="openEditAccount(${acc.id})">${escapeHtml(acc.name)}</td>
                    <td>${escapeHtml(acc.email||'-')}</td>
                    <td class="api-config-cell" title="点击编辑查看">${configStr}</td>
                    <td>${statusBadge}</td>
                    <td>
                        <button class="btn btn-sm btn-light text-primary" onclick="openEditAccount(${acc.id})"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm btn-light text-danger" onclick="delAccount(${acc.id})"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `);

            sendSel.append(`<option value="${acc.id}">${escapeHtml(acc.name)} ${acc.email ? '('+acc.email+')' : ''}</option>`);
        });
        
        $("#acc-page-info").text(`共 ${list.length} 条`);
    });
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
    
    // 回显凭据为逗号分隔字符串
    const config = [acc.client_id, acc.client_secret, acc.refresh_token].filter(x=>x).join(', ');
    $("#acc-api-config").val(config);
    
    new bootstrap.Modal(document.getElementById('addAccountModal')).show();
}

function saveAccount() {
    const rawConfig = $("#acc-api-config").val().trim();
    // 解析分隔符: 英文逗号、中文逗号、竖线
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
            alert("保存失败: " + res.error);
        }
    });
}

function delAccount(id) {
    if(!confirm("确定删除此账号？")) return;
    fetch(`${API_BASE}/accounts?id=${id}`, { method: 'DELETE', headers: getHeaders() })
    .then(() => { showToast("已删除"); loadAccounts(); });
}

function batchDelAccounts() {
    const ids = $(".acc-check:checked").map((_,el) => el.value).get(); // 获取所有选中ID
    if(ids.length === 0) return showToast("请先勾选");
    if(!confirm(`确定删除选中的 ${ids.length} 个账号？`)) return;
    
    // 循环删除 (后端若支持批量ID可优化)
    Promise.all(ids.map(id => fetch(`${API_BASE}/accounts?id=${id}`, { method: 'DELETE', headers: getHeaders() })))
    .then(() => { showToast("批量删除完成"); loadAccounts(); });
}

// 批量导入
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
            // 格式: 名称 \t 邮箱 \t ID,Secret,Token
            const p = line.split('\t').map(s => s.trim());
            // 支持 英文逗号、中文逗号、竖线 分隔
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
                alert("导入成功");
                loadAccounts();
            } else alert("导入失败: " + res.error);
        });
    } catch(e) { alert("解析错误"); }
}

// 批量导出
function exportAccounts() {
    // 格式: 名称 \t 邮箱 \t ID,Secret,Token
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
        cachedRules = list;
        const tbody = $("#rule-list-body");
        tbody.empty();
        
        if(!list || list.length === 0) {
            tbody.html('<tr><td colspan="7" class="text-center p-4 text-muted">暂无规则</td></tr>');
            return;
        }

        const host = window.location.origin;
        list.forEach(r => {
            const link = `${host}/${r.query_code}`;
            const isExpired = r.valid_until && Date.now() > r.valid_until;
            const validStr = r.valid_until 
                ? (isExpired ? `<span class="text-danger">已过期</span>` : new Date(r.valid_until).toLocaleDateString())
                : '<span class="text-success">永久</span>';
            
            // 过滤条件概览
            const filters = [r.match_sender ? `发:${r.match_sender}`:null, r.match_body ? `文:${r.match_body}`:null].filter(x=>x).join('; ');

            tbody.append(`
                <tr>
                    <td><input type="checkbox" class="rule-check" value="${r.id}"></td>
                    <td>${escapeHtml(r.name)} <span class="text-muted small">(${escapeHtml(r.alias)})</span></td>
                    <td>
                        <div class="input-group input-group-sm" style="width:140px">
                            <input class="form-control bg-white" value="${r.query_code}" readonly>
                            <button class="btn btn-outline-secondary" onclick="window.open('${link}')"><i class="fas fa-external-link-alt"></i></button>
                        </div>
                    </td>
                    <td>${r.fetch_limit}</td>
                    <td>${validStr}</td>
                    <td class="small text-muted">${filters || '-'}</td>
                    <td>
                        <button class="btn btn-sm btn-light text-danger" onclick="delRule(${r.id})"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `);
        });
    });
}

function openAddRuleModal() {
    $("#rule-id").val("");
    $("#rule-name").val("");
    $("#rule-alias").val("");
    $("#rule-code").val("");
    $("#rule-limit").val("5");
    $("#rule-valid").val("");
    $("#rule-match-sender").val("");
    $("#rule-match-body").val("");
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
        match_body: $("#rule-match-body").val()
    };

    if(!data.name) return showToast("必须填写绑定账号名");

    fetch(`${API_BASE}/rules`, { method:'POST', headers: getHeaders(), body: JSON.stringify(data) })
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

// 批量导入规则
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
        r.onload = e => processRuleImport(e.target.result);
        r.readAsText(file);
    }
}

function processRuleImport(text) {
    try {
        const lines = text.split('\n').filter(l => l.trim());
        const items = lines.map(l => {
            const p = l.split('\t').map(s=>s.trim());
            const days = parseInt(p[4]);
            return {
                name: p[0], alias: p[1]||'', query_code: p[2]||'', fetch_limit: p[3]||'5',
                valid_until: days ? Date.now() + days*86400000 : null,
                match_sender: p[5]||'', match_receiver: p[6]||'', match_body: p[7]||''
            };
        });
        
        // 循环插入 (后端支持单条，这里演示前端循环调)
        // 实际建议后端支持数组
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
        return `${r.name}\t${r.alias}\t${r.query_code}\t${r.fetch_limit}\t${days}\t${r.match_sender||''}\t\t${r.match_body||''}`;
    }).join('\n');
    downloadFile(content, "rules_backup.txt");
}

// ================== 3. 发件任务 ==================

function loadTasks() {
    // 确保有账号数据用于显示名称
    if(!cachedAccounts.length) loadAccounts();

    fetch(`${API_BASE}/tasks?limit=100`, { headers: getHeaders() }).then(r=>r.json()).then(res => {
        const list = res.data || [];
        cachedTasks = list;
        const tbody = $("#task-list-body");
        tbody.empty();

        if(list.length === 0) {
            tbody.html('<tr><td colspan="7" class="text-center p-4 text-muted">暂无任务</td></tr>');
            return;
        }

        list.forEach(t => {
            const next = new Date(t.next_run_at).toLocaleString();
            const statusClass = t.status==='success'?'text-success':(t.status==='error'?'text-danger':'text-warning');
            const loopIcon = t.is_loop ? '<i class="fas fa-sync text-info" title="循环"></i>' : '';
            
            tbody.append(`
                <tr>
                    <td><input type="checkbox" class="task-check" value="${t.id}"></td>
                    <td>${escapeHtml(t.account_name || 'ID:'+t.account_id)}</td>
                    <td class="text-truncate" style="max-width:150px">${escapeHtml(t.subject||'-')}</td>
                    <td class="small">${next}</td>
                    <td>${loopIcon}</td>
                    <td class="${statusClass} fw-bold">${t.status}</td>
                    <td><button class="btn btn-sm btn-light text-danger" onclick="delTask(${t.id})"><i class="fas fa-trash"></i></button></td>
                </tr>
            `);
        });
    });
}

function saveTask() {
    const delay = $("#delay-config").val(); // 1|0|0|0
    const data = {
        account_id: $("#send-from").val(),
        to_email: $("#send-to").val(),
        subject: $("#send-subject").val(),
        content: $("#send-content").val(),
        is_loop: $("#loop-switch").is(":checked"),
        delay_config: delay,
        base_date: $("#date-a").val() // 2023-01-01T12:00
    };

    if(!data.account_id || !data.to_email) return showToast("请补全信息");

    fetch(`${API_BASE}/tasks`, { method:'POST', headers: getHeaders(), body: JSON.stringify(data) })
    .then(r => r.json()).then(res => {
        if(res.ok) { showToast("已加入队列"); loadTasks(); }
        else alert("失败: " + res.error);
    });
}

function sendNow() {
    const btn = $(event.target);
    const org = btn.html();
    btn.html('<i class="fas fa-spinner fa-spin"></i>').prop('disabled', true);
    
    const data = {
        account_id: $("#send-from").val(),
        to_email: $("#send-to").val(),
        subject: $("#send-subject").val(),
        content: $("#send-content").val(),
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

// 批量添加任务
function openBatchTaskModal() {
    $("#batch-task-json").val("");
    new bootstrap.Modal(document.getElementById('batchTaskModal')).show();
}

function submitBatchTasks() {
    try {
        const json = JSON.parse($("#batch-task-json").val());
        if(!Array.isArray(json)) throw new Error("必须是数组");
        
        fetch(`${API_BASE}/tasks`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(json) }) // 后端需支持POST数组
        .then(() => {
            bootstrap.Modal.getInstance(document.getElementById('batchTaskModal')).hide();
            alert("批量添加成功");
            loadTasks();
        });
    } catch(e) { alert("JSON 格式错误"); }
}

// ================== 4. 收件箱 ==================

function loadInboxList() {
    // 复用账号列表逻辑，只是渲染到左侧栏
    const listEl = $("#inbox-account-list");
    listEl.empty();
    
    // 如果没有账号缓存，先加载
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
        el.append(`
            <a href="#" class="list-group-item list-group-item-action" onclick="viewInbox(${acc.id}, '${escapeHtml(acc.name)}', this)">
                <div class="d-flex w-100 justify-content-between">
                    <h6 class="mb-1 text-truncate">${escapeHtml(acc.name)}</h6>
                    <small><i class="fas fa-chevron-right"></i></small>
                </div>
                <small class="text-muted">${escapeHtml(acc.email||'')}</small>
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

// 添加全局变量
let currentLimit = 10;

// 添加切换函数
function setLimit(n) {
    const num = parseInt(n);
    if(num > 0) {
        currentLimit = num;
        showToast(`已设置为显示 ${num} 封`);
        // 如果当前有选中的邮箱，立即刷新
        const activeId = $("#inbox-account-list .active").attr("onclick"); 
        if(activeId) {
            // 解析出 ID 和 Name 重新触发加载
            // 这里简单处理：让用户手动点一下或者自动触发点击
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
        
        res.forEach(m => {
            html += `
                <div class="card mb-3 shadow-sm border-0">
                    <div class="card-body p-3">
                        <h6 class="card-title text-primary">${escapeHtml(m.subject||'(无主题)')}</h6>
                        <h6 class="card-subtitle mb-2 text-muted small">${escapeHtml(m.sender)} | ${new Date(m.received_at).toLocaleString()}</h6>
                        <p class="card-text small bg-light p-2 rounded" style="white-space: pre-wrap;">${escapeHtml(m.body)}</p>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        box.html(html);
    });
}

// ================== 通用工具 ==================

function toggleAll(type) {
    const checked = $(`#check-all-${type}`).is(":checked");
    $(`.${type}-check`).prop("checked", checked);
}

function filterAccounts(val) {
    const k = val.toLowerCase();
    $("#account-list-body tr").each(function() {
        $(this).toggle($(this).text().toLowerCase().includes(k));
    });
}

function filterRules(val) {
    const k = val.toLowerCase();
    $("#rule-list-body tr").each(function() {
        $(this).toggle($(this).text().toLowerCase().includes(k));
    });
}

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
    $("#mouse-toast").text(msg).fadeIn().delay(2000).fadeOut();
}

// 鼠标位置跟踪 (用于 Toast 跟随)
$(document).mousemove(function(e){
    $("#mouse-toast").css({top: e.pageY + 15, left: e.pageX + 15});
});

// 启动
if(localStorage.getItem("auth_token")) {
    $("#login-overlay").hide();
    initApp();
}
