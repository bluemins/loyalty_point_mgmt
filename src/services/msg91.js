const BASE_URL = "https://control.msg91.com/api/v5/otp";

const MOCK_OTP = "000000";

function isMockMode(authKey) {
  return !authKey;
}

// MSG91 expects the number without "+", e.g. 919876543210.
function toMsg91Mobile(phoneE164) {
  return phoneE164.replace(/^\+/, "");
}

async function callMsg91(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok && body.type === "success", body };
}

async function sendOtp({ authKey, senderId, templateId, phoneE164, expiryMinutes, fetchImpl = fetch }) {
  if (isMockMode(authKey)) return { ok: true, mock: true };

  const params = new URLSearchParams({
    template_id: templateId,
    sender: senderId,
    mobile: toMsg91Mobile(phoneE164),
    otp_length: "6",
    otp_expiry: String(expiryMinutes)
  });

  return callMsg91(fetchImpl, `${BASE_URL}?${params}`, {
    method: "POST",
    headers: { authkey: authKey, "Content-Type": "application/json" },
    body: "{}"
  });
}

async function verifyOtp({ authKey, phoneE164, otp, fetchImpl = fetch }) {
  if (isMockMode(authKey)) return { ok: otp === MOCK_OTP, mock: true };

  const params = new URLSearchParams({ otp, mobile: toMsg91Mobile(phoneE164) });

  return callMsg91(fetchImpl, `${BASE_URL}/verify?${params}`, {
    method: "GET",
    headers: { authkey: authKey }
  });
}

module.exports = { MOCK_OTP, isMockMode, sendOtp, verifyOtp };
