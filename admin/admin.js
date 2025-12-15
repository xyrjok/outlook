// ... (前面的部分不变)

    // 保存账号 (纯 API 逻辑)
    saveAccount: async () => {
        const id = document.getElementById('acc-id').value;
        const data = {
            id: id || undefined,
            name: document.getElementById('acc-name').value,
            email: document.getElementById('acc-email').value,
            client_id: document.getElementById('acc-client-id').value,
            client_secret: document.getElementById('acc-client-secret').value,
            refresh_token: document.getElementById('acc-refresh-token').value
        };

        await app.api("/accounts", id ? "PUT" : "POST", data);
        bootstrap.Modal.getInstance(document.getElementById('modal-account')).hide();
        app.loadAccounts();
    },

    // 编辑回显
    editAccount: (id) => {
        const acc = window.allAccounts.find(a => a.id === id);
        if(!acc) return;
        document.getElementById('acc-id').value = acc.id;
        document.getElementById('acc-name').value = acc.name;
        document.getElementById('acc-email').value = acc.email;
        document.getElementById('acc-client-id').value = acc.client_id;
        document.getElementById('acc-client-secret').value = acc.client_secret;
        document.getElementById('acc-refresh-token').value = acc.refresh_token;
        
        new bootstrap.Modal(document.getElementById('modal-account')).show();
    },

// ... (其他部分基本不变，注意 renderTaskList 里去掉 API/GAS 的类型判断显示)
