const API_BASE = "/api";

// 全局缓存
let cachedAccounts = [];
let cachedRules = [];
let cachedTasks = [];
let cachedGroups = [];

// ================== 认证模块 ==================

function doLogin() {
    try {
        const u = $("#admin-user").val();
        const p = $("#admin-pass").val();
        if(!u || !p) return showToast("请输入账号密码");
        
        if (/[^\x00-\xff]/.test(u) || /[^\x00-\xff]/.test(p)) {
            return alert("错误：用户名或密码暂不支持中文，请在后台设置为纯英文/数字。");
        }
        
        const token = "Basic " + btoa(u + ":" + p);
        
        // 兼容性修复：使用 window.event 安全获取按钮
        const ev = window.event;
        const btn = ev ? $(ev.target) : $("#login-overlay button");
        const orgText = btn.length ? btn.text() : "登录";
        if(btn.length) btn.text("登录中...").prop("disabled", true);

        fetch(`${API_BASE}/login`, { method: 'POST', headers: { "Authorization": token } })
        .then(r => {
            if(btn.length) btn.text(orgText).prop("disabled", false);
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
            if(btn.length) btn.text(orgText).prop("disabled", false);
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
    
    const ev = window.event;
    if(ev && ev.currentTarget) {
        $(ev.currentTarget).addClass("active");
    }
    
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
        const list = res.data || [];
        cachedAccounts = list;
        const tbody = $("#account-list-body");
        tbody.empty();
        const dataList = $("#account-list-options");
        dataList.empty();

        if(list.length === 0) {
            tbody.html('<tr><td colspan="6" class="text-center p-4 text-muted">暂无账号</td></tr>');
            $("#acc-page-info").text("共 0 条记录");
            return;
        }

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
            dataList.append(`<option value="${escapeHtml(acc.name)}">${acc.email||''}</option>`);
        });
        $("#acc-page-info").text(`共 ${list.length} 条记录`);
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
    const config = [acc.client_id, acc.client_secret, acc.refresh_token].filter(x=>x).join(', ');
    $("#acc-api-config").val(config);
    new bootstrap.Modal(document.getElementById('addAccountModal')).show();
}

function saveAccount() {
    const rawConfig = $("#acc-api-config").val().trim();
    const parts = rawConfig.split(/[,，|]/).map(s => s.trim());
    const email = $("#acc-email").val().trim();
    const id = $("#acc-id").val();

    if(!id && cachedAccounts.some(a => a.email === email)) {
        return alert("保存失败：该邮箱地址已存在！");
    }

    const data = {
        id: id || undefined,
        name: $("#acc-name").val(),
        email: email,
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

        const existingEmails = cachedAccounts.map(a => a.email);
        const skipped = [];
        const toImport = json.filter(item => {
            if (existingEmails.includes(item.email)) {
                skipped.push(item.email);
                return false;
            }
            return true;
        });

        if (toImport.length === 0) {
            return alert("导入跳过：所有账号均已存在。\n已跳过项：" + skipped.join(', '));
        }
        
        fetch(`${API_BASE}/accounts`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(toImport) })
        .then(r => r.json()).then(res => {
            if(res.ok) {
                bootstrap.Modal.getInstance(document.getElementById('batchAccountImportModal')).hide();
                let msg = "导入成功";
                if(skipped.length > 0) msg += "\n注意：已跳过以下重复邮箱：\n" + skipped.join('\n');
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
        cachedRules = list;
        const tbody = $("#rule-list-body");
        tbody.empty();
        if(!list || list.length === 0) {
            tbody.html('<tr><td colspan="8" class="text-center p-4 text-muted">暂无规则</td></tr>');
            $("#rule-page-info").text("共 0 条记录");
            return;
        }

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
                    validStr = `${days}天 (${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()})`;
                }
            }
            
            let matchInfo = [];
            if(r.group_id) {
                const group = cachedGroups.find(g => g.id == r.group_id);
                matchInfo.push(`<span class="badge bg-primary text-white">组: ${escapeHtml(group ? group.name : r.group_id)}</span>`);
            } else {
                if(r.match_sender) matchInfo.push(`<span class="badge bg-light text-dark border">发: ${escapeHtml(r.match_sender)}</span>`);
                if(r.match_receiver) matchInfo.push(`<span class="badge bg-light text-dark border">收: ${escapeHtml(r.match_receiver)}</span>`);
                if(r.match_body) matchInfo.push(`<span class="badge bg-light text-dark border">文: ${escapeHtml(r.match_body)}</span>`);
            }
            
            tbody.append(`
                <tr data-email="${hiddenEmail}">
                    <td><input type="checkbox" class="rule-check" value="${r.id}"></td>
                    <td class="text-primary cursor-pointer" onclick="copyStr('${escapeHtml(r.name)}')">${escapeHtml(r.name)}</td>
                    <td class="text-primary cursor-pointer" onclick="copyStr('${escapeHtml(r.alias)}')">${escapeHtml(r.alias)}</td>
                    <td>
                        <div class="input-group input-group-sm" style="width:160px">
                            <input class="form-control bg-white" value="${r.query_code}" readonly>
                            <button class="btn btn-outline-secondary" onclick="window.open('${link}')"><i class="fas fa-external-link-alt"></i></button>
                            <button class="btn btn-outline-secondary" onclick="copyStr('${r.alias}---${link}')"><i class="fas fa-copy"></i></button>
                        </div>
                    </td>
                    <td class="small">${matchInfo.join('<br>') || '-'}</td>
                    <td>${r.fetch_limit}</td>
                    <td>${validStr}</td>
                    <td>
                        <button class="btn btn-sm btn-light text-primary" onclick="openEditRule(${r.id})"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm btn-light text-danger" onclick="delRule(${r.id})"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `);
        });
        $("#rule-page-info").text(`共 ${list.length} 条记录`);
    });
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
    let days = (r.valid_until && r.valid_until > Date.now()) ? Math.ceil((r.valid_until - Date.now()) / 86400000) : "";
    $("#rule-valid").val(days);
    $("#rule-group-select").val(r.group_id || "");
    $("#rule-match-sender").val(r.match_sender);
    $("#rule-match-receiver").val(r.match_receiver);
    $("#rule-match-body").val(r.match_body);
    toggleRuleMode();
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
    fetch(`${API_BASE}/rules`, { method: id ? 'PUT' : 'POST', headers: getHeaders(), body: JSON.stringify(data) })
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

