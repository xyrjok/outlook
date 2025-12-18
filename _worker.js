/**
 * _worker.js (Microsoft Graph API Edition)
 * 基于 Cloudflare Pages + D1
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

      // 2. 静态资源托管
      // 访问 /admin/ 或 /assets/ 或 .文件 时，走静态资源
      if (path.startsWith('/assets/') || path.startsWith('/admin/') || path.includes('.')) {
        return env.ASSETS.fetch(request);
      }
      // 根路径重定向到后台首页
      if (path === '/' || path === '/index.html') {
        return Response.redirect(url.origin + '/admin/index.html', 302);
      }

      // 3. 公开邮件查询接口 (拦截短链接，例如 /CODE123)
      // 排除 /api/ 开头和系统路径
      if (!path.startsWith('/api/') && !path.startsWith('/admin') && path.length > 1) {
        return handlePublicQuery(path.substring(1), env);
      }

      // 4. 登录验证接口
      if (path === '/api/login') {
          const authHeader = request.headers.get("Authorization");
          if (checkAuth(authHeader, env)) {
             return jsonResp({ success: true });
          }
          return jsonResp({ error: "Unauthorized" }, 401);
      }
  
      // 5. 全局身份验证 (Basic Auth)
      // 所有 /api/ 接口都需要鉴权
      const authHeader = request.headers.get("Authorization");
      if (!checkAuth(authHeader, env)) {
        return jsonResp({ error: "Unauthorized" }, 401);
      }
  
      // 6. API 路由分发
      if (path.startsWith('/api/groups')) return handleGroups(request, env); // <--- [新增] 策略组路由
      if (path.startsWith('/api/accounts')) return handleAccounts(request, env);
      if (path.startsWith('/api/tasks')) return handleTasks(request, env);
      if (path.startsWith('/api/emails')) return handleEmails(request, env);
      if (path.startsWith('/api/rules')) return handleRules(request, env);
      
      return new Response("MS Backend Active", { headers: corsHeaders() });
    },
};

// ============================================================
// 核心业务逻辑 (Microsoft Graph API)
// ============================================================

// 1. 获取 Access Token (含自动刷新逻辑)
async function getAccessToken(env, account) {
    // 检查现有 Token 是否有效 (预留 5 分钟缓冲期)
    // 数据库存的是 expires_at (毫秒时间戳)
    if (account.access_token && account.expires_at && account.expires_at > Date.now() + 300000) {
        return account.access_token;
    }
    
    // Token 过期或不存在，执行刷新
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
    // 修改：增加 toRecipients 以便支持收件人匹配
    const urlInbox = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${limit}&$select=subject,from,toRecipients,bodyPreview,receivedDateTime,body&$orderby=receivedDateTime DESC`;
    const urlJunk = `https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages?$top=${limit}&$select=subject,from,toRecipients,bodyPreview,receivedDateTime,body&$orderby=receivedDateTime DESC`;

    const [r1, r2] = await Promise.all([
        fetch(urlInbox, { headers: { "Authorization": `Bearer ${token}` } }),
        fetch(urlJunk, { headers: { "Authorization": `Bearer ${token}` } })
    ]);

    const d1 = await r1.json();
    const d2 = await r2.json();
    if (d1.error || d2.error) throw new Error(JSON.stringify(d1.error || d2.error));

    // 合并并按时间倒序
    let list = [...(d1.value || []), ...(d2.value || [])];
    list.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));

    // 格式化返回数据
    return list.slice(0, limit).map(m => ({
        id: m.id,
        subject: m.subject,
        // 微软格式: from: { emailAddress: { name, address } }
        sender: `${m.from?.emailAddress?.name || ''} <${m.from?.emailAddress?.address || ''}>`,
        // 提取收件人 (支持多个)
        receiver: (m.toRecipients || []).map(r => r.emailAddress?.address).join(', '),
        // 获取 HTML 原文用于后续提取链接
        htmlContent: m.body?.content || '',
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
    
    // 获取列表
    if (method === 'GET') {
        const { results } = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts ORDER BY id DESC").all();
        // 如果需要脱敏，可以在这里处理 client_secret
        return jsonResp({ data: results });
    }
    
    // 新增 (支持批量导入)
    if (method === 'POST') {
        const d = await req.json();
        const items = Array.isArray(d) ? d : [d];
    
        // [新增] 获取现有邮箱列表用于去重
        const { results } = await env.XYTJ_OUTLOOK.prepare("SELECT email FROM accounts").all();
        const existingEmails = new Set(results.map(r => r.email));
        const skipped = [];
        const added = [];
    
        for (const item of items) {
            // [新增] 检查邮箱是否存在
            if (item.email && existingEmails.has(item.email)) {
                skipped.push(item.email);
                continue;
            }
    
            // 默认状态为 1 (启用)
            await env.XYTJ_OUTLOOK.prepare(
                "INSERT INTO accounts (name, email, client_id, client_secret, refresh_token, status) VALUES (?, ?, ?, ?, ?, 1)"
            ).bind(item.name, item.email||'', item.client_id, item.client_secret, item.refresh_token).run();
    
            // [新增] 更新本地 Set 防止同批次重复
            if (item.email) existingEmails.add(item.email);
            added.push(item.email);
        }
        // [修改] 返回详细结果
        return jsonResp({ ok: true, added_count: added.length, skipped: skipped });
    }
    
    // 更新
    if (method === 'PUT') {
        const d = await req.json();
        if (d.status !== undefined && d.name === undefined) {
            await env.XYTJ_OUTLOOK.prepare("UPDATE accounts SET status=? WHERE id=?").bind(d.status, d.id).run();
            return jsonResp({ ok: true });
        }
        // [新增] 检查邮箱是否被其他账号占用
        const exist = await env.XYTJ_OUTLOOK.prepare("SELECT id FROM accounts WHERE email=? AND id!=?").bind(d.email, d.id).first();
        if (exist) return jsonResp({ ok: false, error: "该邮箱已存在于其他账号中" });
        await env.XYTJ_OUTLOOK.prepare(
            "UPDATE accounts SET name=?, email=?, client_id=?, client_secret=?, refresh_token=? WHERE id=?"
        ).bind(d.name, d.email, d.client_id, d.client_secret, d.refresh_token, d.id).run();
        return jsonResp({ ok: true });
    }

    // 删除
    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        // 删除账号
        await env.XYTJ_OUTLOOK.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
        // 删除关联任务
        await env.XYTJ_OUTLOOK.prepare("DELETE FROM send_tasks WHERE account_id=?").bind(id).run();
        // 删除关联规则
        await env.XYTJ_OUTLOOK.prepare("DELETE FROM access_rules WHERE name IN (SELECT name FROM accounts WHERE id=?)").bind(id).run();
        return jsonResp({ ok: true });
    }
}

// 2. 任务管理
async function handleTasks(req, env) {
    const url = new URL(req.url);
    const method = req.method;
    
    // GET: 获取任务列表
    if (method === 'GET') {
        const { results } = await env.XYTJ_OUTLOOK.prepare(`
            SELECT t.*, a.name as account_name 
            FROM send_tasks t 
            LEFT JOIN accounts a ON t.account_id = a.id 
            ORDER BY t.next_run_at ASC`
        ).all();
        return jsonResp({ data: results });
    }

    // POST: 添加任务 / 立即发送
    if (method === 'POST') {
        const d = await req.json();
        
        // 兼容批量添加 (数组情况)
        if (Array.isArray(d)) {
            for (const item of d) {
                let nextRun = item.base_date ? new Date(item.base_date).getTime() : Date.now();
                await env.XYTJ_OUTLOOK.prepare(
                    "INSERT INTO send_tasks (account_id, to_email, subject, content, delay_config, is_loop, next_run_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')"
                ).bind(item.account_id, item.to_email, item.subject, item.content, item.delay_config, item.is_loop?1:0, nextRun).run();
            }
            return jsonResp({ ok: true });
        }

        // 模式: 立即发送 (无ID, 纯动作, 用于"立即发送"按钮)
        if (d.immediate) {
            const acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE id=?").bind(d.account_id).first();
            if (!acc) return jsonResp({ ok: false, error: "账号不存在" });
            
            const res = await sendEmailMS(env, acc, d.to_email, d.subject, d.content);
            return jsonResp({ ok: res.success, error: res.error });
        }
        
        // 模式: 加入队列 (添加单个新任务)
        let nextRun = d.base_date ? new Date(d.base_date).getTime() : Date.now();
        
        await env.XYTJ_OUTLOOK.prepare(
            "INSERT INTO send_tasks (account_id, to_email, subject, content, delay_config, is_loop, next_run_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')"
        ).bind(d.account_id, d.to_email, d.subject, d.content, d.delay_config, d.is_loop?1:0, nextRun).run();
        
        return jsonResp({ ok: true });
    }

    // PUT: 更新任务 (编辑 / 执行 / 状态修改)
    if (method === 'PUT') {
        const d = await req.json();
        
        // 场景 A: 列表中的"执行"按钮 (action: 'execute')
        if (d.action === 'execute') {
            const task = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM send_tasks WHERE id=?").bind(d.id).first();
            if (!task) return jsonResp({ ok: false, error: "任务不存在" });

            const acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE id=?").bind(task.account_id).first();
            if (!acc) return jsonResp({ ok: false, error: "账号无效" });

            // 调用发信逻辑
            const res = await sendEmailMS(env, acc, task.to_email, task.subject, task.content);
            
            if (res.success) {
                if (task.is_loop) {
                    await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET success_count=success_count+1 WHERE id=?").bind(d.id).run();
                } else {
                    // 非循环任务，执行成功后标记为完成
                    await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET status='success', success_count=success_count+1 WHERE id=?").bind(d.id).run();
                }
                return jsonResp({ ok: true });
            } else {
                // 执行失败
                await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET status='error', fail_count=fail_count+1 WHERE id=?").bind(d.id).run();
                return jsonResp({ ok: false, error: res.error });
            }
        }

        // 场景 B: 编辑任务保存 或 切换循环开关
        // 基础更新语句
        let sql = "UPDATE send_tasks SET account_id=?, to_email=?, subject=?, content=?, delay_config=?, is_loop=? WHERE id=?";
        let params = [d.account_id, d.to_email, d.subject, d.content, d.delay_config, d.is_loop?1:0, d.id];

        // 如果前端传了 base_date (修改了时间)，则同时更新 next_run_at
        // 注意：仅切换循环开关时 d.base_date 通常为空，此时不应重置时间
        if (d.base_date) {
            const newRun = new Date(d.base_date).getTime();
            sql = "UPDATE send_tasks SET account_id=?, to_email=?, subject=?, content=?, delay_config=?, is_loop=?, next_run_at=? WHERE id=?";
            params = [d.account_id, d.to_email, d.subject, d.content, d.delay_config, d.is_loop?1:0, newRun, d.id];
        }

        await env.XYTJ_OUTLOOK.prepare(sql).bind(...params).run();
        return jsonResp({ ok: true });
    }

    // DELETE: 删除任务
    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        const ids = url.searchParams.get('ids');
        if (ids) {
            const idList = ids.split(',');
            for (const i of idList) await env.XYTJ_OUTLOOK.prepare("DELETE FROM send_tasks WHERE id=?").bind(i).run();
        } else {
            await env.XYTJ_OUTLOOK.prepare("DELETE FROM send_tasks WHERE id=?").bind(id).run();
        }
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
    if (method === 'PUT') {
        const d = await req.json();
        // 修改：增加 match_receiver 和 group_id
        await env.XYTJ_OUTLOOK.prepare(
            "UPDATE access_rules SET name=?, alias=?, query_code=?, fetch_limit=?, valid_until=?, match_sender=?, match_receiver=?, match_body=?, group_id=? WHERE id=?"
        ).bind(d.name, d.alias, d.query_code, d.fetch_limit, d.valid_until, d.match_sender, d.match_receiver, d.match_body, d.group_id || null, d.id).run();
        return jsonResp({ success: true });
    }
    
    if (method === 'POST') {
        const d = await req.json();
        // 如果没有query_code则生成随机码
        const code = d.query_code || Math.random().toString(36).substring(2, 12).toUpperCase();
        
        // 修改：增加 match_receiver 和 group_id
        await env.XYTJ_OUTLOOK.prepare(
            "INSERT INTO access_rules (name, alias, query_code, fetch_limit, valid_until, match_sender, match_receiver, match_body, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(d.name, d.alias, code, d.fetch_limit, d.valid_until, d.match_sender, d.match_receiver, d.match_body, d.group_id || null).run();
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

// 5. 策略组管理 (新增)
async function handleGroups(req, env) {
    const url = new URL(req.url);
    const method = req.method;

    if (method === 'GET') {
        const { results } = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM filter_groups ORDER BY id DESC").all();
        return jsonResp({ data: results });
    }
    if (method === 'POST') {
        const d = await req.json();
        await env.XYTJ_OUTLOOK.prepare(
            "INSERT INTO filter_groups (name, match_sender, match_receiver, match_body) VALUES (?, ?, ?, ?)"
        ).bind(d.name, d.match_sender, d.match_receiver, d.match_body).run();
        return jsonResp({ ok: true });
    }
    if (method === 'PUT') {
        const d = await req.json();
        await env.XYTJ_OUTLOOK.prepare(
            "UPDATE filter_groups SET name=?, match_sender=?, match_receiver=?, match_body=? WHERE id=?"
        ).bind(d.name, d.match_sender, d.match_receiver, d.match_body, d.id).run();
        return jsonResp({ ok: true });
    }
    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        // 删除组时，将使用了该组的规则重置为无组状态（group_id=NULL）
        await env.XYTJ_OUTLOOK.prepare("UPDATE access_rules SET group_id=NULL WHERE group_id=?").bind(id).run();
        await env.XYTJ_OUTLOOK.prepare("DELETE FROM filter_groups WHERE id=?").bind(id).run();
        return jsonResp({ ok: true });
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

    // === [新增] 如果绑定了策略组，读取组配置覆盖 rule 的本地配置 ===
    if (rule.group_id) {
        const group = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM filter_groups WHERE id=?").bind(rule.group_id).first();
        if (group) {
            rule.match_sender = group.match_sender;
            rule.match_receiver = group.match_receiver;
            rule.match_body = group.match_body;
        }
    }

    // 2. 查有效期
    if (rule.valid_until && Date.now() > rule.valid_until) {
        return new Response("链接已过期 (Link Expired)", {status: 403, headers: {"Content-Type": "text/plain;charset=UTF-8"}});
    }

    // 3. 查对应账号 (通过 name 匹配)
    // 【修改点：将 const 改为 let，并增加后续的模糊查找逻辑】
    let acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE name=?").bind(rule.name).first();

    // [新增逻辑] 如果按名字没找到，尝试去邮箱地址(email字段)里模糊搜索
    if (!acc) {
        // 使用 LIKE 语法查找：只要 email 字段里包含规则名，就算匹配成功
        acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE email LIKE ?").bind(`%${rule.name}%`).first();
    }

    if (!acc) return new Response("未找到对应的账号配置 (Account Not Found)", {status: 404, headers: {"Content-Type": "text/plain;charset=UTF-8"}});

    // 解析 fetch_limit (支持 "抓取数-显示数" 格式，如 "5-3"；若为单数则两者一致)
    let fetchNum = 20, showNum = 5;
    if (rule.fetch_limit) {
        const parts = String(rule.fetch_limit).split('-');
        fetchNum = parseInt(parts[0]) || 20;
        showNum = parts.length > 1 ? (parseInt(parts[1]) || fetchNum) : fetchNum;
    }

    try {
        // 4. 抓取邮件
        let emails = await syncEmailsMS(env, acc.id, fetchNum);
        
        // [新增] 预处理：生成与最终显示一致的文本用于搜索 (解决“所见即所搜”问题)
        emails.forEach(e => {
            let content = e.htmlContent || e.body || "";
            // 复用显示时的逻辑：处理链接格式、去标签、清理空格
            content = content.replace(/<a[^>]+href=["'](.*?)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)');
            content = content.replace(/<[^>]+>/g, '');
            e.displayText = content.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        });
        
        // 5. 过滤
        if (rule.match_sender) {
            emails = emails.filter(e => e.sender.toLowerCase().includes(rule.match_sender.toLowerCase()));
        }
        
        // 增加收件人过滤
        if (rule.match_receiver) {
             emails = emails.filter(e => (e.receiver || "").toLowerCase().includes(rule.match_receiver.toLowerCase()));
        }
        
        if (rule.match_body) {
            // 支持多关键字 | 分隔 (自动处理为精确短语匹配)
            const keywords = rule.match_body.split('|').map(k => k.trim()).filter(v => v);
            if (keywords.length > 0) {
                emails = emails.filter(e => {
                    // [修改] 这里改为搜索 e.displayText (处理后的文本)
                    const body = (e.displayText || "").toLowerCase();
                    // 只要包含任意一个关键字即匹配
                    return keywords.some(k => body.includes(k.toLowerCase()));
                });
            }
        }
        
        // 6. 截取显示数量
        emails = emails.slice(0, showNum);

        // 7. 格式化输出 (纯文本)
        if (emails.length === 0) return new Response("暂无符合条件的邮件", {headers: {"Content-Type": "text/plain;charset=UTF-8"}});

        const text = emails.map(e => {
            const timeStr = new Date(e.received_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
            
            // [修改] 直接使用上面生成的 displayText，删除原来重复的处理逻辑
            return `${timeStr} | ${e.displayText}`;
        }).join('\n\n');
        const html = `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font-size: 16px; font-family: sans-serif; line-height: 1.3; padding: 0 0 2px 0;color: #000;background: #fff;">${text}</body>`;
        return new Response(html, { headers: {"Content-Type": "text/html;charset=UTF-8"} });
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
        try {
            const acc = await env.XYTJ_OUTLOOK.prepare("SELECT * FROM accounts WHERE id=?").bind(task.account_id).first();
            if (acc) {
                const res = await sendEmailMS(env, acc, task.to_email, task.subject, task.content);
                if (res.success) {
                    await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET status='success', success_count=success_count+1 WHERE id=?").bind(task.id).run();
                } else {
                    await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET status='error', fail_count=fail_count+1 WHERE id=?").bind(task.id).run();
                    console.error(`Task ${task.id} failed: ${res.error}`);
                    continue; 
                }
            }
        } catch(e) {
            console.error(`Task ${task.id} error: ${e.message}`);
            await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET status='error', fail_count=fail_count+1 WHERE id=?").bind(task.id).run();
            continue;
        }

        // 处理循环逻辑
        if (task.is_loop) {
            // 解析 delay_config (格式: 天|时|分|秒，支持 2-36 这种随机范围)
            let addMs = 86400000; // 默认 1 天
            if (task.delay_config && task.delay_config.includes('|')) {
                // 辅助函数：如果是 "2-36" 则返回区间随机数，否则返回数字
                const getVal = (s) => {
                    if (s && s.includes('-')) {
                        const [min, max] = s.split('-').map(Number);
                        return Math.floor(Math.random() * (max - min + 1)) + min;
                    }
                    return Number(s) || 0;
                };
                
                const parts = task.delay_config.split('|');
                addMs = (getVal(parts[0])*86400000) + (getVal(parts[1])*3600000) + (getVal(parts[2])*60000) + (getVal(parts[3])*1000);
            }
            if (addMs <= 0) addMs = 60000; // 防止死循环

            const nextRun = Date.now() + addMs;
            // 重置状态为 pending 并更新下次运行时间
            await env.XYTJ_OUTLOOK.prepare("UPDATE send_tasks SET next_run_at=?, status='pending' WHERE id=?").bind(nextRun, task.id).run();
        } else {
            // 非循环任务，执行成功后不需要额外操作，状态已更新为 success
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
