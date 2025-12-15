/**
 * _worker.js - Microsoft Graph API 完整版
 * 环境变量要求: DB, ADMIN_USERNAME, ADMIN_PASSWORD
 */
export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;
      
      // 1. CORS 跨域处理
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { 
            "Access-Control-Allow-Origin": "*", 
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", 
            "Access-Control-Allow-Headers": "*" 
          }
        });
      }

      // 2. 静态资源托管
      if (path.startsWith('/assets/') || path.startsWith('/admin/') || path === '/favicon.ico') {
        return env.ASSETS.fetch(request);
      }
      if (path === '/' || path === '/index.html') {
        return Response.redirect(url.origin + '/admin/index.html', 302);
      }

      // 3. 公开邮件查询 (短链接拦截)
      if (!path.startsWith('/api/') && path.length > 1) {
        return handlePublicQuery(path.substring(1), env);
      }

      // 4. 登录验证
      if (path === '/api/login') {
          const authHeader = request.headers.get("Authorization");
          if (checkAuth(authHeader, env)) return jsonResp({ success: true });
          return jsonResp({ error: "Unauthorized" }, 401);
      }
  
      // 5. 全局鉴权拦截
      const authHeader = request.headers.get("Authorization");
      if (!checkAuth(authHeader, env)) {
        return jsonResp({ error: "Unauthorized" }, 401);
      }
  
      // 6. API 路由分发
      if (path.startsWith('/api/accounts')) return handleAccounts(request, env);
      if (path.startsWith('/api/tasks')) return handleTasks(request, env);
      if (path.startsWith('/api/emails')) return handleEmails(request, env);
      if (path.startsWith('/api/rules')) return handleRules(request, env);
      
      return new Response("Backend Active", { headers: corsHeaders() });
    },
  
    // 定时任务 (Cron)
    async scheduled(event, env, ctx) {
      ctx.waitUntil(processScheduledTasks(env));
    }
};

// ================== 核心业务逻辑 ==================

