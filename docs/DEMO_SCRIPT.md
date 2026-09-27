# Live demo script (brand admin presentation)

For the platform owner presenting to a brand's admin. Use it with the slide deck "Loyalty Programme: Admin Walkthrough": the slides first (about 20 minutes), then this demo (about 15 minutes), then questions.

The demo runs on your laptop in test mode: no SMS is sent and the code is always `000000`. **Tell the audience this** before you start, so nobody waits for an SMS.

---

## Commands, in order

Run in a WSL terminal, in the project folder. `.env` must have `MSG91_AUTH_KEY=` empty (test mode).

**Once, the day before**
```bash
. ~/.nvm/nvm.sh                 # load Node 22
npm install                     # only after pulling new code
npm run migrate                 # database up to date (safe to repeat)
npm run seed                    # demo brands and rewards (safe to repeat)
npm test                        # 107 tests: must end with "# fail 0"
npm run test:e2e                # 15 browser tests, including this demo: "# fail 0"
npm run admin:create            # your super admin (skip if it exists)
npm run admin:create -- --email brand@demo.test --role tenant_admin --tenant demo
                                # the brand admin you present with (skip if it exists)
```
Then sign in at http://localhost:3000/admin as super admin, choose **demo**, and in **Settings** set **Brand name** = `Demo Plywood`, **Cooldown (minutes)** = `10`, **Daily scan cap** = `5`.

**Optional: rehearse by watching the automated run** (opens two browsers and plays the whole demo, about 1 minute):
```bash
HEADED=1 npm run test:demo      # screenshots of each step in screenshots/demo/
```
The windows appear on the Windows desktop (WSLg, Windows 11). It uses its own throwaway brand, so it does not touch the `demo` brand you present with.

**On the day**
```bash
. ~/.nvm/nvm.sh
npm run dev                     # keep this terminal open during the demo
```
In a second terminal, check the server:
```bash
curl -s http://localhost:3000/health            # {"status":"ok","database":true,"redis":true,...}
curl -s http://localhost:3000/t/demo/theme.css  # the wood colours
```

**Optional, during the demo: onboard a new brand live** (shows how a new client is set up in one command):
```bash
npm run tenant:create
# slug: acme-plywood   name: Acme Plywood   categories: Enter   admin email: shop@acme.test   password twice
```
Then open http://localhost:3000/t/acme-plywood/scan: a new, empty brand. Switch to it in the super admin panel to set its colours and rewards.

**After the demo**
```bash
# Ctrl+C in the npm run dev terminal stops the server.
# Hide the brand made live (data is kept):
psql "$(grep ^DATABASE_URL .env | cut -d= -f2-)" -c "UPDATE tenants SET active = false WHERE slug = 'acme-plywood'"
```

---

## Before the meeting (the day before)

1. Run [TEST_CHECKLIST.md](TEST_CHECKLIST.md) once. It also creates the accounts used here:
   - your super admin account;
   - the brand admin `brand@demo.test`;
   - the brand renamed to **Demo Plywood**.
2. In the admin panel, **Settings** for `demo`:
   - **Cooldown (minutes)**: `10`
   - **Daily scan cap**: `5`
   - **Tagline**: something the audience will recognise.