// ================== 3. 发件任务 ==================

function loadTasks() {
    if(!cachedAccounts.length) loadAccounts();
    fetch(`${API_BASE}/tasks?limit=100`, { headers: getHeaders() }).then(r=>r.json()).then(res => {
        const list = res.data || [];
        cachedTasks = list;
        const tbody = $("#task-list-body");
        tbody.empty();
        if(list.length === 0) {
            tbody.html('<tr><td colspan="7" class="text-center p-4 text-muted">暂无任务</td></tr>');
            $("#task-page-info").text("共 0 条记录");
            return;
        }
        list.forEach(t => {
            const next = new Date(t.next_run_at).toLocaleString();
            const statusClass = t.status === 'success' ? 'text-success' : (t.status === 'error' ? 'text-danger' : 'text-warning');
            tbody.append(`
                <tr>
                    <td><input type="checkbox" class="task-check" value="${t.id}"></td>
                    <td>${escapeHtml(t.account_name || 'ID:'+t.account_id)}</td>
                    <td class="text-truncate" style="max-width:150px">${escapeHtml(t.subject||'-')}</td>
                    <td class="small">${next}</td>
                    <td><div class="form-check form-switch"><input class="form-check-input" type="checkbox" ${t.is_loop ? 'checked' : ''} onchange="toggleTaskLoop(${t.id}, this.checked)"></div></td>
                    <td class="${statusClass} fw-bold">${t.status} <small class="text-muted d-block">成:${t.success_count}/败:${t.fail_count}</small></td>
                    <td>
                        <button class="btn btn-sm btn-outline-primary" onclick="manualRun(${t.id})"><i class="fas fa-play"></i></button>
                        <button class="btn btn-sm btn-outline-danger" onclick="delTask(${t.id})"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `);
        });
        $("#task-page-info").text(`共 ${list.length} 条记录`);
    });
}

function manualRun(id) {
    if(!confirm("立即执行?")) return;
    fetch(`${API_BASE}/tasks`, { method: 'PUT', headers: getHeaders(), body: JSON.stringify({ id, action: 'execute' }) })
    .then(r => r.json()).then(res => {
        if(res.ok) { showToast("执行成功"); loadTasks(); }
        else showToast("失败: " + res.error);
    });
}

function sendNow() {
    const accId = getSelectedAccountId();
    if(!accId) return alert("账号不存在！");
    const ev = window.event;
    const btn = ev ? $(ev.target) : null;
    if(btn) btn.prop('disabled', true);
    
    const data = {
        account_id: accId,
        to_email: $("#send-to").val(),
        subject: $("#send-subject").val() || "Remind",
        content: $("#send-content").val() || ("Reminder: " + new Date().toISOString()),
        immediate: true
    };
    fetch(`${API_BASE}/tasks`, { method:'POST', headers: getHeaders(), body: JSON.stringify(data) })
    .then(r => r.json()).then(res => {
        if(btn) btn.prop('disabled', false);
        if(res.ok) alert("发送成功");
        else alert("失败: " + res.error);
    });
}

function delTask(id) {
    if(confirm("删除任务?")) fetch(`${API_BASE}/tasks?id=${id}`, { method:'DELETE', headers: getHeaders() }).then(()=>loadTasks());
}

