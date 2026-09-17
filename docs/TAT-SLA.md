# TAT engine — what every clock measures

All values are in **minutes**. Targets live in `backend/.env`; change a value, restart the
server, and every screen and report re-grades immediately (nothing is baked into the database).

---

## 1. Trip TAT (one leg — sample pickup **or** blood delivery)

Both legs use the identical stage machine, so both are measured the same way.

| Clock | From → To | Env target | Default |
|---|---|---|---|
| **Accept** | assigned → runner tapped ACCEPT | `SLA_ACCEPT` | 3 |
| **To pickup** | accepted → reached pickup point | `SLA_REACH_PICKUP` | 45 |
| **Pickup dwell** | reached pickup → sample/units picked | `SLA_PICKUP_DWELL` | 10 |
| **To drop** | picked → reached drop point | `SLA_REACH_DROP` | 45 |
| **Drop dwell** | reached drop → completed | `SLA_DROP_DWELL` | 10 |
| **Trip total** | assigned → completed | `SLA_TRIP_TOTAL` | 110 |

For the **sample leg**: pickup = hospital, drop = blood centre.
For the **delivery leg**: pickup = blood centre, drop = hospital.

## 2. Case TAT (the whole cycle)

| Clock | From → To | Target | Default |
|---|---|---|---|
| **To assign** | case created at the desk → runner assigned | `SLA_ACCEPT` × 2 | 6 |
| **Sample pickup** | the whole sample trip | `SLA_TRIP_TOTAL` | 110 |
| **Crossmatch** | crossmatch started → crossmatch done (lab leg) | `SLA_CROSSMATCH` | 60 |
| **Delivery** | the whole delivery trip | `SLA_TRIP_TOTAL` | 110 |
| **Case total** | case created → blood delivered / case closed | `SLA_CASE_TOTAL` | 240 |

The crossmatch clock is the only one that is **not** the runner's fault — that's the point of
measuring it separately. When a case breaches, this tells you instantly whether the delay was
the road or the lab.

---

## 3. Colour grading

| Grade | Rule | Colour |
|---|---|---|
| `ok` | under 80% of target | green |
| `warn` | 80–100% of target | amber |
| `breach` | over target | red |
| `na` | stage not reached yet | grey |

A trip's headline colour is its **worst** stage, not its average — one bad stage is not allowed
to hide behind four good ones.

---

## 4. Live clocks

Any trip that is not `COMPLETED` / `REJECTED` / `CANCELLED` is **running**. For a running trip
every unfinished stage is measured against *right now*, which is why:

- the runner sees his visit timer counting up on the phone,
- the desk sees the same number counting up on the job card,
- a job that has been sitting un-accepted for 4 minutes already shows red — before anyone
  has to notice it.

The dashboard recomputes these client-side every second and pulls fresh server numbers every
15 seconds, so the clock is smooth but never drifts from the server's truth.

---

## 5. Where the numbers come from

Every stage button on the phone sends `{stage, lat, lng, accuracy, timestamp}`. The server
stamps the time **server-side** — the phone's clock is never trusted — and stores the GPS point
with it. Location pings (every 20 s by default, `PING_INTERVAL`) are stored in `LocationPing`
with a **45-day TTL**, and those points are what draw the breadcrumb trail and compute km
travelled in the runner scorecard.

So every TAT row is defensible: you can open any trip and see the map trail plus the exact
place each stage was marked.

---

## 6. Tuning advice

Don't argue about targets on day one. Run two weeks with the defaults, then:

1. **Reports → Trip TAT** → export CSV.
2. In Excel, take the **median** of each stage column, separately for sample legs and delivery legs.
3. Set the target at roughly median + 25%. That gives you a target most runners hit on a normal
   day and only miss when something is genuinely wrong.
4. Revisit after monsoon — Ahmedabad traffic changes the "to pickup" number more than anything else.

If dwell times are constantly breaching, it is usually **not** the runner — it's the hospital
ward or the lab counter making him wait. That's a client conversation, and now you have the data
for it.
