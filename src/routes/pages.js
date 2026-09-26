const fs = require("fs");
const path = require("path");
const express = require("express");
const { getPublicConfig } = require("../services/theme");

const router = express.Router({ mergeParams: true });

const TEMPLATE = fs.readFileSync(path.join(__dirname, "../views/app.html"), "utf8");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Tenant values are validated by getPublicConfig and escaped here, so the
// template never receives raw settings.
function renderApp(config, mode) {
  const logo = config.logo_url
    ? `<img class="logo" src="${escapeHtml(config.logo_url)}" alt="">`
    : `<span class="logo initials">${escapeHtml(config.brand_initials)}</span>`;
  const values = {
    brand: escapeHtml(config.brand_name),
    tagline: escapeHtml(config.tagline),
    b1: config.colors.b1,
    b2: config.colors.b2,
    soft: config.colors.soft,
    texture: config.hero_texture,
    slug: escapeHtml(config.slug),
    mode,
    logo
  };
  return TEMPLATE.replace(/{{(\w+)}}/g, (_, key) => values[key]);
}

function servePage(mode) {
  return async (req, res, next) => {
    try {
      const config = await getPublicConfig(req.app.locals.db, req.tenant);
      res.type("html").send(renderApp(config, mode));
    } catch (error) {
      next(error);
    }
  };
}

// The QR opens /scan: the page records the scan with a POST once it loads.
// The GET itself never records anything, so previews and prefetch are harmless.
router.get("/scan", servePage("scan"));
router.get("/", servePage("home"));

router.get("/config", async (req, res, next) => {
  try {
    res.json(await getPublicConfig(req.app.locals.db, req.tenant));
  } catch (error) {
    next(error);
  }
});

module.exports = { router, escapeHtml, renderApp };
