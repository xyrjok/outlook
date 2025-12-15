/**
 * _worker.js (Microsoft Edition)
 * 功能：微软邮件管理、定时发送、公开查询
 * 环境变量: DB, ADMIN_USERNAME, ADMIN_PASSWORD
 */
export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;
      
      // 1. CORS & 静态资源
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "*" }
        });
      }
      if (path.startsWith('/assets/') || path.startsWith('/admin/')) {
        return env.ASSETS.fetch(request);
      }
      if (path === '/' || path === '/index.html') {
        return Response.redirect(url.origin + '/admin/index.html', 302);
      }

      // 2. 公开邮件查询 (短链接拦截)
      // 例如访问: https://domain.com/CODE123
      if (!path.startsWith('/api/') && !path.startsWith('/admin') && path.length > 1) {
        return handlePublicQuery(path.substring(1), env);
      }

      // 3. 登录接口
      if (path === '/api/login') {
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
      }
  
      // 4. 身份验证 (Basic Auth)
      const authHeader = request.headers.get("Authorization");
      if (!checkAuth(authHeader, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
  
      // 5. API 路由
      if (path.startsWith('/api/accounts')) return handleAccounts(request, env);
      if (path.startsWith('/api/tasks')) return handleTasks(request, env);
      if (path.startsWith('/api/emails')) return handleEmails(request, env); // 收信
      if (path.startsWith('/api/rules')) return handleRules(request, env);   // 规则
      
      return new Response("MS Backend Active", { headers: corsHeaders() });
    },
  
    // 定时任务 (Cron Triggers)
    async scheduled(event, env, ctx) {
      ctx.waitUntil(processScheduledTasks(env));
    }
};

// ================== 核心业务逻辑 ==================

// 1. 获取微软 Token (自动刷新)
async function getAccessToken(env, account) {
    // 如果现有 token 未过期 (预留 5 分钟缓冲)，直接使用
    if (account.access_token && account.expires_at > Date.now() + 300000) {
        return account.access_token;
    }
    
    // 否则刷新
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
    if (data.error) throw new Error(`Token刷新失败: ${data.error_description}`);

    // 更新数据库
    const newExpires = Date.now() + data.expires_in * 1000;
    // 注意：微软有时会返回新的 refresh_token，如果有则更新，没有则保持原样
    const newRefresh = data.refresh_token || account.refresh_token;

    await env.DB.prepare("UPDATE accounts SET access_token=?, refresh_token=?, expires_at=? WHERE id=?")
        .bind(data.access_token, newRefresh, newExpires, account.id).run();

    return data.access_token;
}

