const API_BASE = "/api";

const app = {
    // ================== 认证模块 ==================
    login: async () => {
        const u = document.getElementById('login-user').value;
        const p = document.getElementById('login-pass').value;
        if (!u || !p) return alert("请输入账号和密码");

        // 使用 Basic Auth 格式构建 Token
        const token = "Basic " + btoa(u + ":" + p);
        
        try {
            // 尝试请求登录接口验证
            const res = await fetch(`${API_BASE}/login`, { 
                method: 'POST',
                headers: { "Authorization": token } 
            });
            
            if (res.ok) {
                localStorage.setItem("auth_token", token);
                app.initUI();
            } else {
                alert("账号或密码错误");
            }
        } catch (e) { 
            alert("网络连接失败"); 
        }
    },

    logout: () => {
        if(confirm("确定退出登录吗？")) {
            localStorage.removeItem("auth_token");
            location.reload();
        }
    },

    checkAuth: () => {
        if (localStorage.getItem("auth_token")) {
            app.initUI();
        } else {
            document.getElementById('login-wrapper').style.display = 'flex';
            document.getElementById('app').style.display = 'none';
        }
    },

    initUI: () => {
        document.getElementById('login-wrapper').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        // 默认加载账号列表
        app.loadAccounts();
    },

    // ================== 导航模块 ==================
    nav: (id) => {
        // 隐藏所有视图
        document.querySelectorAll('.content-view').forEach(el => el.style.display = 'none');
        // 显示当前视图
        document.getElementById(`view-${id}`).style.display = 'block';
        
        // 更新侧边栏激活状态
        document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
        document.getElementById(`nav-${id}`).classList.add('active');
        
        // 根据模块加载数据
        if (id === 'accounts') app.loadAccounts();
        if (id === 'rules') app.loadRules();
        if (id === 'send') app.loadTasks(); // 加载任务的同时也会加载发件人列表
        if (id === 'inbox') app.loadInboxList();
    },

    // ================== 通用 API 封装 ==================
    api: async (url, method = "GET", body = null) => {
        const headers = { 
            "Authorization": localStorage.getItem("auth_token"),
            "Content-Type": "application/json"
        };
        const opts = { method, headers };
        if (body) opts.body = JSON.stringify(body);

        try {
            const res = await fetch(API_BASE + url, opts);
            if (res.status === 401) {
                localStorage.removeItem("auth_token");
                location.reload();
                return null;
            }
            return res.json();
        } catch (e) {
            console.error(e);
            return { error: "Network Error" };
        }
    },

    // ================== 1. 账号管理 (Microsoft) ==================
    loadAccounts: async () => {
        const res = await app.api("/accounts?limit=100");
        const list = res.data || [];
        window.allAccounts = list; // 缓存数据

        const tbody = document.getElementById('tbody-accounts');
        tbody.innerHTML = '';
        
        // 同时更新发信页面的下拉框
        const sendSelect = document.getElementById('send-from');
        sendSelect.innerHTML = '<option value="">请选择发件账号...</option>';

        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted p-4">暂无账号，请点击右上角添加</td></tr>';
            return;
        }

        list.forEach(acc => {
            // 状态徽章
            const tokenStatus = acc.refresh_token ? '<span class="badge bg-success">已配置</span>' : '<span class="badge bg-secondary">未配置</span>';
            const timeStr = new Date(acc.created_at * 1000).toLocaleString();

            // 表格行渲染
            tbody.innerHTML += `
                <tr>
                    <td>${acc.id}</td>
                    <td class="fw-bold">${escapeHtml(acc.name)}</td>
                    <td>${escapeHtml(acc.email || '-')}</td>
                    <td>${tokenStatus}</td>
                    <td class="small text-muted">${timeStr}</td>
                    <td>
                        <button class="btn btn-sm btn-outline-primary me-1" onclick="modal.editAccount(${acc.id})" title="编辑">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger" onclick="app.delAccount(${acc.id})" title="删除">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `;

            // 填充下拉框
            sendSelect.innerHTML += `<option value="${acc.id}">${escapeHtml(acc.name)} ${acc.email ? '('+acc.email+')' : ''}</option>`;
        });
    },

    saveAccount: async () => {
        const id = document.getElementById('acc-id').value;
        const name = document.getElementById('acc-name').value;
        if (!name) return alert("备注名称不能为空");

        const data = {
            id: id || undefined, // 有 ID 是修改，无 ID 是新增
            name: name,
            email: document.getElementById('acc-email').value,
            client_id: document.getElementById('acc-client-id').value,
            client_secret: document.getElementById('acc-client-secret').value,
            refresh_token: document.getElementById('acc-refresh-token').value
        };

        const method = id ? "PUT" : "POST";
        const res = await app.api("/accounts", method, data);
        
        if (res.ok) {
            bootstrap.Modal.getInstance(document.getElementById('modal-account')).hide();
            app.loadAccounts();
        } else {
            alert("保存失败: " + (res.error || "未知错误"));
        }
    },

    delAccount: async (id) => {
        if (!confirm("确定删除此账号吗？相关的任务也会失效。")) return;
        await app.api(`/accounts?id=${id}`, "DELETE");
        app.loadAccounts();
    },

    // ================== 2. 规则管理 (公开查信) ==================
    loadRules: async () => {
        const list = await app.api("/rules");
        const tbody = document.getElementById('tbody-rules');
        tbody.innerHTML = '';

        if (!list || list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted p-4">暂无规则</td></tr>';
            return;
        }

        const host = window.location.origin;

        list.forEach(r => {
            const link = `${host}/${r.query_code}`;
            let validStr = '<span class="badge bg-success">永久有效</span>';
            if (r.valid_until) {
                const isExpired = Date.now() > r.valid_until;
                validStr = isExpired ? '<span class="badge bg-danger">已过期</span>' : `<span class="badge bg-info">${new Date(r.valid_until).toLocaleDateString()}</span>`;
            }

            // 格式化过滤条件显示
            let filters = [];
            if (r.match_sender) filters.push(`发件人: ${r.match_sender}`);
            if (r.match_body) filters.push(`内容: ${r.match_body}`);
            const filterHtml = filters.length > 0 ? `<small class="text-muted">${filters.join('<br>')}</small>` : '<small class="text-muted">-</small>';

            tbody.innerHTML += `
                <tr>
                    <td>${escapeHtml(r.name)} <span class="text-muted small">(${escapeHtml(r.alias)})</span></td>
                    <td>
                        <div class="input-group input-group-sm" style="width: 150px;">
                            <input type="text" class="form-control bg-white" value="${r.query_code}" readonly>
                            <button class="btn btn-outline-secondary" onclick="window.open('${link}')"><i class="fas fa-external-link-alt"></i></button>
                        </div>
                    </td>
                    <td>${r.fetch_limit}</td>
                    <td>${validStr}</td>
                    <td>${filterHtml}</td>
                    <td>
                        <button class="btn btn-sm btn-outline-danger" onclick="app.delRule(${r.id})"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `;
        });
    },

    saveRule: async () => {
        const data = {
            name: document.getElementById('rule-name').value, // 这里的 name 是绑定的账号名
            alias: document.getElementById('rule-alias').value,
            query_code: document.getElementById('rule-code').value,
            fetch_limit: document.getElementById('rule-limit').value || "5",
            match_sender: document.getElementById('rule-match-sender').value,
            match_body: document.getElementById('rule-match-body').value
        };

        if (!data.name) return alert("请填写绑定的账号名称");

        const res = await app.api("/rules", "POST", data);
        if (res.success) {
            bootstrap.Modal.getInstance(document.getElementById('modal-rule')).hide();
            app.loadRules();
        } else {
            alert("保存失败: " + (res.error || "未知错误"));
        }
    },

    delRule: async (id) => {
        if (!confirm("删除此规则？外部将无法继续通过此链接查信。")) return;
        await app.api("/rules", "DELETE", [id]);
        app.loadRules();
    },

    // ================== 3. 任务管理 (发信) ==================
    loadTasks: async () => {
        // 先确保发件人列表是最新的
        if (!window.allAccounts) await app.loadAccounts();

        const res = await app.api("/tasks?limit=50");
        const tbody = document.getElementById('tbody-tasks');
        tbody.innerHTML = '';

        const list = res.data || [];
        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted p-4">暂无任务</td></tr>';
            return;
        }

        list.forEach(t => {
            const nextTime = new Date(t.next_run_at).toLocaleString();
            let statusBadge = '';
            if (t.status === 'success') statusBadge = '<span class="badge bg-success">成功</span>';
            else if (t.status === 'error') statusBadge = '<span class="badge bg-danger">失败</span>';
            else statusBadge = '<span class="badge bg-warning text-dark">等待中</span>';

            const loopBadge = t.is_loop ? '<span class="badge bg-info ms-1"><i class="fas fa-sync"></i> 循环</span>' : '';

            tbody.innerHTML += `
                <tr>
                    <td>${escapeHtml(t.account_name || 'ID:'+t.account_id)}</td>
                    <td><span class="d-inline-block text-truncate" style="max-width: 150px;">${escapeHtml(t.subject || '(无主题)')}</span></td>
                    <td class="small">${nextTime}</td>
                    <td>${statusBadge} ${loopBadge}</td>
                    <td>
                        <button class="btn btn-sm btn-outline-danger" onclick="app.delTask(${t.id})"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `;
        });
    },

    createTask: async () => {
        const accId = document.getElementById('send-from').value;
        if (!accId) return alert("请先选择发件账号");

        const data = {
            account_id: accId,
            to_email: document.getElementById('send-to').value,
            subject: document.getElementById('send-sub').value,
            content: document.getElementById('send-body').value,
            is_loop: document.getElementById('send-loop').checked,
            delay_config: document.getElementById('send-delay').value || "0"
        };

        if (!data.to_email) return alert("请填写收件人");

        const res = await app.api("/tasks", "POST", data);
        if (res.ok) {
            alert("任务已加入队列");
            app.loadTasks();
        } else {
            alert("添加失败: " + res.error);
        }
    },

    sendNow: async () => {
        const accId = document.getElementById('send-from').value;
        if (!accId) return alert("请先选择发件账号");
        
        const btn = event.target.closest('button'); // 兼容点击图标的情况
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 发送中...';

        const data = {
            account_id: accId,
            to_email: document.getElementById('send-to').value,
            subject: document.getElementById('send-sub').value,
            content: document.getElementById('send-body').value,
            immediate: true
        };

        const res = await app.api("/tasks", "POST", data);
        
        btn.disabled = false;
        btn.innerHTML = originalText;

        if (res.ok) alert("发送成功！");
        else alert("发送失败: " + (res.error || "未知错误"));
    },

    delTask: async (id) => {
        if (!confirm("删除此任务？")) return;
        await app.api(`/tasks?id=${id}`, "DELETE");
        app.loadTasks();
    },

    // ================== 4. 收件箱模块 ==================
    loadInboxList: async () => {
        // 复用账号列表接口
        const res = await app.api("/accounts?limit=100");
        const listEl = document.getElementById('inbox-list');
        listEl.innerHTML = '';

        const list = res.data || [];
        if (list.length === 0) {
            listEl.innerHTML = '<div class="text-center p-3 text-muted small">无可用账号</div>';
            return;
        }

        list.forEach(acc => {
            listEl.innerHTML += `
                <a href="#" class="list-group-item list-group-item-action" onclick="app.viewInbox(${acc.id}, '${escapeHtml(acc.name)}', this)">
                    <div class="d-flex w-100 justify-content-between align-items-center">
                        <h6 class="mb-0 text-truncate" style="max-width: 140px;">${escapeHtml(acc.name)}</h6>
                        <small class="text-muted"><i class="fas fa-chevron-right"></i></small>
                    </div>
                    <small class="text-muted">${escapeHtml(acc.email || '')}</small>
                </a>
            `;
        });
    },

    filterInbox: (keyword) => {
        const items = document.querySelectorAll('#inbox-list a');
        const key = keyword.toLowerCase();
        items.forEach(el => {
            const text = el.innerText.toLowerCase();
            el.style.display = text.includes(key) ? 'block' : 'none';
        });
    },

    viewInbox: async (accId, name, el) => {
        // 高亮选中项
        document.querySelectorAll('#inbox-list a').forEach(a => a.classList.remove('active'));
        if (el) el.classList.add('active');

        const contentEl = document.getElementById('inbox-content');
        contentEl.innerHTML = `
            <div class="d-flex flex-column align-items-center justify-content-center h-100">
                <div class="spinner-border text-primary mb-3"></div>
                <p class="text-muted">正在同步 ${escapeHtml(name)} 的邮件...</p>
                <small class="text-muted">连接微软 Graph API 可能需要几秒钟</small>
            </div>
        `;

        // 请求后端获取最新邮件 (默认 10 封)
        const res = await app.api(`/emails?account_id=${accId}&limit=10`);

        if (res.error) {
            contentEl.innerHTML = `
                <div class="d-flex flex-column align-items-center justify-content-center h-100 text-danger">
                    <i class="fas fa-exclamation-circle fa-3x mb-3"></i>
                    <h5>同步失败</h5>
                    <p>${res.error}</p>
                    <button class="btn btn-outline-secondary btn-sm mt-2" onclick="app.viewInbox(${accId}, '${name}', null)">重试</button>
                </div>
            `;
            return;
        }

        if (!res || res.length === 0) {
            contentEl.innerHTML = `
                <div class="d-flex flex-column align-items-center justify-content-center h-100 text-muted">
                    <i class="fas fa-inbox fa-3x mb-3"></i>
                    <p>收件箱为空</p>
                </div>
            `;
            return;
        }

        // 渲染邮件列表
        let html = `
            <div class="p-3 border-bottom bg-light d-flex justify-content-between align-items-center">
                <h5 class="mb-0 text-truncate"><i class="fas fa-envelope me-2"></i>${escapeHtml(name)}</h5>
                <button class="btn btn-sm btn-light border" onclick="app.viewInbox(${accId}, '${name}', null)"><i class="fas fa-sync"></i></button>
            </div>
            <div class="p-3" style="overflow-y: auto;">
        `;

        res.forEach(mail => {
            const timeStr = new Date(mail.received_at).toLocaleString();
            html += `
                <div class="card mb-3 shadow-sm border-0">
                    <div class="card-header bg-white d-flex justify-content-between align-items-start py-3">
                        <div>
                            <h6 class="mb-1 text-primary fw-bold">${escapeHtml(mail.subject || '(无主题)')}</h6>
                            <div class="small text-muted">From: ${escapeHtml(mail.sender)}</div>
                        </div>
                        <small class="text-muted text-nowrap ms-2">${timeStr}</small>
                    </div>
                    <div class="card-body bg-light bg-opacity-10">
                        <p class="card-text small text-secondary" style="white-space: pre-wrap;">${escapeHtml(mail.body)}</p>
                    </div>
                </div>
            `;
        });

        html += '</div>';
        contentEl.innerHTML = html;
        // 自动滚动到顶部
        contentEl.scrollTop = 0;
    }
};

