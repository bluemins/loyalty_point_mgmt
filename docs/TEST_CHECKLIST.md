# Manual test checklist (super admin)

A click-through acceptance test of the whole platform, run by the platform owner on a laptop before showing it to a brand. It takes about 45 minutes. The developer tests (`npm test`, `npm run test:e2e`) check the same rules automatically; this checklist is for seeing them with your own eyes.

Mark each step ✅ or ❌ in the **Result** column. For any ❌, write down what you saw and send it with the step number.

It runs on the `demo` brand (wood theme) and uses `demo-laminates` (teal) to check that brands are kept apart.

**Test data used below**

| What | Value |
|---|---|
| App (customer) | http://localhost:3000/t/demo/scan |
| Admin panel | http://localhost:3000/admin |
| SMS code (test mode) | `000000` |
| Customer A | phone `9999900001` |
| Customer B | phone `9999900002` |
| Your super admin | your email, a password of 10+ characters |
| Brand admin | `brand@demo.test`, a password of 10+ characters |

---

## 0. Setup

Run in a WSL terminal in the project folder.

| # | Do | Expect | Result |
|---|---|---|---|
| 0.1 | `. ~/.nvm/nvm.sh` then `node -v` | v22 or later | |
| 0.2 | Check `.env`: the line `MSG91_AUTH_KEY=` is **empty** | Test mode: no SMS is sent, the code is always `000000` | |
| 0.3 | `npm run migrate` then `npm run seed` | Both finish without errors. Safe to repeat. | |
| 0.4 | `npm run dev` (leave it running; use a second terminal for the rest) | `Loyalty API listening on port 3000` | |
| 0.5 | Open http://localhost:3000/health | `"status":"ok","database":true,"redis":true` | |

## 1. Admin accounts

| # | Do | Expect | Result |
|---|---|---|---|
| 1.1 | `npm run admin:create`: your email, role `super_admin`, a password twice | `Created super_admin <your email>` | |
| 1.2 | Run it again with the same email | `An admin with that email already exists.` | |
| 1.3 | `npm run admin:create`: email `brand@demo.test`, role `tenant_admin`, tenant `demo`, a password | `Created tenant_admin brand@demo.test` | |
| 1.4 | Create a tenant admin with tenant `nope` | `No tenant with slug "nope"` | |
| 1.5 | Create an admin with a 5-character password | `password must be at least 10 characters` | |

## 2. Super admin panel

| # | Do | Expect | Result |
|---|---|---|---|
| 2.1 | Open the admin panel, sign in with a **wrong** password | Error message; the same message as for an unknown email | |
| 2.2 | Sign in with your correct password | Users screen; a brand selector at the top listing `demo` and `demo-laminates` | |
| 2.3 | Select `demo-laminates`, then back to `demo` | The screens change to the selected brand's data | |
| 2.4 | **Settings**: change **Brand name** to `Demo Plywood`, **Save settings** | Message `Saved: brand_name` | |
| 2.5 | Open the customer app in another tab | The header shows **Demo Plywood** in the wood theme | |
| 2.6 | **Settings**: set **Daily scan cap** to `0`, save | Refused with a validation message (the cap must be at least 1) | |
| 2.7 | **Rewards** | Starter Voucher (100), Trade Pack (250), Loyalty Bonus (500), all active, with stock | |

## 3. Customer journey: Customer A

Use a **private/incognito window** for each customer, so they do not share cookies. For a phone-sized view: DevTools (F12) → device toolbar (Ctrl+Shift+M).

| # | Do | Expect | Result |
|---|---|---|---|
| 3.1 | Open the app URL | Scan result: **+10 points pending**, button **Verify phone to claim**, rewards below | |
| 3.2 | Reload the page at once | **Scanned recently** message with the time left; still 10 pending, not 20 | |
| 3.3 | Tap **Verify phone to claim**, enter `9999900001`, **Send code** | Code screen; **Resend code** counts down from 30 s | |
| 3.4 | Enter `123456` | Wrong code, shows the tries left (4) | |
| 3.5 | Enter `000000` | Profile screen, with a note that 10 pending points will be added | |
| 3.6 | Enter name `Test Carpenter`, choose **Carpenter**, **Continue** | My points: balance **10**; activity shows **+10 Scan reward** | |
| 3.7 | Open the app URL again (logged in now) | Scanned recently: the wait carries over from before you logged in | |
| 3.8 | **Log out**, then open the app URL again | **Log out** disappears from the header. Within 10 minutes of step 3.1: **Scanned recently** (the wait belongs to this phone, not the login). After 10 minutes: **+10 pending** | |
| 3.9 | Log back in as `9999900001` / `000000` | Straight to My points, **no** profile screen (any pending scan from 3.8 is added) | |

## 4. Scan limits (daily cap)

| # | Do | Expect | Result |
|---|---|---|---|
| 4.1 | Admin **Settings**: **Cooldown (minutes)** = `0`, save | Saved | |
| 4.2 | As Customer A (logged in), open the app URL, repeat until refused | Each scan says **+10 points added** until today's 5th earning scan (the claimed pending ones count). The next one says **Daily limit reached** | |
| 4.3 | Check My points | Balance **50**: 5 earning scans today × 10 | |
| 4.4 | Admin **Settings**: **Cooldown (minutes)** back to `10`, save | Saved | |

## 5. Users and point adjustments