// 2. 发送邮件 (Microsoft Graph)
async function sendEmailMS(env, account, to, subject, content) {
    try {
        const token = await getAccessToken(env, account);
        
        const payload = {
            message: {
                subject: subject || "No Subject",
                body: {
                    contentType: "HTML",
                    content: content || " "
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
            const err = await resp.text();
            throw new Error(`Graph API Error: ${err}`);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 3. 收取邮件 (Microsoft Graph)
async function syncEmailsMS(env, accountId, limit = 5) {
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(accountId).first();
    if (!account) throw new Error("Account not found");

    const token = await getAccessToken(env, account);
    
    // $top=数量, $select=字段, $orderby=时间倒序
    const url = `https://graph.microsoft.com/v1.0/me/messages?$top=${limit}&$select=subject,from,bodyPreview,receivedDateTime,body&$orderby=receivedDateTime DESC`;
    
    const resp = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
    const data = await resp.json();
    
    if (data.error) throw new Error(JSON.stringify(data.error));
    
    return (data.value || []).map(m => ({
        id: m.id,
        subject: m.subject,
        sender: `${m.from?.emailAddress?.name || ''} <${m.from?.emailAddress?.address || ''}>`,
        body: m.bodyPreview || '(No Preview)', // 微软的 bodyPreview 是纯文本摘要
        received_at: m.receivedDateTime
    }));
}

// ================== API 处理器 ==================

async function handleAccounts(req, env) {
    const url = new URL(req.url);
    
    if (req.method === 'GET') {
        // 列表
        const { results } = await env.DB.prepare("SELECT * FROM accounts ORDER BY id DESC").all();
        return jsonResp({ data: results });
    }
    
    if (req.method === 'POST') {
        // 新增 (支持批量导入)
        const data = await req.json();
        const items = Array.isArray(data) ? data : [data];
        
        for (const item of items) {
            // 这里假设前端传来了 client_id 等信息
            // 实际上为了安全，建议前端先只传 id/secret，后端去换一次 token 验证有效性再存
            // 简单起见，这里直接存
            await env.DB.prepare(
                "INSERT INTO accounts (name, email, client_id, client_secret, refresh_token) VALUES (?, ?, ?, ?, ?)"
            ).bind(item.name, item.email||'', item.client_id, item.client_secret, item.refresh_token).run();
        }
        return jsonResp({ ok: true });
    }
    
    if (req.method === 'PUT') {
        const d = await req.json();
        await env.DB.prepare(
            "UPDATE accounts SET name=?, email=?, client_id=?, client_secret=?, refresh_token=? WHERE id=?"
        ).bind(d.name, d.email, d.client_id, d.client_secret, d.refresh_token, d.id).run();
        return jsonResp({ ok: true });
    }

    if (req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        await env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
        return jsonResp({ ok: true });
    }
}

async function handleTasks(req, env) {
    const method = req.method;
    
    if (method === 'GET') {
        const { results } = await env.DB.prepare(`
            SELECT t.*, a.name as account_name 
            FROM send_tasks t LEFT JOIN accounts a ON t.account_id = a.id 
            ORDER BY t.next_run_at ASC`
        ).all();
        return jsonResp({ data: results });
    }

    if (method === 'POST') {
        const d = await req.json();
        
        if (d.immediate) {
            // 立即发送
            const acc = await env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(d.account_id).first();
            const res = await sendEmailMS(env, acc, d.to_email, d.subject, d.content);
            return jsonResp({ ok: res.success, error: res.error });
        }
        
        // 添加任务
        let nextRun = d.base_date ? new Date(d.base_date).getTime() : Date.now();
        await env.DB.prepare(
            "INSERT INTO send_tasks (account_id, to_email, subject, content, delay_config, is_loop, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(d.account_id, d.to_email, d.subject, d.content, d.delay_config, d.is_loop?1:0, nextRun).run();
        
        return jsonResp({ ok: true });
    }

    if (method === 'DELETE') {
        const id = new URL(req.url).searchParams.get('id');
        await env.DB.prepare("DELETE FROM send_tasks WHERE id=?").bind(id).run();
        return jsonResp({ ok: true });
    }
}

async function handleEmails(req, env) {
    const id = new URL(req.url).searchParams.get('account_id');
    const limit = new URL(req.url).searchParams.get('limit') || 5;
    try {
        const emails = await syncEmailsMS(env, id, limit);
        return jsonResp(emails);
    } catch(e) {
        return jsonResp({ error: e.message });
    }
}

async function handleRules(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET') {
        const { results } = await env.DB.prepare("SELECT * FROM access_rules ORDER BY id DESC").all();
        return jsonResp(results);
    }
    if (req.method === 'POST') {
        const d = await req.json();
        // 如果没有query_code则生成
        const code = d.query_code || Math.random().toString(36).substring(2, 12).toUpperCase();
        await env.DB.prepare(
            "INSERT INTO access_rules (name, alias, query_code, fetch_limit, valid_until, match_sender, match_body) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(d.name, d.alias, code, d.fetch_limit, d.valid_until, d.match_sender, d.match_body).run();
        return jsonResp({ success: true });
    }
    if (req.method === 'DELETE') {
        const ids = await req.json(); // 数组
        // 简单实现：循环删
        for(const id of ids) await env.DB.prepare("DELETE FROM access_rules WHERE id=?").bind(id).run();
        return jsonResp({ success: true });
    }
}

// 公开查询处理
async function handlePublicQuery(code, env) {
    const rule = await env.DB.prepare("SELECT * FROM access_rules WHERE query_code=?").bind(code).first();
    if (!rule) return new Response("链接无效", {status:404});

    if (rule.valid_until && Date.now() > rule.valid_until) return new Response("链接已过期", {status:403});

    // 查找对应账号 (按 Rule 的 name 匹配 Account 的 name)
    const acc = await env.DB.prepare("SELECT * FROM accounts WHERE name=?").bind(rule.name).first();
    if (!acc) return new Response("未找到对应账号", {status:404});

    try {
        // 获取邮件
        let emails = await syncEmailsMS(env, acc.id, 20); // 多抓一点用于过滤
        
        // 过滤
        if (rule.match_sender) {
            emails = emails.filter(e => e.sender.toLowerCase().includes(rule.match_sender.toLowerCase()));
        }
        if (rule.match_body) {
            emails = emails.filter(e => e.body.toLowerCase().includes(rule.match_body.toLowerCase()));
        }
        
        // 截取显示数量
        const limit = parseInt(rule.fetch_limit) || 5;
        emails = emails.slice(0, limit);

        // 输出纯文本
        const text = emails.map(e => 
            `${new Date(e.received_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})} | ${e.subject} | ${e.body}`
        ).join('\n\n');

        return new Response(text || "暂无邮件", { headers: {"Content-Type": "text/plain;charset=UTF-8"} });

    } catch(e) {
        return new Response("查询失败: " + e.message, {status:500});
    }
}

// 任务循环处理
async function processScheduledTasks(env) {
    const now = Date.now();
    const { results } = await env.DB.prepare("SELECT * FROM send_tasks WHERE next_run_at <= ?").bind(now).all();

    for (const task of results) {
        try {
            const acc = await env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(task.account_id).first();
            if (acc) {
                await sendEmailMS(env, acc, task.to_email, task.subject, task.content);
                // 成功
                await env.DB.prepare("UPDATE send_tasks SET success_count=success_count+1 WHERE id=?").bind(task.id).run();
            }
        } catch(e) {
            console.error(e);
        }

        if (task.is_loop) {
            // 计算下次时间 (简单起见，默认加1天，或者解析 delay_config)
            // 这里简化：如果没有 delay_config，默认 24小时
            const delay = 86400000; 
            const next = Date.now() + delay; 
            await env.DB.prepare("UPDATE send_tasks SET next_run_at=? WHERE id=?").bind(next, task.id).run();
        } else {
            // 非循环，删除或标记完成
            await env.DB.prepare("DELETE FROM send_tasks WHERE id=?").bind(task.id).run();
        }
    }
}

// 辅助
const corsHeaders = () => ({ "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
function jsonResp(data) { return new Response(JSON.stringify(data), { headers: corsHeaders() }); }
function checkAuth(header, env) {
    if (!header) return false;
    const [u, p] = atob(header.split(" ")[1]).split(":");
    return u === (env.ADMIN_USERNAME||"admin") && p === (env.ADMIN_PASSWORD||"123456");
}