3. Choose a **fresh phone number** for the demo customer, for example `9999900003`. A fresh number shows the first-time profile screen.
4. Optional: a real phone that scans a QR code. See [Showing it on a real phone](#showing-it-on-a-real-phone).

## On the day, 10 minutes before

1. In WSL, from the project folder:
   ```bash
   . ~/.nvm/nvm.sh
   npm run dev
   ```
2. Check http://localhost:3000/health says `"status":"ok"`.
3. Open three browser windows and arrange them side by side:

| Window | What | Signed in as |
|---|---|---|
| A: "the customer" | Private window, phone view (F12, then Ctrl+Shift+M), http://localhost:3000/t/demo/scan. Do **not** open it yet if you want the first scan to happen live. | nobody |
| B: "you, the brand admin" | http://localhost:3000/admin | `brand@demo.test` |
| C: spare | The slide deck | — |

Use the **brand admin** login in window B, not your super admin one, so the audience sees exactly what they will get.

---

## The demo, step by step

Each step says what to do and a line to say.

### 1. The customer scans (window A)

1. Open http://localhost:3000/t/demo/scan (or scan the QR with the phone).
   - *"This is what opens when a carpenter scans the QR on your sheet. No app, no login. They already have 10 points, but pending."*
2. Open the scan URL again (after a scan the address bar shows `/t/demo/`, and reloading that does not scan; on the phone, scan the QR again).
   - *"Scanning again straight away earns nothing: there is a 10-minute wait. That's what stops someone scanning the same code 50 times."*
3. Tap **Verify phone to claim**, enter the demo number, then **Send code**. Enter `000000`.
   - *"In real use this is an SMS code. Today it's the test code."*
4. Profile: enter a name and choose **Carpenter**, then **Continue**.
   - *"First time only. These categories are yours to set."*
5. My points shows **10**.
   - *"The ring shows the balance and how far they are from the next reward."*

### 2. Find the customer and give points (window B)

1. **Users**: the new customer is at the top, balance 10. Open them.
   - *"Search by any part of the phone number or name."*
2. **Adjust points**: `+100`, reason `Welcome bonus`. The toast shows the new balance, **110**.
   - *"Every adjustment needs a reason and is recorded with your name. Negative numbers take points away, but never below zero."*
3. Point at the ledger: one `scan` +10 and one `adjust` +100, each with its own expiry date.

### 3. The customer redeems (window A)

1. Reload My points: balance **110**, activity shows the adjustment.
2. **Redeem rewards**. Starter Voucher (100) can be redeemed; the others say **Need … more**.
3. Redeem **Starter Voucher** and confirm. The voucher code appears.
   - *"This code is what the customer shows at your counter. It's valid for 30 days. Tapping twice can't spend twice."*
4. Back on My points: balance **10**.

### 4. Hand over the reward (window B)

1. **Redemptions** (opens on **Issued**): the same code is there.
   - *"At the counter: match the code, hand over the reward, press Fulfil. Fulfil is final."*
2. **Fulfil** it and confirm.
3. Explain **Cancel** without doing it: *"If you can't give the reward, Cancel with a reason. The points go back as a new batch valid 60 days, and the stock goes back up."*
4. **Rewards**: Starter Voucher stock went down by 1.

### 5. Change a setting (window B then A)

1. **Settings**: change the **Tagline**, then **Save settings**.
2. Reload the customer app: the new tagline shows immediately.
   - *"Branding changes are immediate. Rule changes, like points per scan, apply to future scans only; they never rewrite the past."*
3. Point at the greyed-out OTP and SMS settings: *"These are managed by us, because they control SMS costs."*

### 6. Wrap up

- *"Every day: fulfil vouchers as rewards go out. Every week: check stock. Locked out or forgot your password: call us."*
- Go back to the last slide for questions.

---

## If something goes wrong

| Problem | Fix |
|---|---|
| The page does not load | Is `npm run dev` still running? Check http://localhost:3000/health. |
| "Too many codes" when sending the code | The send limit per network is 10 an hour. Use your super admin login: in **Settings**, raise **Sends per IP**, and set it back afterwards. |
| The first scan says "Scanned recently" | That window already scanned in the last 10 minutes. Open a new private window. |
| The second scan shows "+10 pending" again instead of "Scanned recently" | More than 10 minutes passed, or the cooldown is set to 0 in Settings. |
| No profile screen after the code | That number was used before. Use a fresh number. |
| Locked out of the admin panel | Unlock command in [TEST_CHECKLIST.md](TEST_CHECKLIST.md) step 7.7. |
| A question you can't answer | [ADMIN_GUIDE.md](ADMIN_GUIDE.md), sections "Corner cases" and "Where are my points?". |

---

## Showing it on a real phone

The server runs inside WSL, which a phone cannot reach directly. Windows has to forward the port. All of these steps are on the laptop, and the phone must be on the same Wi-Fi.

1. In WSL, get the WSL address:
   ```bash
   hostname -I | awk '{print $1}'
   ```
2. In **PowerShell as Administrator**, replace `<WSL-IP>` with that address:
   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3000 connectaddress=<WSL-IP> connectport=3000
   New-NetFirewallRule -DisplayName "Loyalty demo 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
   ```
3. Find the laptop's Wi-Fi address with `ipconfig` (the IPv4 address of the Wi-Fi adapter, e.g. `192.168.1.20`).
4. On the phone, open `http://<laptop-IP>:3000/t/demo/scan`. For the full effect, turn that URL into a QR code with any QR generator and scan it.
5. **After the demo**, remove the forwarding and the firewall rule:
   ```powershell
   netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=3000
   Remove-NetFirewallRule -DisplayName "Loyalty demo 3000"
   ```

Notes:

- The WSL address changes when WSL restarts. If the phone stops connecting, repeat steps 1 and 2 (run the `delete` command first).
- On plain `http`, **Copy code** on the voucher may fall back to selecting the code instead of copying it. It works normally on the real `https` site.
- Anyone on the same Wi-Fi can open the demo while the forwarding is on. Remove it afterwards.