| # | Do | Expect | Result |
|---|---|---|---|
| 5.1 | Admin **Users**: search `00001` | Test Carpenter, balance 50 | |
| 5.2 | Open the user | Balance, phone, category Carpenter; ledger with five `scan` +10 lines, each expiring in 60 days | |
| 5.3 | Adjust `+100` with **no reason** | Refused: a reason is required | |
| 5.4 | Adjust `+100`, reason `Welcome bonus test` | Message: new balance **150**; a new `adjust` +100 line in the ledger | |
| 5.5 | Adjust `-1000`, reason `Too much` | Refused: not enough points; balance still 150 | |
| 5.6 | Customer A: reload My points | Balance **150**; activity shows **Adjustment +100** | |

## 6. Redeem, fulfil and cancel

| # | Do | Expect | Result |
|---|---|---|---|
| 6.1 | Customer A: **Redeem rewards** | Starter Voucher shows **Redeem**; Loyalty Bonus shows **Need 350 more** | |
| 6.2 | Redeem **Starter Voucher**, confirm | Voucher screen: a code like `XXXX-XXXX-XX` (no 0, O, 1 or I), **Valid until** 30 days ahead | |
| 6.3 | Back to My points | Balance **50**; activity shows **Redeemed −100** as one line | |
| 6.4 | Admin **Redemptions** (Issued) | The voucher with the same code | |
| 6.5 | Admin **Rewards** | Starter Voucher stock is 1 lower | |
| 6.6 | **Fulfil** the voucher | It leaves the Issued list; under **Fulfilled** it has no Fulfil/Cancel buttons | |
| 6.7 | Admin: give Customer A `+100` (reason `Cancel test`), then Customer A redeems Starter Voucher again | Balance 50 after redeeming; a new Issued voucher | |
| 6.8 | Admin: **Cancel** this voucher with **no reason** | Refused: a reason is required | |
| 6.9 | **Cancel** it, reason `Out of stock at store` | Status Cancelled; Customer A's balance back to **150**; ledger has `refund` +100 expiring 60 days from **today**; stock back up by 1 | |
| 6.10 | Customer A: **My vouchers** | One Fulfilled, one Cancelled | |
| 6.11 | Admin **Ledger**, filter by type `redeem` | Only redeem lines; click one to open the user | |

## 7. Brand admin (tenant_admin)

Sign out, then sign in as `brand@demo.test`.

| # | Do | Expect | Result |
|---|---|---|---|
| 7.1 | Look at the top of the panel | **No** brand selector; only Demo Plywood | |
| 7.2 | **Users** | The same Customer A as before | |
| 7.3 | **Settings**: OTP limits and MSG91 fields | Read-only (greyed out) | |
| 7.4 | In the same browser open http://localhost:3000/admin/api/t/demo-laminates/users | `{"error":"tenant_not_found"}`: the other brand looks as if it does not exist | |
| 7.5 | Change the **Tagline**, save; reload the customer app | New tagline shown | |
| 7.6 | Sign out; sign in with a wrong password **5 times**, then the right one | Locked: still refused with the right password | |
| 7.7 | Unlock with the command below, then sign in | The command prints `1` (a warning about using a password on the command line is normal); sign-in works | |

Unlock command for 7.7 (in the project folder):
```bash
redis-cli -u "$(grep ^REDIS_URL .env | cut -d= -f2-)" del adm:rl:email:brand@demo.test
```

## 8. Brands are separate

| # | Do | Expect | Result |
|---|---|---|---|
| 8.1 | New private window: http://localhost:3000/t/demo-laminates/scan | Teal theme, "+10 pending" | |
| 8.2 | Verify with Customer A's number `9999900001` / `000000` | **Profile screen**: a new account, because it is a different brand | |
| 8.3 | Finish the profile; check My points | Balance **10**, not 150 | |
| 8.4 | Super admin: select `demo-laminates` → Users | Only this new account; Demo Plywood's balance is not visible here | |

## 9. Pending points on a second customer

| # | Do | Expect | Result |
|---|---|---|---|
| 9.1 | New private window: app URL for `demo` | +10 pending | |
| 9.2 | Verify as Customer B `9999900002`, profile with category **Contractor** | Balance **10** | |
| 9.3 | Admin **Users** | Customer B listed first (newest) with balance 10 | |

## 10. Nightly expiry job

| # | Do | Expect | Result |
|---|---|---|---|
| 10.1 | `npm run expire` | One line per brand, e.g. `demo: expired 0 points from 0 credits for 0 users; 0 vouchers` (nothing is 60 days old yet) | |
| 10.2 | Run it again | Same output, no errors: safe to repeat | |

## 11. Tidy up

- In **Settings**, check that the cooldown is back to 10 and the tagline is what you want to show.
- The test customers and admins can stay for the demo. To start the demo from a clean balance, use a new phone number (for example `9999900003`).
- Real SMS is **not** part of this test. It needs the DLT setup in MSG91 first ([STATUS.md](STATUS.md)).

## Result

| Section | Pass | Fail | Notes |
|---|---|---|---|
| 0 Setup | | | |
| 1 Admin accounts | | | |
| 2 Super admin panel | | | |
| 3 Customer journey | | | |
| 4 Scan limits | | | |
| 5 Adjustments | | | |
| 6 Redeem, fulfil, cancel | | | |
| 7 Brand admin | | | |
| 8 Brands separate | | | |
| 9 Second customer | | | |
| 10 Expiry job | | | |

Tested by: ________  Date: ________