async function getAccessToken(env, account) {
    // 提前 5 分钟刷新
    if (account.access_token && account.expires_at > Date.now() + 300000) {
        return account.access_token;
    }
    
    if (!account.refresh_token || !account.client_id || !account.client_secret) {
        throw new Error("缺少凭据");
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
    if (data.error) throw new Error(`Token刷新失败: ${data.error_description}`);

    const newExpires = Date.now() + (data.expires_in * 1000);
    const newRefresh = data.refresh_token || account.refresh_token;

    await env.XYTJ_OUTLOOK.prepare("UPDATE accounts SET access_token=?, refresh_token=?, expires_at=? WHERE id=?")
        .bind(data.access_token, newRefresh, newExpires, account.id).run();

    return data.access_token;
}

async function sendEmailMS(env, account, to, subject, content) {
    try {
        const token = await getAccessToken(env, account);
        const payload = {
            message: {
                subject: subject || "(无主题)",
                body: { contentType: "HTML", content: content || " " },
                toRecipients: [{ emailAddress: { address: to } }]
            }
        };
        const resp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) throw new Error(await resp.text());
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function syncEmailsMS(env, accountId, limit = 10) {
    const account = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE id=?").bind(accountId).first();
    if (!account) throw new Error("Account not found");

    const token = await getAccessToken(env, account);
    const url = `https://graph.microsoft.com/v1.0/me/messages?$top=${limit}&$select=subject,from,bodyPreview,receivedDateTime,body&$orderby=receivedDateTime DESC`;
    
    const resp = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
    const data = await resp.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    
    return (data.value || []).map(m => ({
        id: m.id,
        subject: m.subject,
        sender: `${m.from?.emailAddress?.name || ''} <${m.from?.emailAddress?.address || ''}>`,
        body: m.bodyPreview || '(No Preview)', 
        received_at: m.receivedDateTime
    }));
}

// ================== API 处理器 ==================

async function handleAccounts(req, env) {
    const url = new URL(req.url);
    const method = req.method;
    
    if (method === 'GET') {
        const { results } = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts ORDER BY id DESC").all();
        // 简单脱敏，前端编辑时需要用到所以不完全隐藏
        return jsonResp({ data: results });
    }
    if (method === 'POST') {
        const d = await req.json();
        await env.XYTJ_OUTLOOK.prepare("INSERT INTO accounts (name, email, client_id, client_secret, refresh_token) VALUES (?, ?, ?, ?, ?)").bind(d.name, d.email, d.client_id, d.client_secret, d.refresh_token).run();
        return jsonResp({ ok: true });
    }
    if (method === 'PUT') {
        const d = await req.json();
        await env.XYTJ_OUTLOOK.prepare("UPDATE accounts SET name=?, email=?, client_id=?, client_secret=?, refresh_token=? WHERE id=?").bind(d.name, d.email, d.client_id, d.client_secret, d.refresh_token, d.id).run();
        return jsonResp({ ok: true });
    }
    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        await env.XYTJ_OUTLOOK.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
        return jsonResp({ ok: true });
    }
}

async function handleTasks(req, env) {
    const method = req.method;
    if (method === 'GET') {
        const { results } = await env.XYTJ_OUTLOOK.prepare("SELECT t.*, a.name as account_name FROM send_tasks t LEFT JOIN accounts a ON t.account_id = a.id ORDER BY t.next_run_at ASC").all();
        return jsonResp({ data: results });
    }
    if (method === 'POST') {
        const d = await req.json();
        if (d.immediate) {
            const acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE id=?").bind(d.account_id).first();
            const res = await sendEmailMS(env, acc, d.to_email, d.subject, d.content);
            return jsonResp({ ok: res.success, error: res.error });
        }
        let nextRun = Date.now(); 
        await env.XYTJ_OUTLOOK.prepare("INSERT INTO send_tasks (account_id, to_email, subject, content, delay_config, is_loop, next_run_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')").bind(d.account_id, d.to_email, d.subject, d.content, d.delay_config, d.is_loop?1:0, nextRun).run();
        return jsonResp({ ok: true });
    }
    if (method === 'DELETE') {
        const id = new URL(req.url).searchParams.get('id');
        await env.XYTJ_OUTLOOK.prepare("DELETE FROM send_tasks WHERE id=?").bind(id).run();
        return jsonResp({ ok: true });
    }
}

async function handleEmails(req, env) {
    const url = new URL(req.url);
    const accountId = url.searchParams.get('account_id');
    const limit = url.searchParams.get('limit') || 10;
    try {
        const emails = await syncEmailsMS(env, accountId, parseInt(limit));
        return jsonResp(emails);
    } catch(e) { return jsonResp({ error: e.message }); }
}

async function handleRules(req, env) {
    const method = req.method;
    if (method === 'GET') {
        const { results } = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM access_rules ORDER BY id DESC").all();
        return jsonResp(results);
    }
    if (method === 'POST') {
        const d = await req.json();
        const code = d.query_code || Math.random().toString(36).substring(2, 12).toUpperCase();
        await env.XYTJ_OUTLOOK.prepare("INSERT INTO access_rules (name, alias, query_code, fetch_limit, valid_until, match_sender, match_body) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(d.name, d.alias, code, d.fetch_limit, d.valid_until, d.match_sender, d.match_body).run();
        return jsonResp({ success: true });
    }
    if (method === 'DELETE') {
        const ids = await req.json();
        for(const id of ids) await env.XYTJ_OUTLOOK.prepare("DELETE FROM access_rules WHERE id=?").bind(id).run();
        return jsonResp({ success: true });
    }
}

async function handlePublicQuery(code, env) {
    const rule = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM access_rules WHERE query_code=?").bind(code).first();
    if (!rule || (rule.valid_until && Date.now() > rule.valid_until)) return new Response("链接无效或已过期", {status: 404, headers: {"Content-Type": "text/plain;charset=UTF-8"}});
    
    const acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE name=?").bind(rule.name).first();
    if (!acc) return new Response("账号未找到", {status: 404, headers: {"Content-Type": "text/plain;charset=UTF-8"}});

    try {
        let emails = await syncEmailsMS(env, acc.id, 20);
        if (rule.match_sender) emails = emails.filter(e => e.sender.includes(rule.match_sender));
        if (rule.match_body) emails = emails.filter(e => e.body.includes(rule.match_body));
        
        const text = emails.slice(0, parseInt(rule.fetch_limit)||5).map(e => 
            `${new Date(e.received_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})} | ${e.subject} | ${e.body.replace(/\s+/g,' ').substring(0,200)}`
        ).join('\n\n');
        return new Response(text || "暂无邮件", { headers: {"Content-Type": "text/plain;charset=UTF-8"} });
    } catch(e) { return new Response("Error: " + e.message, {status: 500}); }
}

async function processScheduledTasks(env) {
    const now = Date.now();
    const { results } = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM send_tasks WHERE status != 'success' AND next_run_at <= ?").bind(now).all();
    for (const task of results) {
        try {
            const acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE id=?").bind(task.account_id).first();
            if (acc) {
                const res = await sendEmailMS(env, acc, task.to_email, task.subject, task.content);
                if (res.success) {
                    await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET status='success', success_count=success_count+1 WHERE id=?").bind(task.id).run();
                } else {
                    await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET status='error', fail_count=fail_count+1 WHERE id=?").bind(task.id).run();
                    continue; 
                }
            }
        } catch(e) { console.error(e); }

        if (task.is_loop) {
            let addMs = 86400000;
            if (task.delay_config && task.delay_config.includes('|')) {
                const p = task.delay_config.split('|').map(Number);
                addMs = (p[0]*86400000) + (p[1]*3600000) + (p[2]*60000) + (p[3]*1000);
            }
            if (addMs <= 0) addMs = 60000;
            await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET next_run_at=?, status='pending' WHERE id=?").bind(Date.now() + addMs, task.id).run();
        }
    }
}

function jsonResp(data, status=200) { return new Response(JSON.stringify(data), { status, headers: corsHeaders() }); }
function corsHeaders() { return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }; }
function checkAuth(header, env) {
    if (!header) return false;
    try {
        const [u, p] = atob(header.split(" ")[1]).split(":");
        return u === (env.ADMIN_USERNAME||"") && p === (env.ADMIN_PASSWORD||"");
    } catch(e) { return false; }
}
