/**
 * _worker.js (Microsoft Graph API Edition)
 * 功能：微软邮件管理、定时发送、循环保活、公开查询
 * 环境变量: DB, ADMIN_USERNAME, ADMIN_PASSWORD
 */
export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;
      
      // 1. CORS 跨域处理 & OPTIONS 预检
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { 
            "Access-Control-Allow-Origin": "*", 
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", 
            "Access-Control-Allow-Headers": "*" 
          }
        });
      }

      // 2. 静态资源托管 (兼容 admin/ 目录结构)
      // 如果请求的是文件或 admin 目录，交给 Assets 处理
      if (path.startsWith('/assets/') || path.startsWith('/admin/') || path === '/favicon.ico') {
        return env.ASSETS.fetch(request);
      }
      // 根路径重定向到后台
      if (path === '/' || path === '/index.html') {
        return Response.redirect(url.origin + '/admin/index.html', 302);
      }

      // 3. 公开邮件查询接口 (拦截短链接，例如 /CODE123)
      // 排除 /api/ 开头的路径
      if (!path.startsWith('/api/') && path.length > 1) {
        return handlePublicQuery(path.substring(1), env);
      }

      // 4. 登录验证接口 (返回 200 即成功，鉴权在 checkAuth)
      if (path === '/api/login') {
          // 简单的鉴权逻辑在下方统一处理，这里只需通过即可
          const authHeader = request.headers.get("Authorization");
          if (checkAuth(authHeader, env)) {
             return jsonResp({ success: true });
          }
          return jsonResp({ error: "Unauthorized" }, 401);
      }
  
      // 5. 全局身份验证 (Basic Auth)
      // 除上述公开接口外，所有 /api/ 接口都需要鉴权
      const authHeader = request.headers.get("Authorization");
      if (!checkAuth(authHeader, env)) {
        return jsonResp({ error: "Unauthorized" }, 401);
      }
  
      // 6. API 路由分发
      if (path.startsWith('/api/accounts')) return handleAccounts(request, env);
      if (path.startsWith('/api/tasks')) return handleTasks(request, env);
      if (path.startsWith('/api/emails')) return handleEmails(request, env);
      if (path.startsWith('/api/rules')) return handleRules(request, env);
      
      return new Response("MS Backend Active", { headers: corsHeaders() });
    },
  
    // 定时任务触发器 (用于处理发信队列和循环保活)
    async scheduled(event, env, ctx) {
      ctx.waitUntil(processScheduledTasks(env));
    }
};

// ============================================================
// 核心业务逻辑 (Microsoft Graph API)
// ============================================================

// 1. 获取 Access Token (含自动刷新逻辑)
async function getAccessToken(env, account) {
    // 检查现有 Token 是否有效 (预留 5 分钟缓冲期)
    // 注意：数据库里存的是 expires_at (毫秒时间戳)
    if (account.access_token && account.expires_at && account.expires_at > Date.now() + 300000) {
        return account.access_token;
    }
    
    // Token 过期或不存在，执行刷新流程
    console.log(`Refreshing token for account: ${account.name}`);
    
    if (!account.refresh_token || !account.client_id || !account.client_secret) {
        throw new Error("缺少刷新凭据 (Client ID/Secret/Refresh Token)");
    }

    const params = new URLSearchParams({
        client_id: account.client_id,
        client_secret: account.client_secret,
        refresh_token: account.refresh_token,
        grant_type: "refresh_token"
    });

    const resp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
    });
    
    const data = await resp.json();
    if (data.error) {
        throw new Error(`Token刷新失败: ${data.error_description || JSON.stringify(data)}`);
    }

    // 计算新的过期时间
    const newExpires = Date.now() + (data.expires_in * 1000);
    
    // 微软有时会返回新的 refresh_token (Rolling Refresh)，务必更新
    // 如果没返回新的，就继续用旧的
    const newRefreshToken = data.refresh_token || account.refresh_token;

    // 更新数据库
    await env.XYTJ_OUTLOOK.prepare(
        "UPDATE accounts SET access_token=?, refresh_token=?, expires_at=? WHERE id=?"
    ).bind(data.access_token, newRefreshToken, newExpires, account.id).run();

    return data.access_token;
}

