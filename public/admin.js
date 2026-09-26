// Admin panel: one page, views switched by the hash (#/<tenant>/<view>/<id>).
// All server data is inserted with textContent, never innerHTML.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { me: null, slug: null, userQuery: "" };
  const content = $("content");

  // ---------- helpers ----------

  async function api(method, path, body) {
    const res = await fetch(`/admin/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // empty or non-JSON body
    }
    if (res.status === 401 && path !== "/login") {
      state.me = null;
      showLogin();
    }
    return { status: res.status, ok: res.ok, data };
  }

  // h("tag.class", { text, on, attrs }, ...children)
  function h(spec, props = {}, ...children) {
    const [tag, ...classes] = spec.split(".");
    const node = document.createElement(tag);
    if (classes.length) node.className = classes.join(" ");
    if (props.text !== undefined) node.textContent = props.text;
    for (const [name, value] of Object.entries(props.attrs || {})) {
      if (value !== undefined && value !== null && value !== false) node.setAttribute(name, value === true ? "" : value);
    }
    for (const [event, fn] of Object.entries(props.on || {})) node.addEventListener(event, fn);
    for (const child of children.flat()) if (child) node.append(child);
    return node;
  }

  const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
  const dateOnly = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
  const fmt = (value) => (value ? dateTime.format(new Date(value)) : "—");
  const fmtDate = (value) => (value ? dateOnly.format(new Date(value)) : "—");

  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.hidden = true;
    }, 2500);
  }

  const ERRORS = {
    invalid_credentials: "Wrong email or password.",
    too_many_attempts: "Too many failed attempts. Try again later.",
    insufficient_points: "The user does not have enough points.",
    invalid_amount: "Enter a whole number of points (not zero).",
    reason_required: "Please give a reason (at least 3 characters).",
    invalid_status: "This voucher can no longer be changed.",
    forbidden_setting: "Only a super admin can change this setting.",
    json_required: "Request must be JSON."
  };

  function errorText(data) {
    if (data.message) return `${data.key || data.field || "Value"}: ${data.message}`;
    if (data.error === "invalid_status" && data.status) return `This voucher is ${data.status} and can no longer be changed.`;
    return ERRORS[data.error] || "Something went wrong. Please try again.";
  }

  function table(headers, rows, emptyText) {
    const thead = h("thead", {}, h("tr", {}, headers.map(([label, cls]) => h(`th${cls ? `.${cls}` : ""}`, { text: label }))));
    const tbody = h("tbody");
    if (rows.length === 0) tbody.append(h("tr", {}, h("td.empty", { text: emptyText, attrs: { colspan: headers.length } })));
    for (const row of rows) tbody.append(row);
    return h("div.table-wrap", {}, h("table", {}, thead, tbody));
  }

  function amountCell(amount) {
    return h(`td.num.${amount > 0 ? "plus" : "minus"}`, { text: `${amount > 0 ? "+" : ""}${amount}` });
  }

  function pager(result, go) {
    return h(
      "div.pager",
      {},
      h("button.btn.ghost.small", { text: "Previous", attrs: { disabled: result.page <= 1 }, on: { click: () => go(result.page - 1) } }),
      h("span.muted", { text: `Page ${result.page}` }),
      h("button.btn.ghost.small", { text: "Next", attrs: { disabled: !result.has_more }, on: { click: () => go(result.page + 1) } })
    );
  }

  // Opens the shared dialog. onOk returns nothing to close, or throws a
  // message to show in the dialog.
  function openDialog({ title, body, okLabel = "Save", danger = false, onOk }) {
    const dialog = $("dialog");
    $("dialog-title").textContent = title;
    const bodyNode = $("dialog-body");
    bodyNode.replaceChildren(...body);
    $("dialog-error").textContent = "";
    const ok = $("dialog-ok");
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? "danger" : "primary"}`;
    ok.disabled = false;
    $("dialog-form").onsubmit = async (event) => {
      event.preventDefault();
      ok.disabled = true;
      try {
        await onOk();
        dialog.close();
      } catch (message) {
        $("dialog-error").textContent = String(message);
      } finally {
        ok.disabled = false;
      }
    };
    dialog.showModal();
    const first = bodyNode.querySelector("input, textarea, select");
    if (first) first.focus();
  }
  $("dialog-cancel").addEventListener("click", () => $("dialog").close());

  // ---------- login ----------

  function showLogin() {
    $("shell").hidden = true;
    $("login").hidden = false;
    $("login-email").focus();
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const res = await api("POST", "/login", { email: $("login-email").value, password: $("login-password").value });
    if (!res.ok) {
      $("login-error").textContent = errorText(res.data);
      return;
    }
    $("login-password").value = "";
    $("login-error").textContent = "";
    start(res.data);
  });

  $("logout").addEventListener("click", async () => {
    await api("POST", "/logout", {});
    state.me = null;
    location.hash = "";
    showLogin();
  });

  // ---------- shell and routing ----------

  function start(me) {
    state.me = me;
    $("login").hidden = true;
    $("shell").hidden = false;
    $("who").textContent = `${me.email} · ${me.role === "super_admin" ? "Super admin" : "Tenant admin"}`;
    const select = $("tenant-select");
    select.replaceChildren(...me.tenants.map((t) => h("option", { text: t.name, attrs: { value: t.slug } })));
    select.hidden = me.tenants.length < 2;
    route();
  }

  $("tenant-select").addEventListener("change", (event) => go(event.target.value, "users"));

  for (const link of document.querySelectorAll("#nav a")) {
    link.addEventListener("click", () => go(state.slug, link.dataset.view));
  }

  function go(slug, view, id) {
    const hash = `#/${slug}/${view}${id ? `/${id}` : ""}`;
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  async function route() {
    if (!state.me) return;
    const [, slug, view = "users", id] = location.hash.split("/");
    if (!state.me.tenants.some((t) => t.slug === slug)) {
      if (state.me.tenants.length === 0) {
        content.replaceChildren(h("p.muted", { text: "Your account has no active tenant." }));
        return;
      }
      return go(state.me.tenants[0].slug, "users");
    }
    state.slug = slug;
    $("tenant-select").value = slug;
    for (const link of document.querySelectorAll("#nav a")) {
      link.classList.toggle("active", link.dataset.view === view || (view === "user" && link.dataset.view === "users"));
    }
    content.replaceChildren(h("p.muted", { text: "Loading…" }));

    const views = { users: showUsers, user: showUser, ledger: showLedger, redemptions: showRedemptions, rewards: showRewards, settings: showSettings };
    await (views[view] || showUsers)(id);
  }

  const t = (path) => `/t/${state.slug}${path}`;

  // ---------- users ----------

  async function showUsers(_, page = 1) {
    const res = await api("GET", t(`/users?q=${encodeURIComponent(state.userQuery)}&page=${page}`));
    if (!res.ok) return;
    const search = h("input", { attrs: { type: "search", placeholder: "Search by phone or name", value: state.userQuery } });
    const form = h(
      "form.toolbar",
      {
        on: {
          submit: (event) => {
            event.preventDefault();
            state.userQuery = search.value.trim();
            showUsers(null, 1);
          }
        }
      },
      search,
      h("button.btn.primary", { text: "Search", attrs: { type: "submit" } })
    );
    const rows = res.data.items.map((u) =>
      h(
        "tr.clickable",
        { on: { click: () => go(state.slug, "user", u.id) } },
        h("td", { text: u.name || "—" }),
        h("td.code", { text: u.phone_e164 }),
        h("td", { text: u.category || "—" }),
        h("td.num", { text: String(u.balance) }),
        h("td", { text: fmtDate(u.created_at) })
      )
    );
    content.replaceChildren(
      h(
        "div.panel",
        {},
        h("h2", { text: "Users" }),
        form,
        table([["Name"], ["Phone"], ["Category"], ["Balance", "num"], ["Joined"]], rows, "No users found."),
        pager(res.data, (p) => showUsers(null, p))
      )
    );
  }

  async function showUser(id) {
    const res = await api("GET", t(`/users/${id}`));
    if (!res.ok) {
      content.replaceChildren(h("p.error", { text: "User not found." }));
      return;
    }
    const { user, balance, ledger, redemptions } = res.data;

    const amount = h("input", { attrs: { type: "number", step: "1", placeholder: "e.g. 50 or -20", "aria-label": "Points" } });
    const reason = h("input", { attrs: { type: "text", placeholder: "Reason (required)", maxlength: "200", "aria-label": "Reason" } });
    const error = h("p.error", { attrs: { role: "alert" } });
    const adjust = h(
      "form.adjust",
      {
        on: {
          submit: async (event) => {
            event.preventDefault();
            const r = await api("POST", t(`/users/${id}/adjust`), { amount: Number(amount.value), reason: reason.value });
            if (!r.ok) {
              error.textContent = errorText(r.data);
              return;
            }
            toast(`Adjusted by ${r.data.amount > 0 ? "+" : ""}${r.data.amount}. New balance ${r.data.balance}`);
            showUser(id);
          }
        }
      },
      amount,
      reason,
      h("button.btn.primary", { text: "Adjust points", attrs: { type: "submit" } })
    );

    const ledgerRows = ledger.map((l) =>
      h("tr", {}, h("td", { text: fmt(l.created_at) }), h("td", { text: l.type }), amountCell(l.amount), h("td", { text: fmtDate(l.expires_at) }))
    );
    const voucherRows = redemptions.map((r) =>
      h(
        "tr",
        {},
        h("td", { text: fmt(r.created_at) }),
        h("td", { text: r.reward_name }),
        h("td.code", { text: r.voucher_code }),
        h("td.num", { text: String(r.points_spent) }),
        h("td", {}, h(`span.badge.${r.status}`, { text: r.status }))
      )
    );

    content.replaceChildren(
      h("a.back", { text: "← All users", on: { click: () => go(state.slug, "users") } }),
      h(
        "div.panel",
        {},
        h("h2", { text: user.name || user.phone_e164 }),
        h(
          "div.stats",
          {},
          h("div.stat", {}, h("strong", { text: String(balance) }), h("span", { text: "Balance" })),
          h("div.stat", {}, h("strong.code", { text: user.phone_e164 }), h("span", { text: "Phone" })),
          h("div.stat", {}, h("strong", { text: user.category || "—" }), h("span", { text: "Category" })),
          h("div.stat", {}, h("strong", { text: fmtDate(user.created_at) }), h("span", { text: "Joined" }))
        )
      ),
      h("div.panel", {}, h("h2", { text: "Adjust points" }), adjust, error),
      h("div.panel", {}, h("h2", { text: "Ledger" }), table([["Date"], ["Type"], ["Amount", "num"], ["Expires"]], ledgerRows, "No entries.")),
      h(
        "div.panel",
        {},
        h("h2", { text: "Vouchers" }),
        table([["Date"], ["Reward"], ["Code"], ["Points", "num"], ["Status"]], voucherRows, "No vouchers.")
      )
    );
  }

  // ---------- ledger ----------

  async function showLedger(_, page = 1, type = "") {
    const res = await api("GET", t(`/ledger?page=${page}${type ? `&type=${type}` : ""}`));
    if (!res.ok) return;
    const filter = h(
      "select",
      { attrs: { "aria-label": "Type" }, on: { change: (e) => showLedger(null, 1, e.target.value) } },
      ["", "scan", "redeem", "refund", "adjust", "expire"].map((value) =>
        h("option", { text: value || "All types", attrs: { value, selected: value === type } })
      )
    );
    const rows = res.data.items.map((l) =>
      h(
        "tr.clickable",
        { on: { click: () => go(state.slug, "user", l.user_id) } },
        h("td", { text: fmt(l.created_at) }),
        h("td", { text: l.name || l.phone_e164 }),
        h("td", { text: l.type }),
        amountCell(l.amount),
        h("td", { text: fmtDate(l.expires_at) })
      )
    );
    content.replaceChildren(
      h(
        "div.panel",
        {},
        h("h2", { text: "Ledger" }),
        h("div.toolbar", {}, filter),
        table([["Date"], ["User"], ["Type"], ["Amount", "num"], ["Expires"]], rows, "No entries."),
        pager(res.data, (p) => showLedger(null, p, type))
      )
    );
  }

  // ---------- redemptions ----------

  async function showRedemptions(_, page = 1, status = "issued") {
    const res = await api("GET", t(`/redemptions?page=${page}${status ? `&status=${status}` : ""}`));
    if (!res.ok) return;
    const reload = () => showRedemptions(null, page, status);
    const filter = h(
      "select",
      { attrs: { "aria-label": "Status" }, on: { change: (e) => showRedemptions(null, 1, e.target.value) } },
      [["issued", "Issued"], ["fulfilled", "Fulfilled"], ["cancelled", "Cancelled"], ["expired", "Expired"], ["", "All"]].map(
        ([value, label]) => h("option", { text: label, attrs: { value, selected: value === status } })
      )
    );

    const rows = res.data.items.map((r) => {
      const actions = h("div.row-actions");
      if (r.status === "issued") {
        actions.append(
          h("button.btn.primary.small", {
            text: "Fulfil",
            on: {
              click: () =>
                openDialog({
                  title: `Fulfil voucher ${r.voucher_code}?`,
                  body: [h("p", { text: `${r.reward_name} for ${r.name || r.phone_e164}. This cannot be undone.` })],
                  okLabel: "Mark fulfilled",
                  onOk: async () => {
                    const x = await api("POST", t(`/redemptions/${r.id}/fulfil`), {});
                    if (!x.ok) throw errorText(x.data);
                    toast("Marked as fulfilled");
                    reload();
                  }
                })
            }
          }),
          h("button.btn.ghost.small", {
            text: "Cancel",
            on: {
              click: () => {
                const reason = h("input", { attrs: { type: "text", maxlength: "200", required: true } });
                openDialog({
                  title: `Cancel voucher ${r.voucher_code}?`,
                  body: [
                    h("p", { text: `${r.points_spent} points will be refunded to ${r.name || r.phone_e164}.` }),
                    h("label", { text: "Reason" }, reason)
                  ],
                  okLabel: "Cancel and refund",
                  danger: true,
                  onOk: async () => {
                    const x = await api("POST", t(`/redemptions/${r.id}/cancel`), { reason: reason.value });
                    if (!x.ok) throw errorText(x.data);
                    toast(`Cancelled. ${x.data.refunded_points} points refunded`);
                    reload();
                  }
                });
              }
            }
          })
        );
      }
      return h(
        "tr",
        {},
        h("td", { text: fmt(r.created_at) }),
        h("td", { text: r.name || r.phone_e164 }),
        h("td", { text: r.reward_name }),
        h("td.code", { text: r.voucher_code }),
        h("td.num", { text: String(r.points_spent) }),
        h("td", { text: fmtDate(r.voucher_expires_at) }),
        h("td", {}, h(`span.badge.${r.status}`, { text: r.status })),
        h("td", {}, actions)
      );
    });

    content.replaceChildren(
      h(
        "div.panel",
        {},
        h("h2", { text: "Redemptions" }),
        h("div.toolbar", {}, filter),
        table(
          [["Date"], ["User"], ["Reward"], ["Code"], ["Points", "num"], ["Valid until"], ["Status"], [""]],
          rows,
          "No redemptions."
        ),
        pager(res.data, (p) => showRedemptions(null, p, status))
      )
    );
  }

  // ---------- rewards ----------

  function rewardDialog(reward) {
    const field = (label, attrs) => {
      const input = h("input", { attrs });
      return [input, h("label", { text: label }, input)];
    };
    const [name, nameLabel] = field("Name", { type: "text", maxlength: "80", value: reward?.name ?? "" });
    const [description, descLabel] = field("Description", { type: "text", maxlength: "300", value: reward?.description ?? "" });
    const [image, imageLabel] = field("Image URL (optional)", { type: "url", maxlength: "500", value: reward?.image_url ?? "" });
    const [cost, costLabel] = field("Points cost", { type: "number", min: "1", step: "1", value: reward?.points_cost ?? "" });
    const [stock, stockLabel] = field("Stock", { type: "number", min: "0", step: "1", value: reward?.stock ?? "" });
    const active = h("input", { attrs: { type: "checkbox", checked: reward ? reward.active : true } });

    openDialog({
      title: reward ? `Edit ${reward.name}` : "New reward",
      body: [nameLabel, descLabel, imageLabel, costLabel, stockLabel, h("label.check", {}, active, "Active (shown in the catalog)")],
      onOk: async () => {
        const body = {
          name: name.value,
          description: description.value.trim() || null,
          image_url: image.value.trim() || null,
          points_cost: Number(cost.value),
          stock: Number(stock.value),
          active: active.checked
        };
        const res = reward ? await api("PUT", t(`/rewards/${reward.id}`), body) : await api("POST", t("/rewards"), body);
        if (!res.ok) throw errorText(res.data);
        toast(reward ? "Reward saved" : "Reward created");
        showRewards();
      }
    });
  }

  async function showRewards() {
    const res = await api("GET", t("/rewards"));
    if (!res.ok) return;
    const rows = res.data.rewards.map((r) =>
      h(
        "tr",
        {},
        h("td", { text: r.name }),
        h("td.num", { text: String(r.points_cost) }),
        h("td.num", { text: String(r.stock) }),
        h("td", {}, h(`span.badge.${r.active ? "active" : "inactive"}`, { text: r.active ? "Active" : "Inactive" })),
        h("td", {}, h("button.btn.ghost.small", { text: "Edit", on: { click: () => rewardDialog(r) } }))
      )
    );
    content.replaceChildren(
      h(
        "div.panel",
        {},
        h("h2", { text: "Rewards" }),
        h("div.toolbar", {}, h("button.btn.primary", { text: "New reward", on: { click: () => rewardDialog(null) } })),
        table([["Name"], ["Cost", "num"], ["Stock", "num"], ["Status"], [""]], rows, "No rewards yet.")
      )
    );
  }

  // ---------- settings ----------

  const SETTING_GROUPS = [
    ["Branding", [["brand_name", "text", "Brand name"], ["tagline", "text", "Tagline"], ["logo_url", "optional", "Logo URL"], ["colors", "colors", "Colours"], ["hero_texture", "select:none,wood", "Hero texture"]]],
    ["Users", [["user_categories", "list", "Categories (one per line)"]]],
    ["Scan rules", [["points_per_scan", "number", "Points per scan"], ["scan_cooldown_minutes", "number", "Cooldown (minutes)"], ["daily_scan_cap", "number", "Daily scan cap"]]],
    [
      "Points and vouchers",
      [["points_expiry_days", "number", "Points expire after (days)"], ["pending_points_ttl_days", "number", "Pending points kept (days)"], ["expiring_soon_days", "number", "“Expiring soon” window (days)"], ["voucher_validity_days", "number", "Voucher valid for (days)"]]
    ],
    [
      "OTP limits",
      [["otp_send_limit_per_phone", "number", "Sends per phone"], ["otp_send_window_phone_minutes", "number", "Per-phone window (minutes)"], ["otp_send_limit_per_ip", "number", "Sends per IP"], ["otp_send_window_ip_minutes", "number", "Per-IP window (minutes)"]]
    ],
    ["MSG91", [["msg91_sender_id", "optional", "Sender ID (blank = default)"], ["msg91_template_id", "optional", "Template ID (blank = default)"]]]
  ];

  // Builds an input for one setting and returns [node, read()] where read()
  // gives the value to send.
  function settingInput(kind, value, disabled) {
    const attrs = { disabled };
    if (kind === "number") {
      const input = h("input", { attrs: { ...attrs, type: "number", step: "1", value: value ?? "" } });
      return [input, () => Number(input.value)];
    }
    if (kind === "optional" || kind === "text") {
      const input = h("input", { attrs: { ...attrs, type: "text", value: value ?? "" } });
      return [input, () => (kind === "optional" && input.value.trim() === "" ? null : input.value.trim())];
    }
    if (kind === "list") {
      const input = h("textarea", { text: (value || []).join("\n"), attrs });
      return [input, () => input.value.split("\n").map((s) => s.trim()).filter(Boolean)];
    }
    if (kind.startsWith("select:")) {
      const input = h("select", { attrs }, kind.slice(7).split(",").map((o) => h("option", { text: o, attrs: { value: o, selected: o === value } })));
      return [input, () => input.value];
    }
    // colors
    const pickers = ["b1", "b2", "soft"].map((key) => {
      const input = h("input", { attrs: { ...attrs, type: "color", value: (value?.[key] || "#000000").toLowerCase() } });
      return [key, input];
    });
    const node = h("div.colors", {}, pickers.map(([key, input]) => h("label", { text: key }, input)));
    return [node, () => Object.fromEntries(pickers.map(([key, input]) => [key, input.value.toUpperCase()]))];
  }

  async function showSettings() {
    const res = await api("GET", t("/settings"));
    if (!res.ok) return;
    const { settings, editable } = res.data;
    const readers = [];
    const groups = SETTING_GROUPS.map(([title, fields]) =>
      h(
        "div.settings-group",
        {},
        h("h3", { text: title }),
        fields.map(([key, kind, label]) => {
          const locked = !editable.includes(key);
          const [input, read] = settingInput(kind, settings[key], locked);
          if (!locked) readers.push([key, read]);
          return h(
            "div.field",
            {},
            h("label", { text: label }, locked ? h("span.locked", { text: "(super admin only)" }) : null),
            input
          );
        })
      )
    );
    const error = h("p.error", { attrs: { role: "alert" } });
    const form = h(
      "form",
      {
        on: {
          submit: async (event) => {
            event.preventDefault();
            // Send only what changed.
            const patch = {};
            for (const [key, read] of readers) {
              const value = read();
              if (JSON.stringify(value) !== JSON.stringify(settings[key])) patch[key] = value;
            }
            if (Object.keys(patch).length === 0) {
              toast("Nothing changed");
              return;
            }
            const r = await api("PUT", t("/settings"), patch);
            if (!r.ok) {
              error.textContent = errorText(r.data);
              return;
            }
            toast(`Saved: ${r.data.changed.join(", ")}`);
            showSettings();
          }
        }
      },
      groups,
      error,
      h("button.btn.primary", { text: "Save settings", attrs: { type: "submit" } })
    );
    content.replaceChildren(
      h(
        "div.panel",
        {},
        h("h2", { text: "Settings" }),
        h("p.muted", { text: "Changes apply to future scans and redemptions only." }),
        form
      )
    );
  }

  // ---------- start ----------

  window.addEventListener("hashchange", route);
  api("GET", "/me").then((res) => (res.ok ? start(res.data) : showLogin()));
})();
