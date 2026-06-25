# AquaInfinity — Admin Console

A standalone web dashboard (HTML/CSS/JS, no build step) that talks directly to
your Supabase project to manage the app. Auth and every write are enforced
server-side by Row Level Security and the `is_admin()` / `set_user_role` guards —
a non-admin who signs in can see and do nothing.

## Run it

It's static files. Pick one:

- **Double-click** `admin/index.html` — works for everything except, on some
  browsers, the supabase-js CDN under the `file://` origin. If login fails, use a
  local server instead:
- **Local server** (recommended):
  ```bash
  cd admin
  python -m http.server 5173
  # open http://localhost:5173
  ```
  or `npx serve` / VS Code "Live Server".

Sign in with an **admin** account (one whose `profiles.role = 'admin'`). To make
your account an admin the first time, see Step 2 in `../supabase/SETUP.md`
(bootstrap grant). After that you can grant/revoke other admins from the **Users
& Admins** tab.

## What you can control

| Tab | Does | Works out of the box? |
|-----|------|------------------------|
| **Overview** | Order metrics: awaiting count, revenue, by-status, recent, admin count | ✅ |
| **Orders** | View orders + items; Confirm / Reject (with reason) / Out-for-delivery / Complete | ✅ |
| **Users & Admins** | List/search users; **grant / revoke admin** (guarded `set_user_role`, last-admin protected, audited) | ✅ |
| **Products** | Create / edit products; toggle availability | ✅ |
| **Broadcasts** | Send a push/alert to all users; view past broadcasts | ✅ |
| **Support Notes** | Look up a customer (by user ID) and add admin-only notes | ✅ |
| **Audit Log** | Read + filter the append-only audit trail | ✅ |
| **Filter Catalog** | Create / edit filter models (specs, image, QR code, interval) | ⚠️ needs `admin-grants.sql` |
| **Cartridges** | Manage the cartridge stages per model | ⚠️ needs `admin-grants.sql` |
| **Payment Methods** | Add / edit Vodafone Cash / InstaPay etc. | ⚠️ needs `admin-grants.sql` |

### Enabling the last three tabs

`filter_catalog`, `catalog_cartridges`, and `payment_methods` ship read-only to
clients. To let admins manage them from the console, run **`admin-grants.sql`**
once in the Supabase SQL editor (Dashboard → SQL). It only adds `is_admin()`-gated
policies and is safe to re-run. Until then those tabs can read but saving shows a
permissions notice.

## Roles: admin vs head admin

There are two admin tiers: **admin** and **head admin** (`user < admin < head_admin`).

- **Head admins** can do everything, **plus** grant/revoke the admin role from the
  **Users & Admins** tab.
- **Regular admins** can manage orders, products, catalog, etc., but the
  grant/revoke controls are hidden for them — only head admins assign admins.
- **Head admins are protected**: they can't be demoted or removed from the console
  (the row shows 🔒). Promote/demote head admins via SQL only.

To enable this, run **`admin-roles-and-uploads.sql`** once in the Supabase SQL
editor, then run its **Part 4** block (uncomment it and put your email in) to make
your account a head admin. Until that SQL is applied, the console falls back to the
old behaviour (any admin can manage roles).

## Image uploads (products & cartridges)

The Product and Cartridge editors let you **upload multiple pictures** (drag the
files in via the “+ Add” tile; remove any with ×). They upload to the public
`product-images` storage bucket and are saved as an `image_paths[]` array; the
first image is mirrored into `products.image_path` for the Flutter app. This needs
the same **`admin-roles-and-uploads.sql`** (it creates the bucket + admin write
policy and adds the `image_paths` columns).

## Filter product bundles (cartridges inside a filter)

When a product's **Category = filter**, the editor shows a **“Cartridges in this
filter”** section: pick the **cartridge-type products** the filter is built from,
each with a stage #, quantity, and optional note. The products list shows a
`🧩 N` badge with the part count on filter products. This needs
**`admin-product-bundles.sql`** run once (creates the `product_components` link
table + admin policies). Tip: create your cartridge products first, then build
the filter and add them.

## Configuration

`config.js` holds the project URL + **anon** key (the same public pair the Flutter
app ships). The anon key is safe in a browser — RLS does the protection. Point the
console at a different project by editing those two values.

## Security notes

- All admin gating is server-side (`is_admin()` RLS + `set_user_role` RPC with a
  last-admin guard). The UI just reflects what the backend allows; it never grants
  access by itself.
- Sensitive actions (grant/revoke admin, reject order) ask for confirmation.
- No service-role key is used or needed here — only the public anon key.