// ================== 模态框辅助 ==================
const modal = {
    // 打开账号模态框 (新增模式)
    openAccount: () => {
        document.getElementById('acc-id').value = '';
        document.getElementById('acc-name').value = '';
        document.getElementById('acc-email').value = '';
        document.getElementById('acc-client-id').value = '';
        document.getElementById('acc-client-secret').value = '';
        document.getElementById('acc-refresh-token').value = '';
        new bootstrap.Modal(document.getElementById('modal-account')).show();
    },
    // 打开账号模态框 (编辑模式)
    editAccount: (id) => {
        const acc = window.allAccounts.find(a => a.id === id);
        if (!acc) return;
        
        document.getElementById('acc-id').value = acc.id;
        document.getElementById('acc-name').value = acc.name;
        document.getElementById('acc-email').value = acc.email || '';
        document.getElementById('acc-client-id').value = acc.client_id || '';
        document.getElementById('acc-client-secret').value = acc.client_secret || '';
        document.getElementById('acc-refresh-token').value = acc.refresh_token || '';
        
        new bootstrap.Modal(document.getElementById('modal-account')).show();
    },
    // 打开规则模态框
    openRule: () => {
        document.getElementById('rule-id').value = '';
        document.getElementById('rule-name').value = '';
        document.getElementById('rule-alias').value = '';
        document.getElementById('rule-code').value = '';
        document.getElementById('rule-limit').value = '5';
        document.getElementById('rule-match-sender').value = '';
        document.getElementById('rule-match-body').value = '';
        new bootstrap.Modal(document.getElementById('modal-rule')).show();
    }
};

// 辅助函数：HTML 转义防止 XSS
function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 页面加载完成后检查登录状态
document.addEventListener('DOMContentLoaded', app.checkAuth);
