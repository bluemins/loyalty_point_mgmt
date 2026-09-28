# User guide: earning and redeeming points

For the people who scan the QR code: carpenters, contractors and other customers of a brand on the platform. It explains every screen and exactly how points are counted. The screenshots show the "Demo Plywood" brand; your brand's name, colours and rewards will differ.

The numbers below (10 points per scan, 5 scans a day, and so on) are the default rules. Each brand can change them; the app always uses the brand's current rules.

## In short

1. **Scan** the QR code printed on the product or at the shop. It opens a web page. No app to install, no login needed.
2. Each scan earns **10 points**.
3. **Verify your phone** once with an SMS code to keep your points.
4. **Redeem** points for rewards and get a **voucher code** to show at the store.

---

## The screens

### 1. Scan result

Scanning the QR opens the brand's page and records your scan straight away.

![Scan result, points pending](images/user-01-scan-pending.png)

- **Not verified yet**: your points show as **pending**. They are saved on this phone for 30 days. Tap **Verify phone to claim** to keep them.
- **Already logged in**: the points go straight into your account (**+10 points added**), and **See my points** takes you to your points.
- Below, **Rewards you can earn** shows the brand's rewards. Swipe sideways to see them all.

Scanning again too soon, or too often in one day, is recorded but earns nothing:

| You scanned recently | Daily limit reached |
|---|---|
| ![Cooldown](images/user-10-scan-cooldown.png) | ![Daily limit](images/user-11-scan-daily-limit.png) |
| Wait 10 minutes after a scan that earned points. The message says how long is left. | Up to 5 scans a day earn points. The count starts again at midnight (India time). |

### 2. Verify your phone

![Enter your phone number](images/user-02-phone.png)

1. Enter your 10-digit mobile number (the +91 is already there) and tap **Send code**.
2. You receive a 6-digit code by SMS. Enter it; the app checks it as soon as all 6 digits are in.

![Wrong code](images/user-03-code-wrong.png)

- A wrong code shows how many tries are left. You get **5 tries per code**.
- A code works for **5 minutes**. After that, or after 5 wrong tries, tap **Resend code** (available 30 seconds after sending).
- You can request a code **3 times in 15 minutes**. After that, wait for the time shown.
- Wrong number? Tap **Change**.

You only do this once per phone: the app remembers you for 30 days, or until you tap **Log out**.

### 3. Create your profile (first time only)

![Profile](images/user-04-profile.png)

Enter your name and choose what describes you (for example Carpenter, Contractor, End User; the brand sets the list). The note at the top shows the pending points that will be added. Tap **Continue**.

If your phone number is already registered with this brand, you skip this screen and go straight to your points; any pending points on this phone are added.

### 4. My points

![Points home](images/user-05-home.png)

- **The ring** shows your balance in the middle. It fills up toward the cheapest reward you cannot afford yet; the line under it says how many more points you need, or how many rewards you can redeem now.
- **Expiring soon** (only shown when it applies): points that will expire in the next 7 days, by date. Redeem them before then.
- **Redeem rewards** opens the rewards.
- **Activity**: every change to your points, newest first:

| Entry | Meaning |
|---|---|
| **+ Scan reward** | Points from a scan |
| **− Redeemed** | Points used for a reward |
| **↺ Voucher refund** | Points returned because the brand cancelled a voucher |
| **± Adjustment** | Points added or removed by the brand (for example as a goodwill gesture or to correct a mistake) |
| **× Points expired** | Points that reached their expiry date unused |

### 5. Rewards

![Rewards](images/user-06-rewards.png)

- Each card shows the reward, its cost in points and a **Redeem** button.
- If you do not have enough points, the button says how many more you need (for example **Need 200 more**).
- **Out of stock** rewards cannot be redeemed until the brand restocks them.

Tapping **Redeem** asks you to confirm and shows what you will have left:

![Confirm](images/user-07-confirm.png)

