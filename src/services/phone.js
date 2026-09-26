// Normalises user input to E.164. Numbers without a country code are treated
// as Indian (+91). Returns null when the input is not a plausible number.
function normalizePhone(input) {
  if (typeof input !== "string") return null;

  let value = input.trim().replace(/[\s\-().]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;

  if (value.startsWith("+")) {
    if (value.startsWith("+91")) return normalizeIndian(value.slice(3));
    return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
  }

  if (!/^\d+$/.test(value)) return null;
  if (value.length === 11 && value.startsWith("0")) return normalizeIndian(value.slice(1));
  if (value.length === 12 && value.startsWith("91")) return normalizeIndian(value.slice(2));
  return normalizeIndian(value);
}

// Indian mobile numbers are 10 digits starting with 6-9.
function normalizeIndian(national) {
  return /^[6-9]\d{9}$/.test(national) ? `+91${national}` : null;
}

module.exports = { normalizePhone };
