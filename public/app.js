// User app: one page, screens switched by the URL hash. All data from the
// server is inserted with textContent, never innerHTML.
(() => {
  "use strict";

  const slug = document.body.dataset.slug;
  const mode = document.body.dataset.mode;
  const base = `/t/${slug}`;
  const $ = (id) => document.getElementById(id);
  const RING_LENGTH = 326.73; // 2 * PI * r, r = 52
  const NETWORK_ERROR = "Network problem. Check your connection and try again.";

  const state = {
    config: null,
    session: { authenticated: false },
    scan: null,
    rewards: null,
    points: null,
    phone: null,
    pendingPoints: 0,
    voucher: null,
    redeem: null,
    resendTimer: null
  };

  // ---------- helpers ----------

  async function api(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // Non-JSON error page; handled by status.
    }
    return { status: res.status, ok: res.ok, data };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // getRandomValues works on plain http too (randomUUID needs https).
  function randomKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  const shortDate = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.hidden = true;
    }, 2600);
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  }

  function loggedIn() {
    return state.session.authenticated && state.session.has_profile;
  }

  // ---------- navigation ----------

  const SCREENS = ["landing", "login", "profile", "home", "rewards", "voucher"];

  function show(screen, hero = "none") {
    for (const name of SCREENS) $(`screen-${name}`).hidden = name !== screen;
    $("scan-result").hidden = hero !== "scan";
    $("ring-wrap").hidden = hero !== "ring";
    $("ring-caption").hidden = hero !== "ring";
    $("logout-btn").hidden = !state.session.authenticated;
    window.scrollTo(0, 0);
  }

  function go(hash) {
    if (location.hash === `#${hash}`) route();
    else location.hash = hash;
  }

  // Screens that need a logged-in user with a profile send others onward.
  function guard() {
    if (!state.session.authenticated) {
      go("login");
      return false;
    }
    if (!state.session.has_profile) {
      go("profile");
      return false;
    }
    return true;
  }

  function defaultScreen() {
    if (loggedIn()) return "home";
    if (state.session.authenticated) return "profile";
    return "landing";
  }

  async function route() {
    const [name, arg] = location.hash.slice(1).split("/");
    switch (name) {
      case "landing":
        return showLanding();
      case "login":
        return loggedIn() ? go("home") : showLogin();
      case "profile":
        if (!state.session.authenticated) return go("login");
        return state.session.has_profile ? go("home") : showProfile();
      case "home":
        return guard() && showHome();
      case "rewards":
        return guard() && showRewards("catalog");
      case "vouchers":
        return guard() && showRewards("vouchers");
      case "voucher":
        return guard() && showVoucher(arg);
      default:
        return go(defaultScreen());
    }
  }

  async function loadRewards() {
    if (!state.rewards) {
      const res = await api("GET", "/rewards");
      state.rewards = res.ok ? res.data.rewards : [];
    }
    return state.rewards;
  }

  async function refreshSession() {
    const res = await api("GET", "/session");
    state.session = res.ok ? res.data : { authenticated: false };
  }

  // ---------- reward cards ----------

  function rewardArt(reward) {
    const art = el("div", "reward-art");
    const fallback = el("div", "fallback", initials(reward.name));
    if (reward.image_url) {
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = reward.image_url;
      img.addEventListener("error", () => img.replaceWith(fallback));
      art.append(img);
    } else {
      art.append(fallback);
    }
    art.append(el("span", "cost", `${reward.points_cost} pts`));
    return art;
  }

  function rewardCard(reward, action) {
    const card = el("article", "reward");
    const body = el("div", "reward-body");
    body.append(el("h4", null, reward.name));
    if (reward.description) body.append(el("p", null, reward.description));
    if (action) body.append(action);
    card.append(rewardArt(reward), body);
    return card;
  }

  // ---------- landing ----------

  async function showLanding() {
    const scan = state.scan;
    const title = $("landing-title");
    const text = $("landing-text");
    const cta = $("landing-cta");
    const homeBtn = $("landing-home");
    let hero = "none";

    cta.hidden = false;
    homeBtn.hidden = true;
    cta.textContent = "Verify your phone";
    cta.onclick = () => go("login");
    title.textContent = "Earn points every time you scan";
    text.textContent = "Scan the QR on every purchase and redeem your points for rewards.";

    if (scan) {
      hero = "scan";
      const burst = $("scan-points");
      clear(burst);
      burst.classList.toggle("muted-burst", scan.points === 0);

      if (scan.outcome === "pending") {
        burst.append(`+${scan.points}`, el("small", null, "points pending"));
        title.textContent = "Claim your points";
        text.textContent = `Verify your phone to add ${plural(scan.pending_points, "pending point")} to your account.`;
        cta.textContent = "Verify phone to claim";
      } else if (scan.outcome === "credited") {
        burst.append(`+${scan.points}`, el("small", null, "points added"));
        title.textContent = "Points added!";
        text.textContent = "Keep scanning on every purchase to unlock rewards.";
      } else if (scan.outcome === "error") {
        burst.append("Oops");
        title.textContent = "We could not record this scan";
        text.textContent = NETWORK_ERROR;
      } else {
        burst.append(scan.outcome === "cooldown" ? "Scanned" : "Limit reached");
        title.textContent = scan.outcome === "cooldown" ? "You scanned recently" : "That's all for today";
        text.textContent = scan.message || "";
      }
    }

    if (loggedIn()) {
      cta.hidden = true;
      homeBtn.hidden = false;
    }
    homeBtn.onclick = () => go("home");
    show("landing", hero);

    const teaser = $("rewards-teaser");
    clear(teaser);
    for (const reward of (await loadRewards()).slice(0, 6)) teaser.append(rewardCard(reward));
  }

  // ---------- login ----------

  function showLogin() {
    $("phone-form").hidden = false;
    $("code-form").hidden = true;
    $("phone-error").textContent = "";
    const pending = state.scan?.pending_points || 0;
    $("pending-note").textContent = pending > 0
      ? `${plural(pending, "point")} waiting for you. We will send a 6-digit code by SMS.`
      : "We will send a 6-digit code by SMS.";
    show("login");
    $("phone").focus();
  }

  function startResendCountdown(seconds = 30) {
    const btn = $("resend-btn");
    clearInterval(state.resendTimer);
    let left = seconds;
    btn.disabled = true;
    btn.textContent = `Resend code in ${left}s`;
    state.resendTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(state.resendTimer);
        btn.disabled = false;
        btn.textContent = "Resend code";
      } else {
        btn.textContent = `Resend code in ${left}s`;
      }
    }, 1000);
  }

  async function sendCode(errorNode) {
    let res;
    try {
      res = await api("POST", "/otp/send", { phone: state.phone });
    } catch {
      errorNode.textContent = NETWORK_ERROR;
      return false;
    }
    if (res.ok) {
      if (res.data.mock) toast("Test mode: use code 000000");
      startResendCountdown();
      return true;
    }
    const messages = {
      invalid_phone: "Enter a valid 10-digit mobile number.",
      rate_limited: `Too many codes requested. Try again in ${Math.ceil((res.data.retry_after_seconds || 60) / 60)} min.`
    };
    errorNode.textContent = messages[res.data.error] || "Could not send the code. Please try again shortly.";
    return false;
  }

  $("phone-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const digits = $("phone").value.replace(/\D/g, "");
    if (!/^[6-9]\d{9}$/.test(digits)) {
      $("phone-error").textContent = "Enter a valid 10-digit mobile number.";
      return;
    }
    $("phone-error").textContent = "";
    state.phone = digits;
    const btn = $("send-btn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    const sent = await sendCode($("phone-error"));
    btn.disabled = false;
    btn.textContent = "Send code";
    if (!sent) return;
    $("code-phone").textContent = `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
    $("code").value = "";
    $("code-error").textContent = "";
    $("phone-form").hidden = true;
    $("code-form").hidden = false;
    $("code").focus();
  });

  $("change-phone").addEventListener("click", showLogin);

  $("resend-btn").addEventListener("click", async () => {
    $("code-error").textContent = "";
    if (await sendCode($("code-error"))) toast("New code sent");
  });

  $("code").addEventListener("input", () => {
    const input = $("code");
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
    if (input.value.length === 6) $("code-form").requestSubmit();
  });

  $("code-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("code").value;
    const errorNode = $("code-error");
    if (!/^\d{6}$/.test(code)) {
      errorNode.textContent = "Enter the 6-digit code.";
      return;
    }
    const btn = $("verify-btn");
    btn.disabled = true;
    btn.textContent = "Verifying…";
    let res;
    try {
      res = await api("POST", "/otp/verify", { phone: state.phone, otp: code });
    } catch {
      errorNode.textContent = NETWORK_ERROR;
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = "Verify";
    }

    if (!res.ok) {
      const d = res.data;
      const messages = {
        invalid_otp: `Wrong code. ${plural(d.attempts_left ?? 0, "attempt")} left.`,
        otp_expired: "This code has expired. Tap Resend code.",
        too_many_attempts: "Too many wrong attempts. Tap Resend code for a new one."
      };
      errorNode.textContent = messages[d.error] || "Could not verify the code. Please try again.";
      $("code").value = "";
      return;
    }

    clearInterval(state.resendTimer);
    await refreshSession();
    if (res.data.needs_profile) {
      state.pendingPoints = res.data.pending_points || 0;
      go("profile");
    } else {
      toast(res.data.merged_points > 0 ? `+${res.data.merged_points} points added` : "Welcome back!");
      go("home");
    }
  });

  // ---------- profile ----------

  function showProfile() {
    const chips = $("categories");
    clear(chips);
    for (const category of state.config.user_categories) {
      const chip = el("button", "chip", category);
      chip.type = "button";
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        for (const other of chips.children) other.setAttribute("aria-pressed", "false");
        chip.setAttribute("aria-pressed", "true");
      });
      chips.append(chip);
    }
    const pill = $("profile-pending");
    pill.hidden = state.pendingPoints <= 0;
    pill.textContent = `+${state.pendingPoints} points will be added`;
    $("profile-error").textContent = "";
    show("profile");
    $("name").focus();
  }

  $("profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorNode = $("profile-error");
    const name = $("name").value.trim();
    const chosen = [...$("categories").children].find((c) => c.getAttribute("aria-pressed") === "true");
    if (!name) {
      errorNode.textContent = "Please enter your name.";
      return;
    }
    if (!chosen) {
      errorNode.textContent = "Please choose what describes you best.";
      return;
    }
    let res;
    try {
      res = await api("POST", "/profile", { name, category: chosen.textContent });
    } catch {
      errorNode.textContent = NETWORK_ERROR;
      return;
    }
    if (res.status === 401) return go("login");
    if (res.status === 409) {
      await refreshSession();
      return go("home");
    }
    if (!res.ok) {
      errorNode.textContent = res.data.error === "invalid_name" ? "Please enter a valid name." : "Please choose a category.";
      return;
    }
    await refreshSession();
    toast(res.data.merged_points > 0 ? `Welcome! +${res.data.merged_points} points added` : "Welcome!");
    go("home");
  });

  // ---------- home ----------

  async function loadPoints() {
    const res = await api("GET", "/points");
    if (res.status === 401 || res.status === 409) {
      await refreshSession();
      go(defaultScreen());
      return null;
    }
    state.points = res.data;
    return res.data;
  }

  function countUp(node, target) {
    const start = performance.now();
    const duration = 1100;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      node.textContent = Math.round(target * (1 - Math.pow(1 - t, 3))).toLocaleString("en-IN");
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // The ring shows progress toward the cheapest reward the user cannot afford yet.
  function paintRing(balance, rewards) {
    const available = rewards.filter((r) => r.in_stock);
    const affordable = available.filter((r) => r.points_cost <= balance);
    const next = available.filter((r) => r.points_cost > balance).sort((a, b) => a.points_cost - b.points_cost)[0];
    const progress = next ? balance / next.points_cost : available.length ? 1 : 0;
    const fill = $("ring-fill");
    fill.style.strokeDashoffset = String(RING_LENGTH);
    requestAnimationFrame(() => {
      fill.style.strokeDashoffset = String(RING_LENGTH * (1 - Math.min(1, progress)));
    });

    let caption = "Scan on every purchase to earn points.";
    if (affordable.length > 0) caption = `You can redeem ${plural(affordable.length, "reward")} now!`;
    else if (next) caption = `${next.points_cost - balance} more points to ${next.name}`;
    $("ring-caption").textContent = caption;
  }

  const ACTIVITY = {
    scan: ["+", "Scan reward"],
    refund: ["↺", "Voucher refund"],
    adjust: ["±", "Adjustment"],
    redeem: ["−", "Redeemed"],
    expire: ["×", "Points expired"]
  };

  async function showHome() {
    show("home", "ring");
    const [points, rewards] = await Promise.all([loadPoints(), loadRewards()]);
    if (!points) return;

    countUp($("balance"), points.balance);
    paintRing(points.balance, rewards);

    const soon = points.expiring_soon;
    $("expiring-card").hidden = soon.total === 0;
    $("expiring-total").textContent = `${plural(soon.total, "point")} expiring in the next ${soon.within_days} days`;
    const list = $("expiring-list");
    clear(list);
    for (const row of soon.by_date) {
      const li = el("li");
      li.append(el("span", null, shortDate.format(new Date(`${row.date}T12:00:00+05:30`))), el("strong", null, `${row.points} pts`));
      list.append(li);
    }

    const activity = $("activity");
    clear(activity);
    $("activity-empty").hidden = points.activity.length > 0;
    activity.hidden = points.activity.length === 0;
    for (const entry of points.activity) {
      const [icon, label] = ACTIVITY[entry.type] || ["•", entry.type];
      const li = el("li");
      const what = el("div", "what");
      what.append(el("strong", null, label), el("span", null, dateFmt.format(new Date(entry.created_at))));
      const sign = entry.amount > 0 ? "+" : "";
      li.append(
        el("span", "icon", icon),
        what,
        el("span", `amount ${entry.amount > 0 ? "plus" : "minus"}`, `${sign}${entry.amount}`)
      );
      activity.append(li);
    }
  }

  $("go-rewards").addEventListener("click", () => go("rewards"));

  // ---------- rewards ----------

  async function showRewards(tab) {
    show("rewards");
    $("tab-catalog").setAttribute("aria-selected", String(tab === "catalog"));
    $("tab-vouchers").setAttribute("aria-selected", String(tab === "vouchers"));
    $("rewards-grid").hidden = tab !== "catalog";
    $("vouchers-list").hidden = tab !== "vouchers";
    $("vouchers-empty").hidden = true;

    if (tab === "catalog") {
      state.rewards = null; // stock may have changed
      const [points, rewards] = await Promise.all([loadPoints(), loadRewards()]);
      if (!points) return;
      const grid = $("rewards-grid");
      clear(grid);
      for (const reward of rewards) {
        const btn = el("button", "btn primary small");
        btn.type = "button";
        if (!reward.in_stock) {
          btn.textContent = "Out of stock";
          btn.disabled = true;
        } else if (reward.points_cost > points.balance) {
          btn.textContent = `Need ${reward.points_cost - points.balance} more`;
          btn.disabled = true;
        } else {
          btn.textContent = "Redeem";
          btn.addEventListener("click", () => openSheet(reward, points.balance));
        }
        grid.append(rewardCard(reward, btn));
      }
    } else {
      const res = await api("GET", "/redemptions");
      if (!res.ok) return go(defaultScreen());
      const list = $("vouchers-list");
      clear(list);
      $("vouchers-empty").hidden = res.data.redemptions.length > 0;
      for (const v of res.data.redemptions) {
        const li = el("li");
        const btn = el("button");
        btn.type = "button";
        const info = el("div");
        info.append(el("strong", null, v.reward.name), el("span", null, `${v.voucher_code} · ${dateFmt.format(new Date(v.created_at))}`));
        btn.append(info, el("span", `status ${v.status}`, v.status));
        btn.addEventListener("click", () => {
          state.voucher = v;
          go(`voucher/${v.id}`);
        });
        li.append(btn);
        list.append(li);
      }
    }
  }

  $("tab-catalog").addEventListener("click", () => go("rewards"));
  $("tab-vouchers").addEventListener("click", () => go("vouchers"));
  $("rewards-back").addEventListener("click", () => go("home"));

  // One idempotency key per confirmation sheet: a retry after a network error
  // reuses it, so the same tap can never spend twice.
  function openSheet(reward, balance) {
    state.redeem = { reward, key: randomKey() };
    $("sheet-title").textContent = `Redeem ${reward.name}?`;
    $("sheet-text").textContent = `${reward.points_cost} points will be used. You will have ${balance - reward.points_cost} left.`;
    $("sheet-error").textContent = "";
    $("sheet-confirm").disabled = false;
    $("sheet-confirm").textContent = "Redeem";
    $("sheet").hidden = false;
  }

  function closeSheet() {
    $("sheet").hidden = true;
    state.redeem = null;
  }

  $("sheet-cancel").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (event) => {
    if (event.target === $("sheet")) closeSheet();
  });

  $("sheet-confirm").addEventListener("click", async () => {
    const { reward, key } = state.redeem;
    const btn = $("sheet-confirm");
    const errorNode = $("sheet-error");
    btn.disabled = true;
    btn.textContent = "Redeeming…";
    let res;
    try {
      res = await api("POST", `/rewards/${reward.id}/redeem`, {}, { "Idempotency-Key": key });
    } catch {
      errorNode.textContent = NETWORK_ERROR;
      btn.disabled = false;
      btn.textContent = "Try again";
      return;
    }
    if (res.ok) {
      closeSheet();
      state.voucher = res.data.redemption;
      state.rewards = null;
      go(`voucher/${res.data.redemption.id}`);
      return;
    }
    const messages = {
      insufficient_points: "You do not have enough points for this reward.",
      out_of_stock: "Sorry, this reward just ran out of stock.",
      reward_not_found: "This reward is no longer available."
    };
    errorNode.textContent = messages[res.data.error] || "Could not redeem right now. Please try again.";
    btn.textContent = "Redeem";
  });

  // ---------- voucher ----------

  async function showVoucher(id) {
    let voucher = state.voucher && state.voucher.id === id ? state.voucher : null;
    if (!voucher) {
      const res = await api("GET", "/redemptions");
      voucher = res.ok ? res.data.redemptions.find((v) => v.id === id) : null;
    }
    if (!voucher) return go("vouchers");

    $("voucher-reward").textContent = voucher.reward.name;
    $("voucher-code").textContent = voucher.voucher_code;
    $("voucher-status").textContent = voucher.status === "issued" ? "Your voucher is ready" : `Voucher ${voucher.status}`;
    $("voucher-valid").textContent = `Valid until ${dateFmt.format(new Date(voucher.voucher_expires_at))}`;
    show("voucher");
  }

  $("copy-btn").addEventListener("click", async () => {
    const code = $("voucher-code").textContent;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard API needs https; fall back to selecting the text.
      const range = document.createRange();
      range.selectNodeContents($("voucher-code"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("copy");
    }
    toast("Code copied");
  });

  $("voucher-home").addEventListener("click", () => go("home"));

  // ---------- logout ----------

  $("logout-btn").addEventListener("click", async () => {
    await api("POST", "/logout", {});
    state.session = { authenticated: false };
    state.points = null;
    state.scan = null;
    go("landing");
  });

  // ---------- start ----------

  async function init() {
    const [config, session] = await Promise.all([api("GET", "/config"), api("GET", "/session")]);
    state.config = config.data;
    state.session = session.ok ? session.data : { authenticated: false };

    if (mode === "scan") {
      // Swap the URL first so a refresh shows the app instead of scanning again.
      history.replaceState(null, "", `${base}/#landing`);
      try {
        const res = await api("POST", "/scan", {});
        state.scan = res.ok ? res.data : { outcome: "error", points: 0 };
      } catch {
        state.scan = { outcome: "error", points: 0 };
      }
      if (state.scan.outcome === "credited") toast(`+${state.scan.points} points added`);
    }
    route();
  }

  window.addEventListener("hashchange", route);
  init().catch(() => toast(NETWORK_ERROR));
})();