Tapping **Redeem** twice, or a network problem, cannot charge you twice: the app sends one request per confirmation, and the server treats a repeat of it as the same redemption. If the connection drops, tap **Try again**.

### 6. Your voucher

![Voucher](images/user-08-voucher.png)

- The **voucher code** (like `K7MQ-3XRD-9P`) is what you show at the store. The code never contains the easily confused characters 0/O or 1/I.
- **Copy code** copies it to your phone.
- **Valid until**: the voucher can be used for 30 days.

### 7. My vouchers

![My vouchers](images/user-09-my-vouchers.png)

On the rewards screen, **My vouchers** lists every voucher you have received. Tap one to see its code again.

| Status | Meaning |
|---|---|
| **Issued** | Ready to use at the store |
| **Fulfilled** | Used; the store has given you the reward |
| **Cancelled** | Cancelled by the brand; your points were returned |
| **Expired** | Not used within its validity; the points are **not** returned |

---

## How points work

### Earning

| Rule | Default |
|---|---|
| Points per scan | 10 |
| Time you must wait after a scan that earned points | 10 minutes |
| Scans that earn points per day | 5 (a day runs midnight to midnight, India time) |

- A scan that is too soon or over the daily limit is still recorded, but earns nothing and **does not restart** the 10-minute wait.
- The **daily limit** applies to **you** across all your phones: pending scans from another phone are checked against what you already earned that day when they are added.
- The **10-minute wait** applies per phone, and logging in on the same phone does not reset it.

### Pending points (before you verify)

- Scans before you verify your phone are held as **pending** on that phone for **30 days**.
- They are added to your account when you verify (or create your profile) **on the same phone**.
- When they are added, the daily limit still applies to the day each scan happened. For example, if you already earned 5 scans on Monday on another phone, pending Monday scans from this phone cannot add more for Monday.
- Pending points not claimed within 30 days are lost.

### Expiry

- **Every batch of points expires 60 days after it was added to your account.** Pending points count from the moment they are added (when you verify), not from the scan.
- Your balance only counts points that have not expired.
- The **Expiring soon** card warns you 7 days ahead.

### Redeeming

- A reward costs a fixed number of points.
- Your **oldest points are used first**, which also uses up points closest to expiry first.
- A voucher is valid for **30 days**. After that it expires and the points are not returned.
- If the brand cancels your voucher (for example, the reward is out of stock at the store), the points come back as a new batch valid for another 60 days.

### Worked example

| Date | What happens | Balance |
|---|---|---|
| 1 March, 10:00 | Scan without logging in: **+10 pending** | 0 (10 pending) |
| 1 March, 10:04 | Scan again: too soon, nothing earned | 0 (10 pending) |
| 1 March, 10:20 | Verify phone, create profile: the pending 10 are added, expiring 30 April | **10** |
| 1 March, 10:31 … 13:00 | 4 more scans, each more than 10 minutes apart: +40 | **50** |
| 1 March, 15:00 | 6th scan of the day: daily limit, nothing earned | 50 |
| 2 March … 20 March | Regular scans earn 250 more | **300** |
| 21 March | Redeem **Trade Pack** (250): the oldest 250 points are used | **50** |
| 30 April | The last of the 1 March points expire, if still unspent | fewer |

## Common questions

**I scanned but my points are not there.** Check the message on the scan screen: it may have been too soon (10 minutes) or over the daily limit. If you scanned before verifying, verify on the **same phone** to claim them.

**I changed phones.** Scan on the new phone and verify with the same number; your points and vouchers are linked to your phone number, not the device. Pending points on the old phone stay there until you verify on it.

**I got a new phone number.** A new number is a new account. Ask the brand to move your points (they can adjust points in their admin panel).

**My points disappeared.** Points expire 60 days after they were added. Look for **× Points expired** in your activity.

**The code didn't arrive.** Wait a minute, check the number, then tap **Resend code**. After 3 codes in 15 minutes you need to wait.