// 2. 发送邮件
async function sendEmailMS(env, account, to, subject, content) {
    try {
        const token = await getAccessToken(env, account);
        
        const payload = {
            message: {
                subject: subject || "(无主题)",
                body: {
                    contentType: "HTML",
                    content: content || " " // 内容不能为空
                },
                toRecipients: [
                    { emailAddress: { address: to } }
                ]
            }
        };

        const resp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Graph API Error: ${resp.status} - ${errText}`);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 3. 获取邮件列表
async function syncEmailsMS(env, accountId, limit = 10) {
    const account = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE id=?").bind(accountId).first();
    if (!account) throw new Error("Account not found");

    const token = await getAccessToken(env, account);
    
    // 查询参数: $top=限制数量, $select=只取需要的字段, $orderby=时间倒序
    const url = `https://graph.microsoft.com/v1.0/me/messages?$top=${limit}&$select=subject,from,bodyPreview,receivedDateTime,body&$orderby=receivedDateTime DESC`;
    
    const resp = await fetch(url, { 
        headers: { "Authorization": `Bearer ${token}` } 
    });
    
    const data = await resp.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    
    // 格式化返回数据
    return (data.value || []).map(m => ({
        id: m.id,
        subject: m.subject,
        // 微软格式: from: { emailAddress: { name, address } }
        sender: `${m.from?.emailAddress?.name || ''} <${m.from?.emailAddress?.address || ''}>`,
        // bodyPreview 是纯文本预览，body.content 是 HTML
        body: m.bodyPreview || '(No Preview)', 
        received_at: m.receivedDateTime
    }));
}

// ============================================================
// API 路由处理器
// ============================================================

// 1. 账号管理
async function handleAccounts(req, env) {
    const url = new URL(req.url);
    const method = req.method;
    
    if (method === 'GET') {
        const { results } = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts ORDER BY id DESC").all();
        // 隐藏敏感信息输出（可选）
        const safeResults = results.map(acc => ({
            ...acc,
            client_secret: acc.client_secret ? '******' : null
        }));
        return jsonResp({ data: results }); // 前端编辑需要回显，暂不脱敏，或根据需求调整
    }
    
    if (method === 'POST') {
        const d = await req.json();
        // 支持单个或批量
        const items = Array.isArray(d) ? d : [d];
        for (const item of items) {
            await env.XYTJ_OUTLOOK.prepare(
                "INSERT INTO accounts (name, email, client_id, client_secret, refresh_token, status) VALUES (?, ?, ?, ?, ?, 1)"
            ).bind(item.name, item.email||'', item.client_id, item.client_secret, item.refresh_token).run();
        }
        return jsonResp({ ok: true });
    }
    
    if (method === 'PUT') {
        const d = await req.json();
        await env.XYTJ_OUTLOOK.prepare(
            "UPDATE accounts SET name=?, email=?, client_id=?, client_secret=?, refresh_token=? WHERE id=?"
        ).bind(d.name, d.email, d.client_id, d.client_secret, d.refresh_token, d.id).run();
        return jsonResp({ ok: true });
    }

    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        await env.XYTJ_OUTLOOK.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
        // 同时删除关联的任务？根据需求
        await env.XYTJ_OUTLOOK.prepare("DELETE FROM send_tasks WHERE account_id=?").bind(id).run();
        return jsonResp({ ok: true });
    }
}

