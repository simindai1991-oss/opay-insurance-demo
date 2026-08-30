"""Time-travel billing / status transitions for demo."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any

from server import store

MODE_MONTHS = {"MONTHLY": 1, "QUARTERLY": 3, "BIANNUAL": 6, "ANNUAL": 12}
LIST_PRICE_KEY = {
    "MONTHLY": "monthlyPrice",
    "QUARTERLY": "quarterlyPrice",
    "BIANNUAL": "biannualPrice",
    "ANNUAL": "annualPrice",
}


def parse_dt(s: str) -> datetime:
    if len(s) == 10:
        return datetime.fromisoformat(s).replace(tzinfo=timezone(timedelta(hours=1)))
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def add_months(d: datetime, months: int) -> datetime:
    m = d.month - 1 + months
    y = d.year + m // 12
    m = m % 12 + 1
    day = min(
        d.day,
        [31, 29 if y % 4 == 0 and (y % 100 != 0 or y % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1],
    )
    return d.replace(year=y, month=m, day=day)


def date_str(d: datetime) -> str:
    return d.date().isoformat()


def now_dt() -> datetime:
    meta = store.read_table("meta")
    if meta.get("demoNow"):
        return parse_dt(meta["demoNow"])
    return datetime.now(timezone(timedelta(hours=1)))


def set_last_op(action: str, summary: str, affected: dict[str, Any]) -> None:
    meta = store.read_table("meta")
    meta["lastOp"] = {
        "at": datetime.now(timezone(timedelta(hours=1))).isoformat(),
        "action": action,
        "summary": summary,
        "affected": affected,
    }
    store.write_table("meta", meta)


def plans_by_code() -> dict[str, dict]:
    return {p["planCode"]: p for p in store.read_table("insurance_plan_config")}


def mark_expired(
    p: dict,
    until: datetime,
    timelines: list,
    events: list[str],
    reason: str,
) -> None:
    before_stay = int(p.get("continuousStayMonths") or 0)
    p["status"] = "EXPIRED"
    p["continuousStayMonths"] = 0
    p["autoRenewEnabled"] = False
    p["updatedAt"] = until.isoformat()
    timelines.append(
        {
            "timelineId": store.next_id("tl"),
            "policyId": p["policyId"],
            "actionType": "POLICY_EXPIRED",
            "status": "EXPIRED",
            "coverageStartDate": p["currentCycleStart"],
            "coverageEndDate": p["currentCycleEnd"],
            "continuousStaySnapshot": 0,
            "createdAt": until.isoformat(),
        }
    )
    events.append(f"{p['policyId']}: →EXPIRED ({reason}, stay reset {before_stay}→0)")


def process_due_billings(until: datetime) -> list[str]:
    """Run auto-renew attempts for policies whose nextBillingDate <= until.date()."""
    events: list[str] = []
    meta = store.read_table("meta")
    success = bool(meta.get("renewPaymentSuccess", True))
    plans = plans_by_code()
    policies = store.read_table("policy_master")
    schedules = store.read_table("policy_billing_schedule")
    txns = store.read_table("policy_payment_transaction")
    timelines = store.read_table("policy_status_timeline")

    for p in policies:
        if p["status"] not in ("ACTIVE", "SUSPENDED", "PENDING_RENEWAL"):
            continue
        if not p.get("autoRenewEnabled"):
            if parse_dt(p["currentCycleEnd"]).date() < until.date():
                mark_expired(p, until, timelines, events, "auto-renew off")
            continue

        guard = 0
        while guard < 24:
            guard += 1
            next_bill = parse_dt(p["nextBillingDate"])
            if next_bill.date() > until.date():
                break
            if p["status"] in ("EXPIRED", "TERMINATED"):
                break

            plan = plans.get(p["planCode"])
            if not plan:
                break
            mode = p["paymentMode"]
            months = MODE_MONTHS[mode]
            amount = int(plan[LIST_PRICE_KEY[mode]])
            period = max([s["periodNumber"] for s in schedules if s["policyId"] == p["policyId"]] + [0]) + 1
            cov_start = parse_dt(p["currentCycleEnd"]) + timedelta(days=1)
            cov_end = add_months(cov_start, months) - timedelta(days=1)

            sch_id = store.next_id("sch")
            txn_id = store.next_id("txn")
            schedules.append(
                {
                    "scheduleId": sch_id,
                    "policyId": p["policyId"],
                    "periodNumber": period,
                    "paymentMode": mode,
                    "coverageStartDate": date_str(cov_start),
                    "coverageEndDate": date_str(cov_end),
                    "expectedAmount": amount,
                    "dueDate": date_str(next_bill),
                    "status": "PROCESSING",
                    "createdAt": until.isoformat(),
                }
            )

            if success:
                schedules[-1]["status"] = "PAID"
                txns.append(
                    {
                        "transactionId": txn_id,
                        "scheduleId": sch_id,
                        "policyId": p["policyId"],
                        "tradeAmount": amount,
                        "paymentMethod": "OPAY_WALLET_AUTO_DEDUCT",
                        "tradeStatus": "SUCCESS",
                        "gatewayRefCode": store.next_id("GW"),
                        "errorMessage": None,
                        "tradeTime": until.isoformat(),
                    }
                )
                p["status"] = "ACTIVE"
                p["currentCycleStart"] = date_str(cov_start)
                p["currentCycleEnd"] = date_str(cov_end)
                p["nextBillingDate"] = date_str(cov_end)
                p["continuousStayMonths"] = int(p.get("continuousStayMonths") or 0) + months
                p["updatedAt"] = until.isoformat()
                timelines.append(
                    {
                        "timelineId": store.next_id("tl"),
                        "policyId": p["policyId"],
                        "actionType": "AUTO_RENEW",
                        "status": "ACTIVE",
                        "coverageStartDate": p["currentCycleStart"],
                        "coverageEndDate": p["currentCycleEnd"],
                        "continuousStaySnapshot": p["continuousStayMonths"],
                        "createdAt": until.isoformat(),
                    }
                )
                events.append(f"{p['policyId']}: renew SUCCESS +{months}m stay={p['continuousStayMonths']}")
            else:
                schedules[-1]["status"] = "FAILED"
                txns.append(
                    {
                        "transactionId": txn_id,
                        "scheduleId": sch_id,
                        "policyId": p["policyId"],
                        "tradeAmount": amount,
                        "paymentMethod": "OPAY_WALLET_AUTO_DEDUCT",
                        "tradeStatus": "FAILED",
                        "gatewayRefCode": None,
                        "errorMessage": "Insufficient Balance (demo fail switch)",
                        "tradeTime": until.isoformat(),
                    }
                )
                p["nextBillingDate"] = date_str(next_bill + timedelta(days=1))
                if until.date() > parse_dt(p["currentCycleEnd"]).date():
                    if p["status"] != "SUSPENDED":
                        p["status"] = "SUSPENDED"
                        timelines.append(
                            {
                                "timelineId": store.next_id("tl"),
                                "policyId": p["policyId"],
                                "actionType": "AUTO_RENEW",
                                "status": "SUSPENDED",
                                "coverageStartDate": p["currentCycleStart"],
                                "coverageEndDate": p["currentCycleEnd"],
                                "continuousStaySnapshot": p["continuousStayMonths"],
                                "createdAt": until.isoformat(),
                            }
                        )
                    if (until.date() - parse_dt(p["currentCycleEnd"]).date()).days >= 7:
                        mark_expired(p, until, timelines, events, "renew fail grace exhausted")
                        break
                    events.append(f"{p['policyId']}: renew FAIL → SUSPENDED")
                else:
                    events.append(f"{p['policyId']}: renew FAIL (still in cover)")
                break

    store.write_table("policy_master", policies)
    store.write_table("policy_billing_schedule", schedules)
    store.write_table("policy_payment_transaction", txns)
    store.write_table("policy_status_timeline", timelines)
    return events


def advance_days(days: int) -> dict[str, Any]:
    base = now_dt()
    target = base + timedelta(days=max(days, 0))
    all_events: list[str] = []
    cursor = base
    # Simulate day-by-day in memory; persist once at end
    for _ in range(max(days, 0)):
        cursor = cursor + timedelta(days=1)
        all_events.extend(process_due_billings(cursor))
    meta = store.read_table("meta")
    meta["demoNow"] = target.isoformat()
    store.write_table("meta", meta)
    set_last_op(
        "TIME_TRAVEL",
        f"Advanced +{days}d → demoNow={target.isoformat()}; {len(all_events)} billing events",
        {
            "events": all_events,
            "meta": [deepcopy(meta)],
            "policy_master": deepcopy(store.read_table("policy_master")),
        },
    )
    return {"demoNow": target.isoformat(), "events": all_events}