function toggleTaskLoop(id, isLoop) {
    fetch(`${API_BASE}/tasks`, { method: 'PUT', headers: getHeaders(), body: JSON.stringify({ id, is_loop: isLoop }) })
    .then(r => r.json()).then(res => {
        if(res.ok) showToast("设置已更新");
        else loadTasks();
    });
}

// ================== 4. 收件箱 ==================

function loadInboxList() {
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
        if(acc.status == 0) return;
        el.append(`<a href="#" class="list-group-item list-group-item-action" onclick="viewInbox(${acc.id}, '${escapeHtml(acc.name)}', this)">
            <h6 class="mb-1 text-truncate">${escapeHtml(acc.name)}</h6>
            <small class="text-muted">${escapeHtml(acc.email||'')}</small>
        </a>`);
    });
}

function viewInbox(id, name, el) {
    $("#inbox-account-list a").removeClass("active");
    $(el).addClass("active");
    const box = $("#email-content-view");
    box.html('<div class="text-center mt-5"><div class="spinner-border text-primary"></div></div>');
    fetch(`${API_BASE}/emails?account_id=${id}&limit=5`, { headers: getHeaders() })
    .then(r => r.json()).then(res => {
        if(!res.length) return box.html('<p class="text-center mt-5">收件箱为空</p>');
        let html = `<div class="p-3"><h5>${escapeHtml(name)}</h5><hr>`;
        res.forEach(m => {
            html += `<div class="card mb-2 shadow-sm"><div class="card-body">
                <h6 class="text-primary">${escapeHtml(m.subject)}</h6>
                <small class="text-muted">${m.sender} | ${new Date(m.received_at).toLocaleString()}</small>
                <div class="mt-2 small text-secondary">${m.body}</div>
            </div></div>`;
        });
        box.html(html + '</div>');
    });
}

// ================== 策略组 ==================

function loadGroups() {
    fetch(`${API_BASE}/groups`, { headers: getHeaders() }).then(r => r.json()).then(res => {
        cachedGroups = res.data || [];
        renderGroupList();
        const sel = $("#rule-group-select").empty().append('<option value="">(自定义模式)</option>');
        cachedGroups.forEach(g => sel.append(`<option value="${g.id}">${escapeHtml(g.name)}</option>`));
    });
}

function renderGroupList() {
    const b = $("#group-list-body").empty();
    if(cachedGroups.length === 0) {
        b.html('<tr><td colspan="5" class="text-center p-4 text-muted">暂无策略组</td></tr>');
        $("#group-page-info").text("共 0 条记录");
        return;
    }
    cachedGroups.forEach(g => {
        b.append(`<tr><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.match_sender || '-')}</td><td>${escapeHtml(g.match_receiver || '-')}</td><td>${escapeHtml(g.match_body || '-')}</td>
            <td><button class="btn btn-sm btn-light text-danger" onclick="delGroup(${g.id})"><i class="fas fa-trash"></i></button></td></tr>`);
    });
    $("#group-page-info").text(`共 ${cachedGroups.length} 条记录`);
}

function toggleRuleMode() {
    const v = $("#rule-group-select").val();
    $("#custom-match-fields").toggleClass("d-none", !!v);
    $("#group-match-hint").toggleClass("d-none", !v);
}

function delGroup(id) {
    if(!confirm("确定删除策略组？")) return;
    fetch(`${API_BASE}/groups?id=${id}`, { method: 'DELETE', headers: getHeaders() }).then(() => loadGroups());
}

// ================== 通用工具 ==================

function clearSearch(inputId, filterFunc) {
    $(`#${inputId}`).val('');
    filterFunc('');
}

function filterAccounts(val) {
    const k = val.toLowerCase();
    $("#account-list-body tr").each(function() { $(this).toggle($(this).text().toLowerCase().includes(k)); });
}

function filterRules(val) {
    const k = val.toLowerCase();
    $("#rule-list-body tr").each(function() { $(this).toggle($(this).text().toLowerCase().includes(k)); });
}

function toggleAll(type) {
    const checked = $(`#check-all-${type}`).is(":checked");
    $(`.${type}-check`).prop("checked", checked);
}

function escapeHtml(text) {
    if(!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(>/g, "&gt;").replace(/"/g, "&quot;");
}

function showToast(msg) {
    $("#mouse-toast").text(msg).fadeIn().delay(300).fadeOut();
}

function copyStr(str) {
    navigator.clipboard.writeText(str).then(() => showToast("已复制"));
}

function copyAccountInfo(id, type) {
    const acc = cachedAccounts.find(a => a.id == id);
    if(!acc) return;
    let text = type === 'email' ? acc.email : `${acc.client_id}, ${acc.client_secret}, ${acc.refresh_token}`;
    copyStr(text);
}

function downloadFile(content, filename) {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
}

// 启动检测
if(localStorage.getItem("auth_token")) {
    $("#login-overlay").hide();
    initApp();
}