// 2. 任务管理
async function handleTasks(req, env) {
    const url = new URL(req.url);
    const method = req.method;
    
    if (method === 'GET') {
        // 关联查询获取账号名称
        const { results } = await env.XYTJ_OUTLOOK.prepare(`
            SELECT t.*, a.name as account_name 
            FROM send_tasks t 
            LEFT JOIN accounts a ON t.account_id = a.id 
            ORDER BY t.next_run_at ASC`
        ).all();
        return jsonResp({ data: results });
    }

    if (method === 'POST') {
        const d = await req.json();
        
        // 立即发送模式
        if (d.immediate) {
            const acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE id=?").bind(d.account_id).first();
            if (!acc) return jsonResp({ ok: false, error: "账号不存在" });
            const res = await sendEmailMS(env, acc, d.to_email, d.subject, d.content);
            return jsonResp({ ok: res.success, error: res.error });
        }
        
        // 添加到队列
        let nextRun = Date.now();
        // 如果有起始时间且大于当前时间
        /* 这里简化处理：前端传递的是 delay_config (如 1|0|0|0)
           如果有 delay_config，计算下次运行时间。
           如果没有 base_date，默认立即开始（nextRun = now）
        */
        
        await env.XYTJ_OUTLOOK.prepare(
            "INSERT INTO send_tasks (account_id, to_email, subject, content, delay_config, is_loop, next_run_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')"
        ).bind(d.account_id, d.to_email, d.subject, d.content, d.delay_config, d.is_loop?1:0, nextRun).run();
        
        return jsonResp({ ok: true });
    }

    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        await env.XYTJ_OUTLOOK.prepare("DELETE FROM send_tasks WHERE id=?").bind(id).run();
        return jsonResp({ ok: true });
    }
}

// 3. 邮件获取
async function handleEmails(req, env) {
    const url = new URL(req.url);
    const accountId = url.searchParams.get('account_id');
    const limit = url.searchParams.get('limit') || 10;

    if (!accountId) return jsonResp({ error: "Missing account_id" });

    try {
        const emails = await syncEmailsMS(env, accountId, parseInt(limit));
        return jsonResp(emails);
    } catch(e) {
        return jsonResp({ error: e.message });
    }
}

