/* AquaInfinity Admin Console — vanilla JS + supabase-js v2.
 * Auth is gated by is_admin(); every write is enforced server-side by RLS.
 */
(() => {
  'use strict';

  const cfg = window.AQUA_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    document.body.innerHTML =
      '<p style="padding:40px;font-family:sans-serif">Missing config.js values.</p>';
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  // ---------- tiny helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const view = () => $('#view');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  const egp = (minor) =>
    (Number(minor || 0) / 100).toLocaleString('en-EG', {
      style: 'currency',
      currency: 'EGP',
      maximumFractionDigits: 2,
    });
  const fmtDate = (s) =>
    s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const short = (id) => (id ? String(id).slice(0, 8) : '—');
  const firstImage = (row) => {
    const a = row && row.image_paths;
    if (Array.isArray(a) && a.length) return a[0];
    return (row && row.image_path) || null;
  };
  const imgTag = (url) =>
    url
      ? `<img class="thumb-sm" src="${esc(url)}" alt=""/>`
      : '<span class="thumb-sm placeholder">🖼️</span>';

  const BUCKET = 'product-images';

  let me = null; // { id, email, isHead, rolesEnabled }

  // ---------- toast ----------
  function toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    $('#toastRoot').appendChild(t);
    setTimeout(() => t.remove(), 3800);
  }
  const ok = (m) => toast(m, 'ok');
  const err = (m) => toast(m, 'err');

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      ok('Copied to clipboard');
    } catch (e) {
      err('Copy failed: ' + (e.message || e));
    }
  }

  // A copyable id chip: shows the short id, copies the full id on click.
  const idChip = (id, what = 'user ID') =>
    `<button class="id-copy" type="button" data-copy="${esc(id)}" title="Copy full ${esc(
      what,
    )}">${short(id)}<span class="copy-ic">⧉</span></button>`;

  // Friendly mapping for common Postgres/RLS errors.
  function explain(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e);
    if (/row-level security|42501|forbidden|permission denied/i.test(m))
      return 'Not permitted (RLS). This table may need the admin-grants.sql policies.';
    if (/last_admin/i.test(m)) return "Can't revoke the last remaining admin.";
    if (/cannot_modify_head_admin/i.test(m))
      return "Head admins can't be changed from the console (promote/demote via SQL).";
    return m;
  }

  // ---------- modal ----------
  function closeModal() {
    $('#modalRoot').innerHTML = '';
  }
  function modal({ title, bodyHTML, footHTML }) {
    $('#modalRoot').innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <div class="modal-head"><h3>${esc(title)}</h3><button class="x" data-close>×</button></div>
          <div class="modal-body">${bodyHTML}</div>
          <div class="modal-foot">${footHTML || ''}</div>
        </div>
      </div>`;
    const back = $('.modal-backdrop');
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.hasAttribute('data-close')) closeModal();
    });
  }

  function confirmModal({ title, message, confirmLabel = 'Confirm', danger }) {
    return new Promise((resolve) => {
      modal({
        title,
        bodyHTML: `<p class="subtle">${message}</p>`,
        footHTML: `<button class="btn ghost" data-close>Cancel</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" id="okBtn">${esc(confirmLabel)}</button>`,
      });
      $('#okBtn').addEventListener('click', () => {
        closeModal();
        resolve(true);
      });
      $('.modal-backdrop').addEventListener('click', (e) => {
        if (e.target.hasAttribute('data-close') || e.target.classList.contains('modal-backdrop'))
          resolve(false);
      });
    });
  }

  // Generic form modal. fields: [{name,label,type,options,required,placeholder,help,value}]
  function formModal({ title, fields, submitLabel = 'Save' }) {
    return new Promise((resolve) => {
      const inputHTML = (f) => {
        const v = f.value ?? '';
        if (f.type === 'textarea')
          return `<textarea name="${f.name}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
        if (f.type === 'select')
          return `<select name="${f.name}">${f.options
            .map(
              (o) =>
                `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`,
            )
            .join('')}</select>`;
        if (f.type === 'checkbox')
          return `<label class="field checkbox"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}/> ${esc(f.label)}</label>`;
        return `<input type="${f.type || 'text'}" name="${f.name}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" ${f.step ? `step="${f.step}"` : ''}/>`;
      };
      const body = fields
        .map((f) =>
          f.type === 'checkbox'
            ? inputHTML(f)
            : `<label class="field">${esc(f.label)}${inputHTML(f)}${f.help ? `<span class="subtle">${esc(f.help)}</span>` : ''}</label>`,
        )
        .join('');
      modal({
        title,
        bodyHTML: `<form id="modalForm" class="grid" style="gap:14px">${body}</form>`,
        footHTML: `<button class="btn ghost" data-close>Cancel</button>
          <button class="btn primary" id="submitBtn">${esc(submitLabel)}</button>`,
      });
      $('#submitBtn').addEventListener('click', () => {
        const form = $('#modalForm');
        const out = {};
        for (const f of fields) {
          const el = form.elements[f.name];
          if (f.type === 'checkbox') out[f.name] = el.checked;
          else if (f.type === 'number') out[f.name] = el.value === '' ? null : Number(el.value);
          else out[f.name] = el.value.trim() === '' ? null : el.value.trim();
          if (f.required && (out[f.name] === null || out[f.name] === ''))
            return err(`${f.label} is required`);
        }
        closeModal();
        resolve(out);
      });
      $('.modal-backdrop').addEventListener('click', (e) => {
        if (e.target.hasAttribute('data-close') || e.target.classList.contains('modal-backdrop'))
          resolve(null);
      });
    });
  }

  // ---------- image upload + gallery ----------
  async function uploadFiles(files, prefix) {
    const urls = [];
    for (const f of files) {
      const ext = ((f.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg');
      const rand =
        (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
        Date.now() + '-' + Math.random().toString(36).slice(2);
      const path = `${prefix}/${rand}.${ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, f, {
        cacheControl: '3600',
        upsert: false,
        contentType: f.type || undefined,
      });
      if (error) throw error;
      urls.push(sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl);
    }
    return urls;
  }

  // Renders a thumbnail gallery with add (multi-file) + per-image remove into
  // `root`. Returns { kept(), files() } — kept URLs to keep + new File objects.
  function mountGallery(root, initial) {
    const kept = Array.isArray(initial) ? initial.filter(Boolean) : [];
    const pending = []; // { file, url }
    function render() {
      root.innerHTML = `<div class="gallery">
        ${kept
          .map(
            (u, i) =>
              `<div class="thumb"><img src="${esc(u)}" alt=""/><button type="button" class="thumb-x" data-keep="${i}">×</button></div>`,
          )
          .join('')}
        ${pending
          .map(
            (p, i) =>
              `<div class="thumb"><img src="${p.url}" alt=""/><span class="thumb-tag">new</span><button type="button" class="thumb-x" data-pend="${i}">×</button></div>`,
          )
          .join('')}
        <label class="thumb add"><input type="file" accept="image/*" multiple hidden/><span>+ Add</span></label>
      </div>`;
      root.querySelector('input[type=file]').addEventListener('change', (e) => {
        for (const f of e.target.files) pending.push({ file: f, url: URL.createObjectURL(f) });
        render();
      });
      root.querySelectorAll('[data-keep]').forEach((b) =>
        b.addEventListener('click', () => {
          kept.splice(Number(b.dataset.keep), 1);
          render();
        }),
      );
      root.querySelectorAll('[data-pend]').forEach((b) =>
        b.addEventListener('click', () => {
          pending.splice(Number(b.dataset.pend), 1);
          render();
        }),
      );
    }
    render();
    return { kept: () => kept, files: () => pending.map((p) => p.file) };
  }

  // ---------- auth ----------
  async function isAdmin() {
    const { data, error } = await sb.rpc('is_admin');
    if (error) return false;
    return data === true;
  }

  // Detect head-admin tier. If the roles SQL isn't applied yet (RPC missing),
  // fall back to legacy behaviour: any admin can manage roles.
  async function detectHead() {
    const { data, error } = await sb.rpc('is_head_admin');
    if (error) {
      me.rolesEnabled = false;
      me.isHead = true;
    } else {
      me.rolesEnabled = true;
      me.isHead = data === true;
    }
  }

  async function boot() {
    const { data } = await sb.auth.getSession();
    if (data.session) {
      me = { id: data.session.user.id, email: data.session.user.email };
      if (await isAdmin()) {
        await detectHead();
        return showApp();
      }
      await sb.auth.signOut();
    }
    showLogin();
  }

  function showLogin(msg) {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    if (msg) {
      const e = $('#loginError');
      e.textContent = msg;
      e.classList.remove('hidden');
    }
  }

  function showApp() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#whoami').textContent = me.email || me.id;
    navigate('overview');
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    $('#loginError').classList.add('hidden');
    try {
      const { data, error } = await sb.auth.signInWithPassword({
        email: $('#email').value.trim(),
        password: $('#password').value,
      });
      if (error) throw error;
      me = { id: data.user.id, email: data.user.email };
      if (!(await isAdmin())) {
        await sb.auth.signOut();
        throw new Error('This account is not an admin.');
      }
      await detectHead();
      showApp();
    } catch (e2) {
      showLogin(explain(e2));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('#logout').addEventListener('click', async () => {
    await sb.auth.signOut();
    location.reload();
  });

  // ---------- router ----------
  const SECTIONS = {};
  let current = 'overview';

  function navigate(name) {
    current = name;
    document.querySelectorAll('.nav-item').forEach((b) =>
      b.classList.toggle('active', b.dataset.section === name),
    );
    $('#sectionTitle').textContent = $(`.nav-item[data-section="${name}"]`).textContent.trim();
    view().innerHTML = '<div class="loading">Loading…</div>';
    SECTIONS[name]().catch((e) => {
      view().innerHTML = `<div class="card"><p class="error">${esc(explain(e))}</p></div>`;
    });
  }
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.addEventListener('click', () => navigate(b.dataset.section)),
  );
  $('#refresh').addEventListener('click', () => navigate(current));

  // Click-to-copy for any element carrying data-copy (e.g. user-id chips).
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) {
      e.preventDefault();
      copyText(b.getAttribute('data-copy'));
    }
  });

  // ============================================================
  // OVERVIEW
  // ============================================================
  SECTIONS.overview = async () => {
    const [{ data: metrics, error: me1 }, { data: admins }] = await Promise.all([
      sb.rpc('admin_order_metrics'),
      sb.rpc('admin_count'),
    ]);
    if (me1) throw me1;
    const m = metrics || {};
    const byStatus = m.by_status || {};
    const statusChips = Object.keys(byStatus)
      .map((k) => `<span class="badge ${statusTone(k)}">${esc(label(k))}: ${byStatus[k]}</span>`)
      .join(' ');
    const recent = (m.recent || [])
      .map(
        (r) => `<tr>
          <td>${idChip(r.id, 'order ID')}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${egp(r.total_minor)}</td>
          <td class="subtle">${fmtDate(r.created_at)}</td></tr>`,
      )
      .join('');

    view().innerHTML = `
      <div class="grid stat-grid">
        <div class="card stat"><div class="label">Awaiting approval</div>
          <div class="value">${m.awaiting ?? 0}</div><div class="sub">orders need a decision</div></div>
        <div class="card stat"><div class="label">Confirmed revenue</div>
          <div class="value">${egp(m.confirmed_revenue_minor)}</div><div class="sub">sum of confirmed orders</div></div>
        <div class="card stat"><div class="label">Admins</div>
          <div class="value">${admins ?? '—'}</div><div class="sub">accounts with the admin role</div></div>
        <div class="card stat"><div class="label">Signed in as</div>
          <div class="value" style="font-size:16px;word-break:break-all">${esc(me.email || '')}</div>
          <div class="sub">admin</div></div>
      </div>
      <div class="card" style="margin-top:18px">
        <div class="section-head"><h3>Orders by status</h3></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${statusChips || '<span class="subtle">No orders yet.</span>'}</div>
      </div>
      <div class="table-wrap" style="margin-top:18px">
        <div style="padding:14px 16px;font-weight:700;font-size:14px;border-bottom:1px solid var(--line)">Recent orders</div>
        <table><thead><tr><th>Order</th><th>Status</th><th>Total</th><th>Created</th></tr></thead>
        <tbody>${recent || '<tr><td colspan="4" class="empty">No orders.</td></tr>'}</tbody></table>
      </div>`;
  };

  // ============================================================
  // ORDERS
  // ============================================================
  const ORDER_STATUSES = [
    'pending_payment',
    'awaiting_approval',
    'confirmed',
    'rejected',
    'out_for_delivery',
    'completed',
  ];
  function label(s) {
    return String(s || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function statusTone(s) {
    return (
      {
        pending_payment: 'gray',
        awaiting_approval: 'amber',
        confirmed: 'green',
        rejected: 'red',
        out_for_delivery: 'blue',
        completed: 'cyan',
      }[s] || 'gray'
    );
  }
  const statusBadge = (s) => `<span class="badge ${statusTone(s)}">${esc(label(s))}</span>`;

  let ordersFilter = '';
  SECTIONS.orders = async () => {
    let q = sb.from('orders').select('*').order('created_at', { ascending: false }).limit(200);
    if (ordersFilter) q = q.eq('status', ordersFilter);
    const { data: orders, error } = await q;
    if (error) throw error;

    // item counts in one round-trip
    const ids = orders.map((o) => o.id);
    const counts = {};
    if (ids.length) {
      const { data: items } = await sb.from('order_items').select('order_id').in('order_id', ids);
      (items || []).forEach((i) => (counts[i.order_id] = (counts[i.order_id] || 0) + 1));
    }

    const opts = ['<option value="">All statuses</option>']
      .concat(ORDER_STATUSES.map((s) => `<option value="${s}" ${ordersFilter === s ? 'selected' : ''}>${label(s)}</option>`))
      .join('');

    view().innerHTML = `
      <div class="section-head">
        <h3>${orders.length} order(s)</h3>
        <div class="toolbar"><select id="ordFilter">${opts}</select></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Order</th><th>Status</th><th>Items</th><th>Total</th><th>Method</th><th>Created</th><th></th></tr></thead>
        <tbody>${
          orders
            .map(
              (o) => `<tr>
          <td>${idChip(o.id, 'order ID')}</td>
          <td>${statusBadge(o.status)}</td>
          <td>${counts[o.id] || 0}</td>
          <td><b>${egp(o.total_minor)}</b></td>
          <td class="subtle">${esc(label(o.payment_method))}</td>
          <td class="subtle">${fmtDate(o.created_at)}</td>
          <td class="actions"><button class="btn ghost small" data-open="${o.id}">View</button></td>
        </tr>`,
            )
            .join('') || '<tr><td colspan="7" class="empty">No orders.</td></tr>'
        }</tbody></table></div>`;

    $('#ordFilter').addEventListener('change', (e) => {
      ordersFilter = e.target.value;
      navigate('orders');
    });
    view()
      .querySelectorAll('[data-open]')
      .forEach((b) =>
        b.addEventListener('click', () => openOrder(orders.find((o) => o.id === b.dataset.open))),
      );
  };

  async function openOrder(o) {
    const { data: items } = await sb.from('order_items').select('*').eq('order_id', o.id);
    const lines = (items || [])
      .map(
        (i) =>
          `<tr><td>${esc(i.name_snapshot)}</td><td>×${i.quantity}</td><td>${egp(i.unit_price_minor * i.quantity)}</td></tr>`,
      )
      .join('');
    modal({
      title: `Order ${short(o.id)}`,
      bodyHTML: `
        <dl class="detail-list">
          <dt>Order ID</dt><dd>${idChip(o.id, 'order ID')}</dd>
          <dt>Status</dt><dd>${statusBadge(o.status)}</dd>
          <dt>Total</dt><dd><b>${egp(o.total_minor)}</b> (subtotal ${egp(o.subtotal_minor)} + delivery ${egp(o.delivery_fee_minor)})</dd>
          <dt>Payment</dt><dd>${esc(label(o.payment_method))}</dd>
          <dt>Delivery</dt><dd>${esc(o.delivery_snapshot || '—')}</dd>
          <dt>Created</dt><dd>${fmtDate(o.created_at)}</dd>
          ${o.rejection_reason ? `<dt>Rejection</dt><dd>${esc(o.rejection_reason)}</dd>` : ''}
        </dl>
        <div class="table-wrap" style="margin-top:6px"><table>
          <thead><tr><th>Item</th><th>Qty</th><th>Line</th></tr></thead>
          <tbody>${lines || '<tr><td colspan="3" class="empty">No items.</td></tr>'}</tbody></table></div>`,
      footHTML: orderActions(o),
    });
    wireOrderActions(o);
  }

  function orderActions(o) {
    const close = '<button class="btn ghost" data-close>Close</button>';
    if (o.status === 'awaiting_approval')
      return `${close}<button class="btn danger" data-act="reject">Reject</button><button class="btn success" data-act="confirm">Confirm</button>`;
    if (o.status === 'confirmed')
      return `${close}<button class="btn primary" data-act="out_for_delivery">Out for delivery</button>`;
    if (o.status === 'out_for_delivery')
      return `${close}<button class="btn success" data-act="completed">Mark completed</button>`;
    return close;
  }

  function wireOrderActions(o) {
    document.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', async () => {
        const act = b.dataset.act;
        let patch = {};
        if (act === 'confirm') patch = { status: 'confirmed' };
        else if (act === 'reject') {
          const reason = prompt('Rejection reason (shown to the customer):', '');
          if (reason === null) return;
          patch = { status: 'rejected', rejection_reason: reason || null };
        } else patch = { status: act };
        const { error } = await sb.from('orders').update(patch).eq('id', o.id);
        if (error) return err(explain(error));
        ok(`Order ${short(o.id)} → ${label(patch.status)}`);
        closeModal();
        navigate('orders');
      }),
    );
  }

  // ============================================================
  // USERS & ADMINS
  // ============================================================
  let userSearch = '';
  SECTIONS.users = async () => {
    const { data: users, error } = await sb
      .from('admin_users')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    const filtered = userSearch
      ? users.filter(
          (u) =>
            (u.identity || '').toLowerCase().includes(userSearch.toLowerCase()) ||
            (u.id || '').includes(userSearch),
        )
      : users;

    const canManage = me.isHead; // head admins (or legacy admins before roles SQL)
    const roleBadge = (r) =>
      r === 'head_admin'
        ? '<span class="badge pill-head">head admin</span>'
        : r === 'admin'
          ? '<span class="badge pill-admin">admin</span>'
          : '<span class="badge gray">user</span>';
    const notice =
      me.rolesEnabled && !canManage
        ? `<div class="notice">You're an <b>admin</b>. Only a <b>head admin</b> can assign or revoke admin access — those controls are hidden for you.</div>`
        : `<div class="notice">Granting/revoking admin goes through the guarded <b>set_user_role</b> RPC —
            head-admin only, head admins can't be modified here, and every change is audited.</div>`;

    view().innerHTML = `
      ${notice}
      <div class="section-head">
        <h3>${filtered.length} user(s)</h3>
        <div class="toolbar"><input class="search" id="userSearch" placeholder="Search email / id…" value="${esc(userSearch)}"/></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Identity</th><th>Role</th><th>User ID</th><th>Joined</th><th></th></tr></thead>
        <tbody>${
          filtered
            .map((u) => {
              let action = '';
              if (u.role === 'head_admin') {
                action = '<span class="subtle">🔒 protected</span>';
              } else if (canManage) {
                action =
                  u.role === 'admin'
                    ? `<button class="btn ghost small" data-revoke="${u.id}" data-id="${esc(u.identity)}">Revoke admin</button>`
                    : `<button class="btn primary small" data-grant="${u.id}" data-id="${esc(u.identity)}">Make admin</button>`;
              }
              return `<tr>
            <td>${esc(u.identity)}</td>
            <td>${roleBadge(u.role)}</td>
            <td>${idChip(u.id)}</td>
            <td class="subtle">${fmtDate(u.created_at)}</td>
            <td class="actions">${action}</td></tr>`;
            })
            .join('') || '<tr><td colspan="5" class="empty">No users.</td></tr>'
        }</tbody></table></div>`;

    const si = $('#userSearch');
    si.addEventListener('input', (e) => {
      userSearch = e.target.value;
    });
    si.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') navigate('users');
    });
    view()
      .querySelectorAll('[data-grant]')
      .forEach((b) =>
        b.addEventListener('click', () => changeRole(b.dataset.grant, b.dataset.id, true)),
      );
    view()
      .querySelectorAll('[data-revoke]')
      .forEach((b) =>
        b.addEventListener('click', () => changeRole(b.dataset.revoke, b.dataset.id, false)),
      );
  };

  async function changeRole(targetId, identity, makeAdmin) {
    const yes = await confirmModal({
      title: makeAdmin ? 'Grant admin access' : 'Revoke admin access',
      message: `${makeAdmin ? 'Grant' : 'Revoke'} admin for <b>${esc(identity)}</b>? ${
        makeAdmin ? 'They will be able to manage the whole app.' : ''
      }`,
      confirmLabel: makeAdmin ? 'Make admin' : 'Revoke admin',
      danger: !makeAdmin,
    });
    if (!yes) return;
    const { error } = await sb.rpc('set_user_role', { p_target: targetId, p_make_admin: makeAdmin });
    if (error) return err(explain(error));
    ok(`${identity} is now ${makeAdmin ? 'an admin' : 'a regular user'}.`);
    navigate('users');
  }

  // ============================================================
  // PRODUCTS
  // ============================================================
  const PRODUCT_CATS = ['filter', 'cartridge', 'accessory', 'other'];
  SECTIONS.products = async () => {
    const { data: products, error } = await sb
      .from('products')
      .select('*')
      .order('name');
    if (error) throw error;
    view().innerHTML = `
      <div class="section-head"><h3>${products.length} product(s)</h3>
        <div class="toolbar"><button class="btn primary" id="newProduct">+ New product</button></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Available</th><th></th></tr></thead>
        <tbody>${
          products
            .map(
              (p) => `<tr>
          <td><div class="cell-img">${imgTag(firstImage(p))}<div><b>${esc(p.name)}</b><div class="subtle">${esc(p.description || '')}</div></div></div></td>
          <td>${esc(label(p.category))}</td>
          <td>${egp(p.price_minor)}</td>
          <td>${p.available ? '<span class="badge green">Yes</span>' : '<span class="badge red">Sold out</span>'}</td>
          <td class="actions">
            <button class="btn ghost small" data-toggle="${p.id}">${p.available ? 'Mark sold out' : 'Mark available'}</button>
            <button class="btn ghost small" data-edit="${p.id}">Edit</button>
          </td></tr>`,
            )
            .join('') || '<tr><td colspan="5" class="empty">No products.</td></tr>'
        }</tbody></table></div>`;

    $('#newProduct').addEventListener('click', () => editProduct());
    view()
      .querySelectorAll('[data-edit]')
      .forEach((b) =>
        b.addEventListener('click', () => editProduct(products.find((p) => p.id === b.dataset.edit))),
      );
    view()
      .querySelectorAll('[data-toggle]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          const p = products.find((x) => x.id === b.dataset.toggle);
          const { error: e } = await sb
            .from('products')
            .update({ available: !p.available })
            .eq('id', p.id);
          if (e) return err(explain(e));
          ok('Updated.');
          navigate('products');
        }),
      );
  };

  function editProduct(p) {
    const cats = PRODUCT_CATS.map(
      (c) => `<option value="${c}" ${p?.category === c ? 'selected' : ''}>${label(c)}</option>`,
    ).join('');
    modal({
      title: p ? 'Edit product' : 'New product',
      bodyHTML: `<form id="pForm" class="grid" style="gap:14px">
        <label class="field">Name<input name="name" value="${esc(p?.name || '')}"/></label>
        <label class="field">Description<textarea name="description" rows="2">${esc(p?.description || '')}</textarea></label>
        <div class="row2">
          <label class="field">Price (EGP)<input name="price_egp" type="number" step="0.01" value="${p ? p.price_minor / 100 : ''}"/></label>
          <label class="field">Category<select name="category">${cats}</select></label>
        </div>
        <label class="field checkbox"><input type="checkbox" name="available" ${!p || p.available ? 'checked' : ''}/> Available for sale</label>
        <div class="field">Images<div id="pGallery"></div>
          <span class="subtle">Upload one or more pictures (the first is used as the app's main image).</span></div>
      </form>`,
      footHTML: `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pSave">Save</button>`,
    });
    const gallery = mountGallery($('#pGallery'), p?.image_paths || (p?.image_path ? [p.image_path] : []));
    $('#pSave').addEventListener('click', async () => {
      const f = $('#pForm');
      const val = (n) => f.querySelector(`[name="${n}"]`);
      const name = val('name').value.trim();
      if (!name) return err('Name is required');
      const btn = $('#pSave');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const newUrls = await uploadFiles(gallery.files(), 'products');
        const images = [...gallery.kept(), ...newUrls];
        const payload = {
          name,
          description: val('description').value.trim() || null,
          price_minor: Math.round(Number(val('price_egp').value || 0) * 100),
          category: val('category').value,
          available: val('available').checked,
          image_paths: images,
          image_path: images[0] || null,
        };
        const res = p
          ? await sb.from('products').update(payload).eq('id', p.id)
          : await sb.from('products').insert(payload);
        if (res.error) throw res.error;
        ok(p ? 'Product updated.' : 'Product created.');
        closeModal();
        navigate('products');
      } catch (e) {
        err(explain(e));
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  }

  // ============================================================
  // FILTER CATALOG  (needs admin-grants.sql)
  // ============================================================
  SECTIONS.catalog = async () => {
    const { data, error } = await sb.from('filter_catalog').select('*').order('name');
    if (error) throw error;
    view().innerHTML = `
      ${grantsNotice('filter_catalog')}
      <div class="section-head"><h3>${data.length} model(s)</h3>
        <div class="toolbar"><button class="btn primary" id="newModel">+ New model</button></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Spec</th><th>Stages</th><th>Interval</th><th>QR code</th><th>Active</th><th></th></tr></thead>
        <tbody>${
          data
            .map(
              (m) => `<tr>
          <td><b>${esc(m.name)}</b></td>
          <td class="subtle">${esc(m.description || '—')}</td>
          <td>${m.stage_count ?? '—'}</td>
          <td>${m.replacement_interval_days ? m.replacement_interval_days + ' d' : '—'}</td>
          <td class="mono">${esc(m.qr_code || '—')}</td>
          <td>${m.active ? '<span class="badge green">Yes</span>' : '<span class="badge gray">No</span>'}</td>
          <td class="actions"><button class="btn ghost small" data-edit="${m.id}">Edit</button>
            <button class="btn ghost small" data-stages="${m.id}" data-name="${esc(m.name)}">Stages</button></td></tr>`,
            )
            .join('') || '<tr><td colspan="7" class="empty">No catalog models.</td></tr>'
        }</tbody></table></div>`;
    $('#newModel').addEventListener('click', () => editModel());
    view()
      .querySelectorAll('[data-edit]')
      .forEach((b) =>
        b.addEventListener('click', () => editModel(data.find((m) => m.id === b.dataset.edit))),
      );
    view()
      .querySelectorAll('[data-stages]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          cartridgeModelId = b.dataset.stages;
          cartridgeModelName = b.dataset.name;
          navigate('cartridges');
        }),
      );
  };

  async function editModel(m) {
    const out = await formModal({
      title: m ? 'Edit model' : 'New filter model',
      fields: [
        { name: 'name', label: 'Name', required: true, value: m?.name },
        { name: 'description', label: 'Spec sublabel', placeholder: '6-stage RO filter', value: m?.description },
        { name: 'stage_count', label: 'Stage count', type: 'number', value: m?.stage_count },
        { name: 'capacity_liters', label: 'Capacity (L)', type: 'number', value: m?.capacity_liters },
        { name: 'replacement_interval_days', label: 'Replace interval (days)', type: 'number', value: m?.replacement_interval_days },
        { name: 'image_path', label: 'Image URL', value: m?.image_path },
        { name: 'qr_code', label: 'QR / serial code', value: m?.qr_code, help: 'A scan of this code preselects this model.' },
        { name: 'active', label: 'Active (shown to customers)', type: 'checkbox', value: m ? m.active : true },
      ],
    });
    if (!out) return;
    const res = m
      ? await sb.from('filter_catalog').update(out).eq('id', m.id)
      : await sb.from('filter_catalog').insert(out);
    if (res.error) return err(explain(res.error));
    ok(m ? 'Model updated.' : 'Model created.');
    navigate('catalog');
  }

  // ============================================================
  // CARTRIDGES  (needs admin-grants.sql)
  // ============================================================
  let cartridgeModelId = '';
  let cartridgeModelName = '';
  SECTIONS.cartridges = async () => {
    const { data: models } = await sb.from('filter_catalog').select('id,name').order('name');
    if (!cartridgeModelId && models && models.length) {
      cartridgeModelId = models[0].id;
      cartridgeModelName = models[0].name;
    }
    const opts = (models || [])
      .map((m) => `<option value="${m.id}" ${m.id === cartridgeModelId ? 'selected' : ''}>${esc(m.name)}</option>`)
      .join('');

    let stages = [];
    if (cartridgeModelId) {
      const { data, error } = await sb
        .from('catalog_cartridges')
        .select('*')
        .eq('catalog_model_id', cartridgeModelId)
        .order('stage_index');
      if (error) throw error;
      stages = data || [];
    }

    view().innerHTML = `
      ${grantsNotice('catalog_cartridges')}
      <div class="section-head">
        <h3>Stages for a model</h3>
        <div class="toolbar">
          <select id="modelPick">${opts || '<option>No models</option>'}</select>
          <button class="btn primary" id="newStage" ${cartridgeModelId ? '' : 'disabled'}>+ Add stage</button>
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Lifespan</th><th>Capacity</th><th>Micron</th><th></th></tr></thead>
        <tbody>${
          stages
            .map(
              (s) => `<tr>
          <td><b>${s.stage_index}</b></td>
          <td><div class="cell-img">${imgTag(firstImage(s))}<div>${esc(s.name)}<div class="subtle">${esc(s.about || '')}</div></div></div></td>
          <td class="subtle">${esc(s.type || '—')}</td>
          <td>${s.lifespan_days ? s.lifespan_days + ' d' : '—'}</td>
          <td>${s.capacity_liters ? s.capacity_liters + ' L' : '—'}</td>
          <td>${s.micron ?? '—'}</td>
          <td class="actions"><button class="btn ghost small" data-edit="${s.id}">Edit</button>
            <button class="btn danger small" data-del="${s.id}">Delete</button></td></tr>`,
            )
            .join('') || '<tr><td colspan="7" class="empty">No stages for this model.</td></tr>'
        }</tbody></table></div>`;

    $('#modelPick')?.addEventListener('change', (e) => {
      cartridgeModelId = e.target.value;
      cartridgeModelName = e.target.selectedOptions[0].textContent;
      navigate('cartridges');
    });
    $('#newStage')?.addEventListener('click', () => editStage(null, stages.length + 1));
    view()
      .querySelectorAll('[data-edit]')
      .forEach((b) =>
        b.addEventListener('click', () => editStage(stages.find((s) => s.id === b.dataset.edit))),
      );
    view()
      .querySelectorAll('[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          if (!(await confirmModal({ title: 'Delete stage', message: 'Remove this cartridge stage?', confirmLabel: 'Delete', danger: true })))
            return;
          const { error } = await sb.from('catalog_cartridges').delete().eq('id', b.dataset.del);
          if (error) return err(explain(error));
          ok('Stage deleted.');
          navigate('cartridges');
        }),
      );
  };

  function editStage(s, nextIndex) {
    modal({
      title: s ? 'Edit stage' : `New stage for ${esc(cartridgeModelName)}`,
      bodyHTML: `<form id="sForm" class="grid" style="gap:14px">
        <div class="row2">
          <label class="field">Stage #<input name="stage_index" type="number" value="${s?.stage_index ?? nextIndex ?? 1}"/></label>
          <label class="field">Name<input name="name" value="${esc(s?.name || '')}" placeholder="Sediment Filter"/></label>
        </div>
        <label class="field">Type / material<input name="type" value="${esc(s?.type || '')}" placeholder="PP Cotton"/></label>
        <label class="field">About<textarea name="about" rows="2">${esc(s?.about || '')}</textarea></label>
        <div class="row2">
          <label class="field">Lifespan (days)<input name="lifespan_days" type="number" value="${s?.lifespan_days ?? ''}"/></label>
          <label class="field">Capacity (L)<input name="capacity_liters" type="number" value="${s?.capacity_liters ?? ''}"/></label>
        </div>
        <label class="field">Micron rating<input name="micron" type="number" step="0.01" value="${s?.micron ?? ''}"/></label>
        <div class="field">Images<div id="sGallery"></div>
          <span class="subtle">Upload one or more pictures of this cartridge stage.</span></div>
      </form>`,
      footHTML: `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="sSave">Save</button>`,
    });
    const gallery = mountGallery($('#sGallery'), s?.image_paths || []);
    $('#sSave').addEventListener('click', async () => {
      const f = $('#sForm');
      const val = (n) => f.querySelector(`[name="${n}"]`);
      const name = val('name').value.trim();
      const stageIndex = Number(val('stage_index').value);
      if (!name) return err('Name is required');
      if (!stageIndex) return err('Stage # is required');
      const btn = $('#sSave');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const newUrls = await uploadFiles(gallery.files(), 'cartridges');
        const num = (n) => (val(n).value === '' ? null : Number(val(n).value));
        const payload = {
          catalog_model_id: cartridgeModelId,
          stage_index: stageIndex,
          name,
          type: val('type').value.trim() || null,
          about: val('about').value.trim() || null,
          lifespan_days: num('lifespan_days'),
          capacity_liters: num('capacity_liters'),
          micron: num('micron'),
          image_paths: [...gallery.kept(), ...newUrls],
        };
        const res = s
          ? await sb.from('catalog_cartridges').update(payload).eq('id', s.id)
          : await sb.from('catalog_cartridges').insert(payload);
        if (res.error) throw res.error;
        ok(s ? 'Stage updated.' : 'Stage added.');
        closeModal();
        navigate('cartridges');
      } catch (e) {
        err(explain(e));
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  }

  // ============================================================
  // PAYMENT METHODS  (needs admin-grants.sql)
  // ============================================================
  SECTIONS.payments = async () => {
    const { data, error } = await sb.from('payment_methods').select('*').order('sort_order');
    if (error) throw error;
    view().innerHTML = `
      ${grantsNotice('payment_methods')}
      <div class="section-head"><h3>${data.length} method(s)</h3>
        <div class="toolbar"><button class="btn primary" id="newPay">+ New method</button></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Order</th><th>Name</th><th>Key</th><th>Account</th><th>Active</th><th></th></tr></thead>
        <tbody>${
          data
            .map(
              (p) => `<tr>
          <td>${p.sort_order}</td>
          <td><b>${esc(p.name)}</b><div class="subtle">${esc(p.secondary || '')}</div></td>
          <td class="mono">${esc(p.key)}</td>
          <td>${esc(p.account)}</td>
          <td>${p.active ? '<span class="badge green">Yes</span>' : '<span class="badge gray">No</span>'}</td>
          <td class="actions"><button class="btn ghost small" data-edit="${p.id}">Edit</button></td></tr>`,
            )
            .join('') || '<tr><td colspan="6" class="empty">No payment methods.</td></tr>'
        }</tbody></table></div>`;
    $('#newPay').addEventListener('click', () => editPayment());
    view()
      .querySelectorAll('[data-edit]')
      .forEach((b) =>
        b.addEventListener('click', () => editPayment(data.find((p) => p.id === b.dataset.edit))),
      );
  };

  async function editPayment(p) {
    const out = await formModal({
      title: p ? 'Edit payment method' : 'New payment method',
      fields: [
        { name: 'key', label: 'Key (stored on orders)', required: true, value: p?.key, placeholder: 'vodafone_cash' },
        { name: 'name', label: 'Display name', required: true, value: p?.name, placeholder: 'Vodafone Cash' },
        { name: 'account', label: 'Account / number', required: true, value: p?.account },
        { name: 'secondary', label: 'Secondary line', value: p?.secondary },
        { name: 'instructions', label: 'Instructions', type: 'textarea', value: p?.instructions },
        { name: 'sort_order', label: 'Sort order', type: 'number', value: p?.sort_order ?? 0 },
        { name: 'active', label: 'Active', type: 'checkbox', value: p ? p.active : true },
      ],
    });
    if (!out) return;
    const res = p
      ? await sb.from('payment_methods').update(out).eq('id', p.id)
      : await sb.from('payment_methods').insert(out);
    if (res.error) return err(explain(res.error));
    ok(p ? 'Method updated.' : 'Method created.');
    navigate('payments');
  }

  // ============================================================
  // BROADCASTS
  // ============================================================
  SECTIONS.broadcasts = async () => {
    const { data, error } = await sb
      .from('broadcasts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    view().innerHTML = `
      <div class="notice">A broadcast with audience <b>all</b> fans out a notification to every user's alert inbox.</div>
      <div class="section-head"><h3>${data.length} broadcast(s)</h3>
        <div class="toolbar"><button class="btn primary" id="newBroadcast">+ New broadcast</button></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Title</th><th>Body</th><th>Audience</th><th>Sent</th></tr></thead>
        <tbody>${
          data
            .map(
              (b) => `<tr><td><b>${esc(b.title)}</b></td><td class="subtle">${esc(b.body)}</td>
              <td>${esc(b.audience)}</td><td class="subtle">${fmtDate(b.created_at)}</td></tr>`,
            )
            .join('') || '<tr><td colspan="4" class="empty">No broadcasts yet.</td></tr>'
        }</tbody></table></div>`;
    $('#newBroadcast').addEventListener('click', async () => {
      const out = await formModal({
        title: 'New broadcast',
        submitLabel: 'Send',
        fields: [
          { name: 'title', label: 'Title', required: true },
          { name: 'body', label: 'Body', type: 'textarea', required: true },
          { name: 'link_target', label: 'Link target (optional)', placeholder: '/shop' },
          {
            name: 'audience',
            label: 'Audience',
            type: 'select',
            options: [{ value: 'all', label: 'All users' }],
            value: 'all',
          },
        ],
      });
      if (!out) return;
      const { error: e } = await sb.from('broadcasts').insert(out);
      if (e) return err(explain(e));
      ok('Broadcast sent.');
      navigate('broadcasts');
    });
  };

  // ============================================================
  // SUPPORT NOTES
  // ============================================================
  let supportCustomer = '';
  SECTIONS.support = async () => {
    view().innerHTML = `
      <div class="section-head"><h3>Customer support notes</h3></div>
      <div class="card" style="margin-bottom:16px">
        <div class="toolbar">
          <input class="search" id="custId" placeholder="Customer user ID (uuid)" value="${esc(supportCustomer)}" style="min-width:340px"/>
          <button class="btn primary" id="loadNotes">Load notes</button>
          <button class="btn ghost" id="addNote" ${supportCustomer ? '' : 'disabled'}>+ Add note</button>
        </div>
        <p class="subtle" style="margin:10px 0 0">Find a customer's user ID in the Users tab. Notes are admin-only and audited.</p>
      </div>
      <div id="notesWrap"></div>`;
    $('#custId').addEventListener('input', (e) => (supportCustomer = e.target.value.trim()));
    $('#loadNotes').addEventListener('click', () => loadNotes());
    $('#addNote').addEventListener('click', () => addNote());
    if (supportCustomer) loadNotes();
  };

  async function loadNotes() {
    if (!supportCustomer) return err('Enter a customer user ID.');
    const { data, error } = await sb
      .from('support_notes')
      .select('*')
      .eq('customer_id', supportCustomer)
      .order('created_at', { ascending: false });
    const wrap = $('#notesWrap');
    if (error) {
      wrap.innerHTML = `<div class="card"><p class="error">${esc(explain(error))}</p></div>`;
      return;
    }
    $('#addNote').disabled = false;
    wrap.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Note</th><th>Order</th><th>Added</th></tr></thead>
      <tbody>${
        (data || [])
          .map(
            (n) => `<tr><td>${esc(n.body)}</td><td class="mono">${n.order_id ? short(n.order_id) : '—'}</td>
            <td class="subtle">${fmtDate(n.created_at)}</td></tr>`,
          )
          .join('') || '<tr><td colspan="3" class="empty">No notes for this customer.</td></tr>'
      }</tbody></table></div>`;
  }

  async function addNote() {
    const out = await formModal({
      title: 'Add support note',
      fields: [
        { name: 'body', label: 'Note (PII-free)', type: 'textarea', required: true },
        { name: 'order_id', label: 'Related order ID (optional)' },
      ],
    });
    if (!out) return;
    const { error } = await sb.from('support_notes').insert({
      customer_id: supportCustomer,
      order_id: out.order_id || null,
      body: out.body,
      author_id: me.id,
    });
    if (error) return err(explain(error));
    ok('Note added.');
    loadNotes();
  }

  // ============================================================
  // AUDIT LOG
  // ============================================================
  let auditType = '';
  SECTIONS.audit = async () => {
    let q = sb.from('audit_log').select('*').order('created_at', { ascending: false }).limit(200);
    if (auditType) q = q.eq('target_type', auditType);
    const { data, error } = await q;
    if (error) throw error;
    const types = ['', 'user', 'order', 'product', 'note'];
    view().innerHTML = `
      <div class="notice">The audit log is append-only and server-written. You can read &amp; filter, never edit.</div>
      <div class="section-head"><h3>${data.length} entr(ies)</h3>
        <div class="toolbar"><select id="auditType">${types
          .map((t) => `<option value="${t}" ${t === auditType ? 'selected' : ''}>${t ? label(t) : 'All targets'}</option>`)
          .join('')}</select></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Target ID</th><th>Actor</th></tr></thead>
        <tbody>${
          data
            .map(
              (a) => `<tr>
          <td class="subtle">${fmtDate(a.created_at)}</td>
          <td><span class="badge blue">${esc(a.action)}</span></td>
          <td>${esc(a.target_type)}</td>
          <td class="mono">${esc(short(a.target_id))}</td>
          <td class="mono">${a.actor_id ? short(a.actor_id) : 'system'}</td></tr>`,
            )
            .join('') || '<tr><td colspan="5" class="empty">No audit entries.</td></tr>'
        }</tbody></table></div>`;
    $('#auditType').addEventListener('change', (e) => {
      auditType = e.target.value;
      navigate('audit');
    });
  };

  // grants notice for tables that need admin-grants.sql
  function grantsNotice() {
    return `<div class="notice">If this list is empty or saving fails with a permissions error, run
      <b>admin-grants.sql</b> once in the Supabase SQL editor to allow admins to manage this table.</div>`;
  }

  // go
  boot();
})();
