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
    if (/product_components|relation .* does not exist/i.test(m))
      return 'Run admin-product-bundles.sql once to enable filter cartridge bundles.';
    if (/foreign key|still referenced|violates foreign/i.test(m))
      return "Can't delete — it's still referenced (e.g. by existing orders or registered filters). Mark it unavailable / inactive instead.";
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

  // Insert/update a row, returning {data,error}. If the optional `image_paths`
  // column isn't present yet (admin-roles-and-uploads.sql not applied), retry
  // without it so saving still works (just without the extra images).
  async function persistRow({ table, payload, id }) {
    const run = (pl) =>
      id
        ? sb.from(table).update(pl).eq('id', id).select().single()
        : sb.from(table).insert(pl).select().single();
    let res = await run(payload);
    if (
      res.error &&
      'image_paths' in payload &&
      /image_paths/i.test(`${res.error.message || ''} ${res.error.details || ''}`)
    ) {
      const { image_paths, ...rest } = payload;
      res = await run(rest);
    }
    return res;
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
    b.addEventListener('click', () => {
      navigate(b.dataset.section);
      $('.sidebar').classList.remove('nav-open'); // close the mobile menu
    }),
  );
  $('#refresh').addEventListener('click', () => navigate(current));
  $('#navToggle').addEventListener('click', () =>
    $('.sidebar').classList.toggle('nav-open'),
  );

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
          <td data-label="Order">${idChip(r.id, 'order ID')}</td>
          <td data-label="Status">${statusBadge(r.status)}</td>
          <td data-label="Total">${egp(r.total_minor)}</td>
          <td data-label="Created" class="subtle">${fmtDate(r.created_at)}</td></tr>`,
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
      <div class="table-wrap cards" style="margin-top:18px">
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
      <div class="table-wrap cards"><table>
        <thead><tr><th>Order</th><th>Status</th><th>Items</th><th>Total</th><th>Method</th><th>Created</th><th></th></tr></thead>
        <tbody>${
          orders
            .map(
              (o) => `<tr>
          <td data-label="Order">${idChip(o.id, 'order ID')}</td>
          <td data-label="Status">${statusBadge(o.status)}</td>
          <td data-label="Items">${counts[o.id] || 0}</td>
          <td data-label="Total"><b>${egp(o.total_minor)}</b></td>
          <td data-label="Method" class="subtle">${esc(label(o.payment_method))}</td>
          <td data-label="Created" class="subtle">${fmtDate(o.created_at)}</td>
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
          `<tr><td data-label="Item">${esc(i.name_snapshot)}</td><td data-label="Qty">×${i.quantity}</td><td data-label="Line">${egp(i.unit_price_minor * i.quantity)}</td></tr>`,
      )
      .join('');

    // Receipt: mint a short-lived signed URL. Admins may read the private
    // `receipts` bucket via the "admin read receipts" storage policy.
    let receiptUrl = null;
    if (o.receipt_path) {
      const { data: signed } = await sb.storage
        .from('receipts')
        .createSignedUrl(o.receipt_path, 3600);
      receiptUrl = (signed && signed.signedUrl) || null;
    }
    const receiptHTML =
      o.payment_method === 'cash_on_delivery'
        ? '<p class="subtle">Cash on delivery — no receipt to upload.</p>'
        : !o.receipt_path
          ? '<p class="subtle">No receipt uploaded yet.</p>'
          : receiptUrl
            ? `<a href="${esc(receiptUrl)}" target="_blank" rel="noopener">
                 <img src="${esc(receiptUrl)}" alt="payment receipt"
                      style="max-width:100%;border-radius:8px;border:1px solid var(--line);display:block"/></a>
               <div style="margin-top:8px"><a class="btn ghost small" href="${esc(receiptUrl)}"
                  target="_blank" rel="noopener" download>⬇ Open / download receipt</a></div>`
            : `<p class="error">Couldn't load the receipt — run the "admin read receipts"
                 storage policy once (see the note in app.js / SETUP.md).</p>`;

    // Customer identity (for the invoice) — best effort via the admin_users view.
    let customer = null;
    if (o.user_id) {
      const { data: cu } = await sb
        .from('admin_users')
        .select('identity')
        .eq('id', o.user_id)
        .maybeSingle();
      customer = (cu && cu.identity) || null;
    }

    // Google Maps: exact pin when the customer shared GPS, else a cleaned
    // address search (drop the trailing "· ☎ phone" so geocoding is better).
    const hasPin = o.delivery_lat != null && o.delivery_lng != null;
    const mapsUrl = hasPin
      ? `https://www.google.com/maps/search/?api=1&query=${o.delivery_lat},${o.delivery_lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery(o.delivery_snapshot))}`;

    modal({
      title: `Order ${short(o.id)}`,
      bodyHTML: `
        <dl class="detail-list">
          <dt>Order ID</dt><dd>${idChip(o.id, 'order ID')}</dd>
          <dt>Status</dt><dd>${statusBadge(o.status)}</dd>
          <dt>Total</dt><dd><b>${egp(o.total_minor)}</b> (subtotal ${egp(o.subtotal_minor)} + delivery ${egp(o.delivery_fee_minor)})</dd>
          <dt>Payment</dt><dd>${esc(label(o.payment_method))}</dd>
          <dt>Delivery</dt><dd>${esc(o.delivery_snapshot || '—')}
            <div style="margin-top:6px">
              <a class="btn ghost small" href="${mapsUrl}" target="_blank" rel="noopener">📍 ${hasPin ? 'Open location pin' : 'Find address'} in Google Maps</a>
              ${hasPin ? '' : '<span class="subtle" style="margin-left:6px">no GPS — address search</span>'}
            </div></dd>
          <dt>Created</dt><dd>${fmtDate(o.created_at)}</dd>
          ${o.rejection_reason ? `<dt>Rejection</dt><dd>${esc(o.rejection_reason)}</dd>` : ''}
        </dl>
        <div style="margin-top:8px"><b>Payment receipt</b>
          <div style="margin-top:6px">${receiptHTML}</div></div>
        <div class="table-wrap cards" style="margin-top:12px"><table>
          <thead><tr><th>Item</th><th>Qty</th><th>Line</th></tr></thead>
          <tbody>${lines || '<tr><td colspan="3" class="empty">No items.</td></tr>'}</tbody></table></div>`,
      footHTML: `<button class="btn ghost" data-invoice>🧾 Download invoice (PDF)</button>${orderActions(o)}`,
    });
    const invBtn = document.querySelector('[data-invoice]');
    if (invBtn)
      invBtn.addEventListener('click', () => downloadInvoicePdf(o, items || [], customer));
    wireOrderActions(o);
  }

  // Cleans a delivery snapshot for a Google Maps query (drops the "· ☎ phone"
  // tail so the geocoder gets just the address).
  function mapsQuery(snapshot) {
    return String(snapshot || '').split('·')[0].trim();
  }

  // Builds and downloads a full PDF invoice for the order (jsPDF + autotable).
  // Includes the customer, full delivery details, line items and totals.
  function downloadInvoicePdf(o, items, customer) {
    const JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDF) return err('PDF library not loaded — hard-refresh the page and retry.');
    const doc = new JsPDF({ unit: 'pt', format: 'a4' });
    const M = 40;
    const RX = doc.internal.pageSize.getWidth() - M;

    // Header
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(14, 165, 233);
    doc.text('AquaInfinity', M, 52);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text('Water filtration & accessories', M, 66);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('INVOICE', RX, 52, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('#' + short(o.id), RX, 66, { align: 'right' });
    doc.setDrawColor(226, 232, 240);
    doc.line(M, 84, RX, 84);

    // Meta (label : value), wrapping the address
    let y = 104;
    const meta = [
      ['Order', '#' + short(o.id)],
      ['Date', fmtDate(o.created_at)],
      ['Status', label(o.status)],
      ['Payment', label(o.payment_method)],
      ['Customer', customer || o.user_id || '—'],
      ['Deliver to', o.delivery_snapshot || '—'],
    ];
    doc.setFontSize(10);
    meta.forEach(([k, v]) => {
      doc.setTextColor(100, 116, 139);
      doc.text(k, M, y);
      doc.setTextColor(15, 23, 42);
      const lines = doc.splitTextToSize(String(v), RX - M - 90);
      doc.text(lines, M + 90, y);
      y += 14 * lines.length + 2;
    });

    // Items table
    doc.autoTable({
      startY: y + 8,
      margin: { left: M, right: M },
      head: [['Item', 'Qty', 'Unit', 'Total']],
      body: (items || []).map((i) => [
        i.name_snapshot,
        String(i.quantity),
        egp(i.unit_price_minor),
        egp(i.unit_price_minor * i.quantity),
      ]),
      styles: { fontSize: 10, cellPadding: 6 },
      headStyles: { fillColor: [14, 165, 233], textColor: 255 },
      columnStyles: { 1: { halign: 'center' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    });

    // Totals
    let ty = (doc.lastAutoTable ? doc.lastAutoTable.finalY : y) + 22;
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text('Subtotal: ' + egp(o.subtotal_minor), RX, ty, { align: 'right' });
    ty += 16;
    doc.text('Delivery: ' + egp(o.delivery_fee_minor), RX, ty, { align: 'right' });
    ty += 18;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text('Total: ' + egp(o.total_minor), RX, ty, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text('Thank you for choosing AquaInfinity.', M, ty + 30);

    doc.save(`invoice-${short(o.id)}.pdf`);
  }

  function orderActions(o) {
    const close = '<button class="btn ghost" data-close>Close</button>';
    if (o.status === 'awaiting_approval' || o.status === 'pending_payment')
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
        const { data, error } = await sb
          .from('orders')
          .update(patch)
          .eq('id', o.id)
          .select();
        if (error) return err(explain(error));
        if (!data || data.length === 0) {
          return err(
            "Status didn't change — the update was blocked. Re-run the order-status policy + enum fix (admin-order-fix.sql).",
          );
        }
        ok(`Order ${short(o.id)} → ${label(data[0].status)}`);
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
      <div class="table-wrap cards"><table>
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
              const notesBtn = `<button class="btn ghost small" data-notes="${u.id}" data-email="${esc(
                u.identity,
              )}">🛟 Notes</button>`;
              return `<tr>
            <td data-label="Identity">${esc(u.identity)}</td>
            <td data-label="Role">${roleBadge(u.role)}</td>
            <td data-label="User ID">${idChip(u.id)}</td>
            <td data-label="Joined" class="subtle">${fmtDate(u.created_at)}</td>
            <td class="actions">${notesBtn} ${action}</td></tr>`;
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
    // Jump straight to this customer's support notes (pre-filled).
    view()
      .querySelectorAll('[data-notes]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          supportCustomer = b.dataset.notes;
          supportEmail = b.dataset.email;
          navigate('support');
        }),
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
    const partCounts = {};
    try {
      const { data: comps } = await sb.from('product_components').select('filter_product_id');
      (comps || []).forEach((c) => {
        partCounts[c.filter_product_id] = (partCounts[c.filter_product_id] || 0) + 1;
      });
    } catch (_) {
      /* table may not exist yet */
    }
    view().innerHTML = `
      <div class="section-head"><h3>${products.length} product(s)</h3>
        <div class="toolbar"><button class="btn primary" id="newProduct">+ New product</button></div></div>
      <div class="table-wrap cards"><table>
        <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Available</th><th></th></tr></thead>
        <tbody>${
          products
            .map(
              (p) => `<tr>
          <td data-label="Name"><div class="cell-img">${imgTag(firstImage(p))}<div><b>${esc(p.name)}</b><div class="subtle">${esc(p.description || '')}</div></div></div></td>
          <td data-label="Category">${esc(label(p.category))}${p.category === 'filter' ? ` <span class="badge cyan">🧩 ${partCounts[p.id] || 0}</span>` : ''}</td>
          <td data-label="Price">${egp(p.price_minor)}</td>
          <td data-label="Available">${p.available ? '<span class="badge green">Yes</span>' : '<span class="badge red">Sold out</span>'}</td>
          <td class="actions">
            <button class="btn ghost small" data-toggle="${p.id}">${p.available ? 'Mark sold out' : 'Mark available'}</button>
            <button class="btn ghost small" data-edit="${p.id}">Edit</button>
            <button class="btn danger small" data-del="${p.id}">Delete</button>
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
    view()
      .querySelectorAll('[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          const p = products.find((x) => x.id === b.dataset.del);
          const yes = await confirmModal({
            title: 'Delete product',
            message: `Delete <b>${esc(p.name)}</b>? This can't be undone.`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!yes) return;
          const { data: del, error: e } = await sb
            .from('products')
            .delete()
            .eq('id', p.id)
            .select();
          if (e) return err(explain(e));
          if (!del || del.length === 0)
            return err(
              "Couldn't delete — it's referenced by an existing order, or the delete policy isn't applied (run admin-deletes.sql).",
            );
          ok('Product deleted.');
          navigate('products');
        }),
      );
  };

  async function editProduct(p) {
    // Cartridge-type products available to bundle into a filter, + existing parts.
    let cartridgeProducts = [];
    try {
      const { data } = await sb
        .from('products')
        .select('id,name,price_minor')
        .eq('category', 'cartridge')
        .order('name');
      cartridgeProducts = data || [];
    } catch (_) {
      /* ignore */
    }
    const cpMap = Object.fromEntries(cartridgeProducts.map((c) => [c.id, c]));

    let components = [];
    if (p && p.category === 'filter') {
      const { data } = await sb
        .from('product_components')
        .select('*')
        .eq('filter_product_id', p.id)
        .order('stage_index');
      components = (data || []).map((c) => ({
        cartridge_product_id: c.cartridge_product_id,
        name: cpMap[c.cartridge_product_id]?.name || '(removed product)',
        price_minor: cpMap[c.cartridge_product_id]?.price_minor || 0,
        stage_index: c.stage_index,
        quantity: c.quantity,
        note: c.note,
      }));
    }

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
        <div class="field" id="pFilterSection"><b>Cartridges in this filter</b>
          <div id="pComponents"></div>
          <span class="subtle">Pick the cartridge products this filter is built from (needs admin-product-bundles.sql).</span></div>
      </form>`,
      footHTML: `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pSave">Save</button>`,
    });
    const gallery = mountGallery($('#pGallery'), p?.image_paths || (p?.image_path ? [p.image_path] : []));
    const form = $('#pForm');
    const val = (n) => form.querySelector(`[name="${n}"]`);
    const section = $('#pFilterSection');
    const compRoot = $('#pComponents');

    function renderComponents() {
      const sel = cartridgeProducts
        .map((cp) => `<option value="${cp.id}">${esc(cp.name)} — ${egp(cp.price_minor)}</option>`)
        .join('');
      compRoot.innerHTML = `
        <div class="comp-list">${
          components.length
            ? components
                .map(
                  (c, i) => `<div class="comp-row">
            <span>${c.stage_index ? `<b>#${c.stage_index}</b> ` : ''}${esc(c.name)}
              <span class="subtle">×${c.quantity}${c.note ? ` · ${esc(c.note)}` : ''}</span></span>
            <button type="button" class="btn ghost small" data-rmcomp="${i}">Remove</button></div>`,
                )
                .join('')
            : '<div class="subtle">No cartridges added yet.</div>'
        }</div>
        <div class="comp-add">
          <select id="compPick">${sel || '<option value="">No cartridge products yet — create some first</option>'}</select>
          <input id="compStage" type="number" placeholder="Stage #"/>
          <input id="compQty" type="number" placeholder="Qty" value="1"/>
          <input id="compNote" placeholder="Note (optional)"/>
          <button type="button" class="btn primary small" id="compAdd" ${cartridgeProducts.length ? '' : 'disabled'}>Add</button>
        </div>`;
      compRoot.querySelectorAll('[data-rmcomp]').forEach((b) =>
        b.addEventListener('click', () => {
          components.splice(Number(b.dataset.rmcomp), 1);
          renderComponents();
        }),
      );
      const addBtn = compRoot.querySelector('#compAdd');
      if (addBtn)
        addBtn.addEventListener('click', () => {
          const id = compRoot.querySelector('#compPick').value;
          if (!id) return;
          if (components.some((c) => c.cartridge_product_id === id))
            return err('That cartridge is already added.');
          const cp = cpMap[id];
          const stage = compRoot.querySelector('#compStage').value;
          const qty = compRoot.querySelector('#compQty').value;
          const note = compRoot.querySelector('#compNote').value.trim();
          components.push({
            cartridge_product_id: id,
            name: cp.name,
            price_minor: cp.price_minor,
            stage_index: stage ? Number(stage) : null,
            quantity: qty ? Number(qty) : 1,
            note: note || null,
          });
          renderComponents();
        });
    }

    function syncSection() {
      section.style.display = val('category').value === 'filter' ? '' : 'none';
    }
    val('category').addEventListener('change', syncSection);
    syncSection();
    renderComponents();

    $('#pSave').addEventListener('click', async () => {
      const name = val('name').value.trim();
      if (!name) return err('Name is required');
      const btn = $('#pSave');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const newUrls = await uploadFiles(gallery.files(), 'products');
        const images = [...gallery.kept(), ...newUrls];
        const isFilter = val('category').value === 'filter';
        const payload = {
          name,
          description: val('description').value.trim() || null,
          price_minor: Math.round(Number(val('price_egp').value || 0) * 100),
          category: val('category').value,
          available: val('available').checked,
          image_paths: images,
          image_path: images[0] || null,
        };
        const res = await persistRow({
          table: 'products',
          payload,
          id: p ? p.id : undefined,
        });
        if (res.error) throw res.error;
        const productId = res.data.id;
        // Sync the bundle (delete-all + re-insert) for filter products. Only
        // surface a bundles-table error when parts were actually added.
        if (isFilter) {
          const delRes = await sb
            .from('product_components')
            .delete()
            .eq('filter_product_id', productId);
          if (delRes.error && components.length) throw delRes.error;
          if (components.length) {
            const { error: insErr } = await sb.from('product_components').insert(
              components.map((c) => ({
                filter_product_id: productId,
                cartridge_product_id: c.cartridge_product_id,
                stage_index: c.stage_index,
                quantity: c.quantity,
                note: c.note,
              })),
            );
            if (insErr) throw insErr;
          }
        } else {
          // Best-effort: drop stale parts if this product is no longer a filter.
          await sb.from('product_components').delete().eq('filter_product_id', productId);
        }
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
      <div class="table-wrap cards"><table>
        <thead><tr><th>Name</th><th>Spec</th><th>Stages</th><th>Capacity</th><th>Lifespan</th><th>QR code</th><th>Active</th><th></th></tr></thead>
        <tbody>${
          data
            .map(
              (m) => `<tr>
          <td data-label="Name"><b>${esc(m.name)}</b></td>
          <td data-label="Spec" class="subtle">${esc(m.description || '—')}</td>
          <td data-label="Stages">${m.stage_count ?? '—'}</td>
          <td data-label="Capacity">${m.capacity_liters ? m.capacity_liters + ' L' : '—'}</td>
          <td data-label="Lifespan">${m.replacement_interval_days ? m.replacement_interval_days + ' d' : '—'}</td>
          <td data-label="QR code" class="mono">${esc(m.qr_code || '—')}</td>
          <td data-label="Active">${m.active ? '<span class="badge green">Yes</span>' : '<span class="badge gray">No</span>'}</td>
          <td class="actions"><button class="btn ghost small" data-edit="${m.id}">Edit</button>
            <button class="btn ghost small" data-stages="${m.id}" data-name="${esc(m.name)}">Stages</button>
            <button class="btn danger small" data-del="${m.id}">Delete</button></td></tr>`,
            )
            .join('') || '<tr><td colspan="8" class="empty">No catalog models.</td></tr>'
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
    view()
      .querySelectorAll('[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          const m = data.find((x) => x.id === b.dataset.del);
          const yes = await confirmModal({
            title: 'Delete filter model',
            message: `Delete <b>${esc(m.name)}</b> and its cartridge stages? This can't be undone.`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!yes) return;
          const { data: del, error: e } = await sb
            .from('filter_catalog')
            .delete()
            .eq('id', m.id)
            .select();
          if (e) return err(explain(e));
          if (!del || del.length === 0)
            return err(
              "Couldn't delete — it's in use by a registered filter, or the manage-catalog policy isn't applied (run admin-grants.sql).",
            );
          ok('Filter model deleted.');
          navigate('catalog');
        }),
      );
  };

  async function editModel(m) {
    const out = await formModal({
      title: m ? 'Edit model' : 'New filter model',
      fields: [
        { name: 'name', label: 'Name', required: true, value: m?.name },
        { name: 'description', label: 'Spec sublabel', placeholder: '6-stage RO filter', value: m?.description },
        { name: 'stage_count', label: 'Stage count', type: 'number', required: true, value: m?.stage_count, help: 'Number of cartridge stages.' },
        { name: 'capacity_liters', label: 'Capacity (L)', type: 'number', required: true, value: m?.capacity_liters, help: 'Rated liters over the lifespan — drives Water Purified & Total Filtered.' },
        { name: 'replacement_interval_days', label: 'Lifespan (days)', type: 'number', required: true, value: m?.replacement_interval_days, help: 'Days the filter lasts (e.g. 1000) — drives Filter Health & Days Left. The clock resets when cartridges are changed.' },
        { name: 'bacteria_per_liter', label: 'Bacteria blocked / L', type: 'number', step: 'any', required: true, value: m?.bacteria_per_liter, help: 'Bacteria removed per liter — drives the Bacteria Blocked stat (rate × liters).' },
        { name: 'chemicals_mg_per_liter', label: 'Chemicals removed (mg / L)', type: 'number', step: 'any', required: true, value: m?.chemicals_mg_per_liter, help: 'Milligrams of chemicals removed per liter — drives Chemicals Filtered.' },
        { name: 'kwh_per_liter', label: 'Energy saved (kWh / L)', type: 'number', step: 'any', required: true, value: m?.kwh_per_liter, help: 'kWh saved per liter — drives Energy Saved.' },
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
      <div class="table-wrap cards"><table>
        <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Lifespan</th><th>Capacity</th><th>Micron</th><th></th></tr></thead>
        <tbody>${
          stages
            .map(
              (s) => `<tr>
          <td data-label="Stage"><b>${s.stage_index}</b></td>
          <td data-label="Name"><div class="cell-img">${imgTag(firstImage(s))}<div>${esc(s.name)}<div class="subtle">${esc(s.about || '')}</div></div></div></td>
          <td data-label="Type" class="subtle">${esc(s.type || '—')}</td>
          <td data-label="Lifespan">${s.lifespan_days ? s.lifespan_days + ' d' : '—'}</td>
          <td data-label="Capacity">${s.capacity_liters ? s.capacity_liters + ' L' : '—'}</td>
          <td data-label="Micron">${s.micron ?? '—'}</td>
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
          const { data: del, error } = await sb
            .from('catalog_cartridges')
            .delete()
            .eq('id', b.dataset.del)
            .select();
          if (error) return err(explain(error));
          if (!del || del.length === 0)
            return err(
              "Couldn't delete — the manage-cartridges policy isn't applied (run admin-grants.sql).",
            );
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
        const res = await persistRow({
          table: 'catalog_cartridges',
          payload,
          id: s ? s.id : undefined,
        });
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
      <div class="table-wrap cards"><table>
        <thead><tr><th>Order</th><th>Name</th><th>Key</th><th>Account</th><th>Active</th><th></th></tr></thead>
        <tbody>${
          data
            .map(
              (p) => `<tr>
          <td data-label="Sort">${p.sort_order}</td>
          <td data-label="Name"><b>${esc(p.name)}</b><div class="subtle">${esc(p.secondary || '')}</div></td>
          <td data-label="Key" class="mono">${esc(p.key)}</td>
          <td data-label="Account">${esc(p.account)}</td>
          <td data-label="Active">${p.active ? '<span class="badge green">Yes</span>' : '<span class="badge gray">No</span>'}</td>
          <td class="actions"><button class="btn ghost small" data-edit="${p.id}">Edit</button>
            <button class="btn danger small" data-del="${p.id}">Delete</button></td></tr>`,
            )
            .join('') || '<tr><td colspan="6" class="empty">No payment methods.</td></tr>'
        }</tbody></table></div>`;
    $('#newPay').addEventListener('click', () => editPayment());
    view()
      .querySelectorAll('[data-edit]')
      .forEach((b) =>
        b.addEventListener('click', () => editPayment(data.find((p) => p.id === b.dataset.edit))),
      );
    view()
      .querySelectorAll('[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          const p = data.find((x) => x.id === b.dataset.del);
          const yes = await confirmModal({
            title: 'Delete payment method',
            message: `Delete <b>${esc(p.name)}</b>?`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!yes) return;
          const { data: del, error: e } = await sb
            .from('payment_methods')
            .delete()
            .eq('id', p.id)
            .select();
          if (e) return err(explain(e));
          if (!del || del.length === 0)
            return err(
              "Couldn't delete — the manage-payment-methods policy isn't applied (run admin-deletes.sql / admin-grants.sql).",
            );
          ok('Payment method deleted.');
          navigate('payments');
        }),
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
      <div class="table-wrap cards"><table>
        <thead><tr><th>Title</th><th>Body</th><th>Audience</th><th>Sent</th><th></th></tr></thead>
        <tbody>${
          data
            .map(
              (b) => `<tr><td data-label="Title"><b>${esc(b.title)}</b></td><td data-label="Body" class="subtle">${esc(b.body)}</td>
              <td data-label="Audience">${esc(b.audience)}</td><td data-label="Sent" class="subtle">${fmtDate(b.created_at)}</td>
              <td class="actions"><button class="btn danger small" data-del="${b.id}">Delete</button></td></tr>`,
            )
            .join('') || '<tr><td colspan="5" class="empty">No broadcasts yet.</td></tr>'
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
    view()
      .querySelectorAll('[data-del]')
      .forEach((btn) =>
        btn.addEventListener('click', async () => {
          const b = data.find((x) => x.id === btn.dataset.del);
          const yes = await confirmModal({
            title: 'Delete broadcast',
            message: `Delete <b>${esc(b.title)}</b>? (Alerts already sent to users stay in their inboxes.)`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!yes) return;
          const { data: del, error: e } = await sb
            .from('broadcasts')
            .delete()
            .eq('id', b.id)
            .select();
          if (e) return err(explain(e));
          if (!del || del.length === 0)
            return err(
              "Couldn't delete — the broadcast delete policy isn't applied (run admin-deletes.sql).",
            );
          ok('Broadcast deleted.');
          navigate('broadcasts');
        }),
      );
  };

  // ============================================================
  // SERVICE REQUESTS
  // ============================================================
  let serviceStatus = 'open';
  const svcBadge = (s) =>
    s === 'open'
      ? '<span class="badge amber">Open</span>'
      : s === 'in_progress'
        ? '<span class="badge blue">In progress</span>'
        : '<span class="badge green">Resolved</span>';
  SECTIONS.service = async () => {
    let q = sb
      .from('service_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(300);
    if (serviceStatus) q = q.eq('status', serviceStatus);
    const { data, error } = await q;
    if (error) throw error;
    // Resolve customer UUIDs to emails so requests read "who asked".
    const email = new Map();
    const { data: users } = await sb.from('admin_users').select('id, identity');
    (users || []).forEach((u) => email.set(u.id, u.identity));
    const filters = ['open', 'in_progress', 'resolved', ''];
    view().innerHTML = `
      <div class="notice">Customers raise these from the app when their filter health is low
        (≈15%). Move them <b>Open → In progress → Resolved</b> as you service the filter and
        replace cartridges.</div>
      <div class="section-head"><h3>${data.length} request(s)</h3>
        <div class="toolbar"><select id="svcStatus">${filters
          .map(
            (s) =>
              `<option value="${s}" ${s === serviceStatus ? 'selected' : ''}>${s ? label(s) : 'All'}</option>`,
          )
          .join('')}</select></div></div>
      <div class="table-wrap cards"><table>
        <thead><tr><th>When</th><th>Customer</th><th>Filter</th><th>Health</th><th>Note</th><th>Status</th><th></th></tr></thead>
        <tbody>${
          data
            .map(
              (r) => `<tr>
          <td data-label="When" class="subtle">${fmtDate(r.created_at)}</td>
          <td data-label="Customer">${email.has(r.user_id) ? esc(email.get(r.user_id)) : `<span class="mono">${short(r.user_id)}</span>`}</td>
          <td data-label="Filter" class="mono">${r.device_id ? short(r.device_id) : '—'}</td>
          <td data-label="Health">${r.health_percent != null ? r.health_percent + '%' : '—'}</td>
          <td data-label="Note">${esc(r.note || '—')}</td>
          <td data-label="Status">${svcBadge(r.status)}</td>
          <td class="actions">
            ${r.status === 'open' ? `<button class="btn ghost small" data-progress="${r.id}">Start</button>` : ''}
            ${r.status !== 'resolved' ? `<button class="btn primary small" data-resolve="${r.id}">Resolve</button>` : ''}
          </td></tr>`,
            )
            .join('') || '<tr><td colspan="7" class="empty">No service requests.</td></tr>'
        }</tbody></table></div>`;
    $('#svcStatus').addEventListener('change', (e) => {
      serviceStatus = e.target.value;
      navigate('service');
    });
    const setStatus = async (id, status) => {
      const patch = { status };
      if (status === 'resolved') patch.resolved_at = new Date().toISOString();
      const { data: upd, error: e } = await sb
        .from('service_requests')
        .update(patch)
        .eq('id', id)
        .select();
      if (e) return err(explain(e));
      if (!upd || upd.length === 0)
        return err(
          "Couldn't update — the admin policy isn't applied (run service-requests.sql).",
        );
      ok('Request updated.');
      navigate('service');
    };
    view()
      .querySelectorAll('[data-progress]')
      .forEach((b) =>
        b.addEventListener('click', () => setStatus(b.dataset.progress, 'in_progress')),
      );
    view()
      .querySelectorAll('[data-resolve]')
      .forEach((b) =>
        b.addEventListener('click', () => setStatus(b.dataset.resolve, 'resolved')),
      );
  };

  // ============================================================
  // SUPPORT NOTES
  // ============================================================
  let supportCustomer = ''; // selected customer's user ID (uuid)
  let supportEmail = ''; // their email/identity, for display
  SECTIONS.support = async () => {
    // Load the user directory so the admin can pick a customer by email
    // instead of hunting down and pasting a raw UUID.
    const { data: users, error: uErr } = await sb
      .from('admin_users')
      .select('id, identity')
      .order('identity');
    const directory = uErr ? [] : users || [];
    const byId = new Map(directory.map((u) => [u.id, u.identity]));
    if (supportCustomer && !supportEmail) supportEmail = byId.get(supportCustomer) || '';

    view().innerHTML = `
      <div class="section-head"><h3>Customer support notes</h3></div>
      <div class="card" style="margin-bottom:16px">
        <div class="toolbar">
          <input class="search" id="custPick" list="custList" autocomplete="off"
            placeholder="Search customer by email…" value="${esc(supportEmail || supportCustomer)}" style="min-width:340px"/>
          <datalist id="custList">${directory
            .map((u) => `<option value="${esc(u.identity)}"></option>`)
            .join('')}</datalist>
          <button class="btn primary" id="loadNotes">Load notes</button>
          <button class="btn ghost" id="addNote" ${supportCustomer ? '' : 'disabled'}>+ Add note</button>
        </div>
        <p class="subtle" style="margin:10px 0 0">Pick a customer by email (or paste their user ID). Notes are
          admin-only, PII-free, and audited.${
            uErr ? ' <span class="error">Couldn\'t load the customer list — paste a user ID instead.</span>' : ''
          }</p>
      </div>
      <div id="notesWrap"></div>`;

    const pick = $('#custPick');
    // Resolve whatever's typed to a (UUID, email) pair: an email match maps to
    // its UUID; anything else is treated as a raw UUID paste.
    const resolve = () => {
      const v = pick.value.trim();
      const hit = directory.find((u) => (u.identity || '').toLowerCase() === v.toLowerCase());
      if (hit) {
        supportCustomer = hit.id;
        supportEmail = hit.identity;
      } else {
        supportCustomer = v;
        supportEmail = byId.get(v) || '';
      }
    };
    pick.addEventListener('input', resolve);
    pick.addEventListener('change', resolve);
    pick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        resolve();
        loadNotes();
      }
    });
    $('#loadNotes').addEventListener('click', () => {
      resolve();
      loadNotes();
    });
    $('#addNote').addEventListener('click', () => addNote());
    if (supportCustomer) loadNotes();
  };

  async function loadNotes() {
    if (!supportCustomer) return err('Pick a customer (by email) or paste their user ID first.');
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
    const addBtn = $('#addNote');
    if (addBtn) addBtn.disabled = false;
    const who = supportEmail ? `${esc(supportEmail)} · ` : '';
    wrap.innerHTML = `<div class="card" style="margin-bottom:12px"><p class="subtle" style="margin:0">
        ${(data || []).length} note(s) for <b>${who}</b><span class="mono">${esc(short(supportCustomer))}</span></p></div>
      <div class="table-wrap cards"><table>
      <thead><tr><th>Note</th><th>Order</th><th>Added</th><th></th></tr></thead>
      <tbody>${
        (data || [])
          .map(
            (n) => `<tr><td data-label="Note">${esc(n.body)}</td><td data-label="Order" class="mono">${n.order_id ? short(n.order_id) : '—'}</td>
            <td data-label="Added" class="subtle">${fmtDate(n.created_at)}</td>
            <td class="actions"><button class="btn danger small" data-del="${n.id}">Delete</button></td></tr>`,
          )
          .join('') || '<tr><td colspan="4" class="empty">No notes for this customer.</td></tr>'
      }</tbody></table></div>`;
    wrap.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const yes = await confirmModal({
          title: 'Delete note',
          message: 'Delete this support note?',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!yes) return;
        const { data: del, error: e } = await sb
          .from('support_notes')
          .delete()
          .eq('id', btn.dataset.del)
          .select();
        if (e) return err(explain(e));
        if (!del || del.length === 0)
          return err(
            "Couldn't delete — the note delete policy isn't applied (run admin-safe-delete.sql).",
          );
        ok('Note deleted.');
        loadNotes();
      }),
    );
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
    // Resolve actor UUIDs to emails so the log reads "who did what".
    const actorEmail = new Map();
    const { data: actors } = await sb.from('admin_users').select('id, identity');
    (actors || []).forEach((u) => actorEmail.set(u.id, u.identity));
    const types = ['', 'user', 'order', 'product', 'note'];
    view().innerHTML = `
      <div class="notice">The audit log is append-only and server-written. You can read &amp; filter, never edit.</div>
      <div class="section-head"><h3>${data.length} entr(ies)</h3>
        <div class="toolbar"><select id="auditType">${types
          .map((t) => `<option value="${t}" ${t === auditType ? 'selected' : ''}>${t ? label(t) : 'All targets'}</option>`)
          .join('')}</select></div></div>
      <div class="table-wrap cards"><table>
        <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Target ID</th><th>Actor</th></tr></thead>
        <tbody>${
          data
            .map(
              (a) => `<tr>
          <td data-label="When" class="subtle">${fmtDate(a.created_at)}</td>
          <td data-label="Action"><span class="badge blue">${esc(a.action)}</span></td>
          <td data-label="Target">${esc(a.target_type)}</td>
          <td data-label="Target ID" class="mono">${esc(short(a.target_id))}</td>
          <td data-label="Actor">${
            a.actor_id
              ? actorEmail.has(a.actor_id)
                ? esc(actorEmail.get(a.actor_id))
                : `<span class="mono">${short(a.actor_id)}</span>`
              : 'system'
          }</td></tr>`,
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