// 4. 规则管理
async function handleRules(req, env) {
    const url = new URL(req.url);
    const method = req.method;

    if (method === 'GET') {
        const { results } = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM access_rules ORDER BY id DESC").all();
        return jsonResp(results);
    }
    if (method === 'POST') {
        const d = await req.json();
        // 如果没有query_code则生成随机码
        const code = d.query_code || Math.random().toString(36).substring(2, 12).toUpperCase();
        
        // 插入数据库
        await env.XYTJ_OUTLOOK.prepare(
            "INSERT INTO access_rules (name, alias, query_code, fetch_limit, valid_until, match_sender, match_body) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(d.name, d.alias, code, d.fetch_limit, d.valid_until, d.match_sender, d.match_body).run();
        return jsonResp({ success: true });
    }
    if (method === 'DELETE') {
        const ids = await req.json();
        if (Array.isArray(ids)) {
            for(const id of ids) await env.XYTJ_OUTLOOK.prepare("DELETE FROM access_rules WHERE id=?").bind(id).run();
        }
        return jsonResp({ success: true });
    }
}

// ============================================================
// 其他处理函数
// ============================================================

// 公开查询接口逻辑
async function handlePublicQuery(code, env) {
    // 1. 查规则
    const rule = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM access_rules WHERE query_code=?").bind(code).first();
    if (!rule) return new Response("查询链接无效 (Link Invalid)", {status: 404, headers: {"Content-Type": "text/plain;charset=UTF-8"}});

    // 2. 查有效期
    if (rule.valid_until && Date.now() > rule.valid_until) {
        return new Response("链接已过期 (Link Expired)", {status: 403, headers: {"Content-Type": "text/plain;charset=UTF-8"}});
    }

    // 3. 查对应账号 (通过 name 匹配)
    const acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE name=?").bind(rule.name).first();
    if (!acc) return new Response("未找到对应的账号配置 (Account Not Found)", {status: 404, headers: {"Content-Type": "text/plain;charset=UTF-8"}});

    try {
        // 4. 抓取邮件 (抓取 20 条用于过滤)
        let emails = await syncEmailsMS(env, acc.id, 20);
        
        // 5. 过滤
        if (rule.match_sender) {
            emails = emails.filter(e => e.sender.toLowerCase().includes(rule.match_sender.toLowerCase()));
        }
        if (rule.match_body) {
            emails = emails.filter(e => e.body.toLowerCase().includes(rule.match_body.toLowerCase()));
        }
        
        // 6. 截取显示数量
        const limit = parseInt(rule.fetch_limit) || 5;
        emails = emails.slice(0, limit);

        // 7. 格式化输出
        if (emails.length === 0) return new Response("暂无符合条件的邮件", {headers: {"Content-Type": "text/plain;charset=UTF-8"}});

        const text = emails.map(e => {
            const timeStr = new Date(e.received_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
            // 简单处理 body 中的换行
            const cleanBody = e.body.replace(/\s+/g, ' ').substring(0, 200); 
            return `${timeStr} | ${e.subject} | ${cleanBody}`;
        }).join('\n\n');

        return new Response(text, { headers: {"Content-Type": "text/plain;charset=UTF-8"} });

    } catch(e) {
        return new Response("查询出错: " + e.message, {status: 500, headers: {"Content-Type": "text/plain;charset=UTF-8"}});
    }
}

// 计划任务处理 (Cron)
async function processScheduledTasks(env) {
    const now = Date.now();
    // 查出所有待执行且时间已到的任务
    const { results } = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM send_tasks WHERE status != 'success' AND next_run_at <= ?").bind(now).all();

    for (const task of results) {
        // 跳过标记为 error 且重试次数过多的? (暂不处理，简单重试)
        
        try {
            const acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE id=?").bind(task.account_id).first();
            if (acc) {
                const res = await sendEmailMS(env, acc, task.to_email, task.subject, task.content);
                if (res.success) {
                    await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET status='success', success_count=success_count+1 WHERE id=?").bind(task.id).run();
                } else {
                    await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET status='error', fail_count=fail_count+1 WHERE id=?").bind(task.id).run();
                    console.error(`Task ${task.id} failed: ${res.error}`);
                    continue; // 失败了就不进循环计算了，或者根据需求重试
                }
            }
        } catch(e) {
            console.error(`Task ${task.id} error: ${e.message}`);
            await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET status='error', fail_count=fail_count+1 WHERE id=?").bind(task.id).run();
            continue;
        }

        // 处理循环逻辑
        if (task.is_loop) {
            // 解析 delay_config (格式: 天|时|分|秒，例如 1|0|0|0)
            let addMs = 86400000; // 默认 1 天
            if (task.delay_config && task.delay_config.includes('|')) {
                const parts = task.delay_config.split('|').map(Number);
                addMs = (parts[0]*86400000) + (parts[1]*3600000) + (parts[2]*60000) + (parts[3]*1000);
            }
            if (addMs <= 0) addMs = 60000; // 防止死循环

            const nextRun = Date.now() + addMs;
            // 重置状态为 pending 以便下次执行
            await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET next_run_at=?, status='pending' WHERE id=?").bind(nextRun, task.id).run();
        } else {
            // 非循环任务，执行完可以删除，或者保留为 success 状态
            // await env.XYTJ_OUTLOOK.prepare("DELETE FROM send_tasks WHERE id=?").bind(task.id).run();
        }
    }
}

// 辅助函数
function jsonResp(data, status=200) {
    return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function corsHeaders() {
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
    };
}

function checkAuth(header, env) {
    if (!header) return false;
    try {
        const base64 = header.split(" ")[1];
        if (!base64) return false;
        const [u, p] = atob(base64).split(":");
        const validUser = env.ADMIN_USERNAME || "";
        const validPass = env.ADMIN_PASSWORD || "";
        return u === validUser && p === validPass;
    } catch(e) { return false; }
}
