const { getSettings } = require("./tenants");

// Used when a tenant's colour is missing or not a plain hex value.
const DEFAULT_COLORS = { b1: "#1F2937", b2: "#4B5563", soft: "#F9FAFB" };
const HERO_TEXTURES = ["none", "wood"];
const HEX = /^#[0-9a-f]{6}$/i;

// Only values that pass these checks are ever written into the page, so a bad
// settings value cannot inject CSS or HTML.
function safeColors(colors) {
  const result = {};
  for (const key of Object.keys(DEFAULT_COLORS)) {
    const value = colors?.[key];
    result[key] = typeof value === "string" && HEX.test(value) ? value : DEFAULT_COLORS[key];
  }
  return result;
}

function safeLogoUrl(url) {
  if (typeof url !== "string") return null;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

// Public, per-tenant configuration for the user-facing app.
async function getPublicConfig(db, tenant) {
  const settings = await getSettings(db, tenant.id);
  const brandName = typeof settings.brand_name === "string" && settings.brand_name.trim()
    ? settings.brand_name.trim()
    : tenant.name;
  return {
    slug: tenant.slug,
    brand_name: brandName,
    brand_initials: initials(brandName),
    tagline: typeof settings.tagline === "string" ? settings.tagline : "",
    logo_url: safeLogoUrl(settings.logo_url),
    colors: safeColors(settings.colors),
    hero_texture: HERO_TEXTURES.includes(settings.hero_texture) ? settings.hero_texture : "none",
    user_categories: Array.isArray(settings.user_categories) ? settings.user_categories : [],
    points_per_scan: Number(settings.points_per_scan)
  };
}

module.exports = { DEFAULT_COLORS, safeColors, safeLogoUrl, getPublicConfig };
