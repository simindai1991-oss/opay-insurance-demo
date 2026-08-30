"""Lightweight FastAPI backend for OPay Insurance Demo."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from server import store
from server import timetravel

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

app = FastAPI(title="OPay Insurance Demo API", version="0.1.0")

MODE_MONTHS = {"MONTHLY": 1, "QUARTERLY": 3, "BIANNUAL": 6, "ANNUAL": 12}
LIST_PRICE_KEY = {
    "MONTHLY": "monthlyPrice",
    "QUARTERLY": "quarterlyPrice",
    "BIANNUAL": "biannualPrice",
    "ANNUAL": "annualPrice",
}


def now_iso() -> str:
    meta = store.read_table("meta")
    if meta.get("demoNow"):
        return meta["demoNow"]
    return datetime.now(timezone(timedelta(hours=1))).isoformat()


def parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def add_months(d: datetime, months: int) -> datetime:
    m = d.month - 1 + months
    y = d.year + m // 12
    m = m % 12 + 1
    day = min(d.day, [31, 29 if y % 4 == 0 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1])
    return d.replace(year=y, month=m, day=day)


def first_period_amount(plan: dict, mode: str) -> int:
    """MONTHLY => 0; else (N-1)*monthlyPrice."""
    n = MODE_MONTHS[mode]
    monthly = int(plan["monthlyPrice"])
    if mode == "MONTHLY":
        return 0
    return (n - 1) * monthly


def list_price(plan: dict, mode: str) -> int:
    return int(plan[LIST_PRICE_KEY[mode]])


def get_plan(plan_code: str) -> dict:
    plans = store.read_table("insurance_plan_config")
    for p in plans:
        if p["planCode"] == plan_code and p.get("isActive", True):
            return p
    raise HTTPException(404, f"Plan not found: {plan_code}")


# ---------- models ----------
class PersonCreate(BaseModel):
    relationType: str
    firstName: str
    lastName: str
    nin: str
    phone: str
    dob: str
    gender: int
    isDefault: bool = False
    photoUrl: Optional[str] = None


class PersonUpdate(BaseModel):
    firstName: str
    lastName: str
    nin: str
    phone: str
    dob: str
    gender: int


class EnrollRequest(BaseModel):
    planCode: str
    personId: str
    paymentMode: str
    autoRenewEnabled: bool = True


class AutoRenewBody(BaseModel):
    enabled: bool


class ReactivateBody(BaseModel):
    paymentMode: Optional[str] = None


class TimeTravelBody(BaseModel):
    days: int = Field(1, ge=1, le=365)


class RenewSuccessBody(BaseModel):
    enabled: bool


# ---------- lifecycle ----------
@app.on_event("startup")
def _startup() -> None:
    store.ensure_store()


# ---------- demo ----------
@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "mode": "api"}


@app.get("/api/meta")
def get_meta() -> Any:
    return store.read_table("meta")


@app.post("/api/demo/reset")
def demo_reset() -> dict:
    store.reset_store()
    return {"ok": True}


@app.post("/api/demo/time-travel")
def demo_time_travel(body: TimeTravelBody) -> dict:
    return timetravel.advance_days(body.days)


@app.post("/api/demo/renew-success")
def demo_renew_success(body: RenewSuccessBody) -> dict:
    meta = store.read_table("meta")
    meta["renewPaymentSuccess"] = body.enabled
    store.write_table("meta", meta)
    timetravel.set_last_op(
        "RENEW_SWITCH",
        f"renewPaymentSuccess={body.enabled}",
        {"meta": [meta]},
    )
    return meta


@app.get("/api/debug/dump")
def debug_dump() -> dict:
    return {name: store.read_table(name) for name in store.TABLES}


@app.get("/api/debug/last-op")
def debug_last_op() -> Any:
    meta = store.read_table("meta")
    return meta.get("lastOp")


# ---------- plans ----------
@app.get("/api/plans")
def list_plans(category: Optional[str] = None) -> list:
    plans = [p for p in store.read_table("insurance_plan_config") if p.get("isActive", True)]
    if category and category != "ALL":
        plans = [p for p in plans if p.get("category") == category]
    return sorted(plans, key=lambda x: x.get("sortOrder", 99))


@app.get("/api/plans/{plan_code}")
def plan_detail(plan_code: str) -> dict:
    return get_plan(plan_code)


# ---------- persons ----------
@app.get("/api/persons")
def list_persons() -> list:
    meta = store.read_table("meta")
    uid = meta.get("demoUserId", "user_demo_001")
    return [p for p in store.read_table("user_insured_person") if p["userId"] == uid]


@app.post("/api/persons")
def create_person(body: PersonCreate) -> dict:
    meta = store.read_table("meta")
    uid = meta.get("demoUserId", "user_demo_001")
    people = store.read_table("user_insured_person")
    if any(p["nin"] == body.nin for p in people):
        raise HTTPException(400, "NIN already exists")
    person = {
        "personId": store.next_id("person"),
        "userId": uid,
        **body.model_dump(),
    }
    if body.isDefault:
        for p in people:
            p["isDefault"] = False
    people.append(person)
    store.write_table("user_insured_person", people)
    return person


@app.patch("/api/persons/{person_id}")
def update_person(person_id: str, body: PersonUpdate) -> dict:
    people = store.read_table("user_insured_person")
    for p in people:
        if p["personId"] != person_id:
            continue
        if any(x["nin"] == body.nin and x["personId"] != person_id for x in people):
            raise HTTPException(400, "NIN already exists")
        p["firstName"] = body.firstName
        p["lastName"] = body.lastName
        p["nin"] = body.nin
        p["phone"] = body.phone
        p["dob"] = body.dob
        p["gender"] = body.gender
        store.write_table("user_insured_person", people)
        timetravel.set_last_op(
            "UPDATE_PERSON",
            f"Updated {p['firstName']} {p['lastName']} (new enrollments only)",
            {"user_insured_person": [p]},
        )
        return p
    raise HTTPException(404, "Person not found")


# ---------- policies ----------
@app.get("/api/policies")
def list_policies() -> list:
    meta = store.read_table("meta")
    uid = meta.get("demoUserId", "user_demo_001")
    return [p for p in store.read_table("policy_master") if p["userId"] == uid]


@app.get("/api/policies/{policy_id}")
def get_policy(policy_id: str) -> dict:
    for p in store.read_table("policy_master"):
        if p["policyId"] == policy_id:
            return p
    raise HTTPException(404, "Policy not found")


@app.get("/api/policies/{policy_id}/timeline")
def policy_timeline(policy_id: str) -> list:
    rows = [t for t in store.read_table("policy_status_timeline") if t["policyId"] == policy_id]
    return sorted(rows, key=lambda x: x["createdAt"])


@app.get("/api/policies/{policy_id}/transactions")
def policy_transactions(policy_id: str) -> list:
    rows = [t for t in store.read_table("policy_payment_transaction") if t["policyId"] == policy_id]
    return sorted(rows, key=lambda x: x["tradeTime"], reverse=True)


@app.get("/api/policies/{policy_id}/schedules")
def policy_schedules(policy_id: str) -> list:
    rows = [t for t in store.read_table("policy_billing_schedule") if t["policyId"] == policy_id]
    return sorted(rows, key=lambda x: x["periodNumber"])


@app.post("/api/policies/{policy_id}/auto-renew")
def set_auto_renew(policy_id: str, body: AutoRenewBody) -> dict:
    policies = store.read_table("policy_master")
    for p in policies:
        if p["policyId"] == policy_id:
            if p["status"] in ("EXPIRED", "TERMINATED"):
                raise HTTPException(400, "Cannot toggle auto-renew on ended policy")
            p["autoRenewEnabled"] = body.enabled
            p["updatedAt"] = now_iso()
            store.write_table("policy_master", policies)
            return p
    raise HTTPException(404, "Policy not found")


@app.post("/api/policies/{policy_id}/activate-pending")
def activate_pending(policy_id: str) -> dict:
    """Flip PENDING_ENROLLMENT -> ACTIVE after demo delay (client calls after 5s)."""
    policies = store.read_table("policy_master")
    timelines = store.read_table("policy_status_timeline")
    for p in policies:
        if p["policyId"] == policy_id:
            if p["status"] != "PENDING_ENROLLMENT":
                return p
            p["status"] = "ACTIVE"
            p["pendingUntil"] = None
            p["updatedAt"] = now_iso()
            timelines.append(
                {
                    "timelineId": store.next_id("tl"),
                    "policyId": policy_id,
                    "actionType": "INITIAL_ENROLL",
                    "status": "ACTIVE",
                    "coverageStartDate": p["currentCycleStart"],
                    "coverageEndDate": p["currentCycleEnd"],
                    "continuousStaySnapshot": p["continuousStayMonths"],
                    "createdAt": now_iso(),
                }
            )
            store.write_table("policy_master", policies)
            store.write_table("policy_status_timeline", timelines)
            timetravel.set_last_op(
                "ACTIVATE",
                f"Policy {policy_id} ACTIVE",
                {"policy_master": [p], "policy_status_timeline": [timelines[-1]]},
            )
            return p
    raise HTTPException(404, "Policy not found")


@app.post("/api/policies/{policy_id}/reactivate")
def reactivate(policy_id: str, body: ReactivateBody = ReactivateBody()) -> dict:
    policies = store.read_table("policy_master")
    schedules = store.read_table("policy_billing_schedule")
    txns = store.read_table("policy_payment_transaction")
    timelines = store.read_table("policy_status_timeline")
    for p in policies:
        if p["policyId"] != policy_id:
            continue
        if p["status"] not in ("EXPIRED", "TERMINATED"):
            raise HTTPException(400, "Policy is not eligible for reactivate")
        plan = get_plan(p["planCode"])
        mode = body.paymentMode or p["paymentMode"]
        amount = list_price(plan, mode)
        start = parse_dt(now_iso())
        months = MODE_MONTHS[mode]
        end = add_months(start, months) - timedelta(days=1)
        p["status"] = "ACTIVE"
        p["paymentMode"] = mode
        p["continuousStayMonths"] = int(p.get("continuousStayMonths") or 0) + months
        p["autoRenewEnabled"] = True
        p["currentCycleStart"] = start.date().isoformat()
        p["currentCycleEnd"] = end.date().isoformat()
        p["nextBillingDate"] = end.date().isoformat()
        p["policyYearStart"] = start.date().isoformat()
        p["policyYearEnd"] = (add_months(start, 12) - timedelta(days=1)).date().isoformat()
        p["updatedAt"] = now_iso()
        sch_id = store.next_id("sch")
        txn_id = store.next_id("txn")
        schedules.append(
            {
                "scheduleId": sch_id,
                "policyId": policy_id,
                "periodNumber": max([s["periodNumber"] for s in schedules if s["policyId"] == policy_id] + [0]) + 1,
                "paymentMode": mode,
                "coverageStartDate": p["currentCycleStart"],
                "coverageEndDate": p["currentCycleEnd"],
                "expectedAmount": amount,
                "dueDate": p["currentCycleStart"],
                "status": "PAID",
                "createdAt": now_iso(),
            }
        )
        txns.append(
            {
                "transactionId": txn_id,
                "scheduleId": sch_id,
                "policyId": policy_id,
                "tradeAmount": amount,
                "paymentMethod": "OPAY_WALLET_AUTO_DEDUCT",
                "tradeStatus": "SUCCESS",
                "gatewayRefCode": store.next_id("GW"),
                "errorMessage": None,
                "tradeTime": now_iso(),
            }
        )
        timelines.append(
            {
                "timelineId": store.next_id("tl"),
                "policyId": policy_id,
                "actionType": "RE_ACTIVATE",
                "status": "ACTIVE",
                "coverageStartDate": p["currentCycleStart"],
                "coverageEndDate": p["currentCycleEnd"],
                "continuousStaySnapshot": p["continuousStayMonths"],
                "createdAt": now_iso(),
            }
        )
        store.write_table("policy_master", policies)
        store.write_table("policy_billing_schedule", schedules)
        store.write_table("policy_payment_transaction", txns)
        store.write_table("policy_status_timeline", timelines)
        timetravel.set_last_op(
            "RE_ACTIVATE",
            f"Policy {policy_id} reactivated stay={p['continuousStayMonths']}",
            {
                "policy_master": [p],
                "policy_billing_schedule": [schedules[-1]],
                "policy_payment_transaction": [txns[-1]],
                "policy_status_timeline": [timelines[-1]],
            },
        )
        return p
    raise HTTPException(404, "Policy not found")


@app.post("/api/policies/{policy_id}/pay-now")
def pay_now(policy_id: str) -> dict:
    """Resume a SUSPENDED policy by paying the current cycle premium."""
    policies = store.read_table("policy_master")
    schedules = store.read_table("policy_billing_schedule")
    txns = store.read_table("policy_payment_transaction")
    timelines = store.read_table("policy_status_timeline")
    for p in policies:
        if p["policyId"] != policy_id:
            continue
        if p["status"] != "SUSPENDED":
            raise HTTPException(400, "Pay now is only available for suspended policies")
        plan = get_plan(p["planCode"])
        mode = p["paymentMode"]
        amount = list_price(plan, mode)
        start = parse_dt(now_iso())
        months = MODE_MONTHS[mode]
        end = add_months(start, months) - timedelta(days=1)
        p["status"] = "ACTIVE"
        p["currentCycleStart"] = start.date().isoformat()
        p["currentCycleEnd"] = end.date().isoformat()
        p["nextBillingDate"] = end.date().isoformat()
        p["continuousStayMonths"] = int(p.get("continuousStayMonths") or 0) + months
        p["updatedAt"] = now_iso()
        sch_id = store.next_id("sch")
        txn_id = store.next_id("txn")
        period = max([s["periodNumber"] for s in schedules if s["policyId"] == policy_id] + [0]) + 1
        schedules.append(
            {
                "scheduleId": sch_id,
                "policyId": policy_id,
                "periodNumber": period,
                "paymentMode": mode,
                "coverageStartDate": p["currentCycleStart"],
                "coverageEndDate": p["currentCycleEnd"],
                "expectedAmount": amount,
                "dueDate": p["currentCycleStart"],
                "status": "PAID",
                "createdAt": now_iso(),
            }
        )
        txns.append(
            {
                "transactionId": txn_id,
                "scheduleId": sch_id,
                "policyId": policy_id,
                "tradeAmount": amount,
                "paymentMethod": "OPAY_WALLET_AUTO_DEDUCT",
                "tradeStatus": "SUCCESS",
                "gatewayRefCode": store.next_id("GW"),
                "errorMessage": None,
                "tradeTime": now_iso(),
            }
        )
        timelines.append(
            {
                "timelineId": store.next_id("tl"),
                "policyId": policy_id,
                "actionType": "MANUAL_PAY",
                "status": "ACTIVE",
                "coverageStartDate": p["currentCycleStart"],
                "coverageEndDate": p["currentCycleEnd"],
                "continuousStaySnapshot": p["continuousStayMonths"],
                "createdAt": now_iso(),
            }
        )
        store.write_table("policy_master", policies)
        store.write_table("policy_billing_schedule", schedules)
        store.write_table("policy_payment_transaction", txns)
        store.write_table("policy_status_timeline", timelines)
        timetravel.set_last_op(
            "PAY_NOW",
            f"Policy {policy_id} paid {amount} → ACTIVE",
            {
                "policy_master": [p],
                "policy_billing_schedule": [schedules[-1]],
                "policy_payment_transaction": [txns[-1]],
                "policy_status_timeline": [timelines[-1]],
            },
        )
        return p
    raise HTTPException(404, "Policy not found")


@app.post("/api/enroll")
def enroll(body: EnrollRequest) -> dict:
    if body.paymentMode not in MODE_MONTHS:
        raise HTTPException(400, "Invalid paymentMode")
    plan = get_plan(body.planCode)
    if body.paymentMode not in plan.get("supportedPaymentModes", []):
        raise HTTPException(400, "Payment mode not supported for plan")
    people = store.read_table("user_insured_person")
    person = next((x for x in people if x["personId"] == body.personId), None)
    if not person:
        raise HTTPException(404, "Person not found")

    # duplicate active same plan+person block
    policies = store.read_table("policy_master")
    for p in policies:
        if (
            p["personId"] == body.personId
            and p["planCode"] == body.planCode
            and p["status"] in ("ACTIVE", "PENDING_ENROLLMENT", "PENDING_RENEWAL", "SUSPENDED")
        ):
            raise HTTPException(400, "Duplicate enrollment blocked for this person/plan")

    amount = first_period_amount(plan, body.paymentMode)
    start = parse_dt(now_iso())
    months = MODE_MONTHS[body.paymentMode]
    end = add_months(start, months) - timedelta(days=1)
    pending_until = (parse_dt(now_iso()) + timedelta(seconds=5)).isoformat()

    enrollee_id = store.next_id("enr")
    membership = f"{plan['underwriterCode'][:3].upper()}-{store.next_id('M')[-6:]}"
    enrollees = store.read_table("enrollee_profile")
    enrollees.append(
        {
            "enrolleeId": enrollee_id,
            "personId": body.personId,
            "userId": person["userId"],
            "underwriterCode": plan["underwriterCode"],
            "membershipNo": membership,
            "cifNumber": store.next_id("CIF"),
            "firstEnrolledDate": start.date().isoformat(),
        }
    )

    policy_id = store.next_id("pol")
    policy = {
        "policyId": policy_id,
        "userId": person["userId"],
        "personId": body.personId,
        "enrolleeId": enrollee_id,
        "planCode": body.planCode,
        "policyNumber": membership,
        "paymentMode": body.paymentMode,
        "policyYearStart": start.date().isoformat(),
        "policyYearEnd": (add_months(start, 12) - timedelta(days=1)).date().isoformat(),
        "currentCycleStart": start.date().isoformat(),
        "currentCycleEnd": end.date().isoformat(),
        "nextBillingDate": end.date().isoformat(),
        "status": "PENDING_ENROLLMENT",
        "continuousStayMonths": months,
        "autoRenewEnabled": body.autoRenewEnabled,
        "pendingUntil": pending_until,  # 【EXTRA】
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }
    policies.append(policy)

    sch_id = store.next_id("sch")
    schedules = store.read_table("policy_billing_schedule")
    schedules.append(
        {
            "scheduleId": sch_id,
            "policyId": policy_id,
            "periodNumber": 1,
            "paymentMode": body.paymentMode,
            "coverageStartDate": policy["currentCycleStart"],
            "coverageEndDate": policy["currentCycleEnd"],
            "expectedAmount": amount,
            "dueDate": policy["currentCycleStart"],
            "status": "PAID",
            "createdAt": now_iso(),
        }
    )
    txns = store.read_table("policy_payment_transaction")
    txns.append(
        {
            "transactionId": store.next_id("txn"),
            "scheduleId": sch_id,
            "policyId": policy_id,
            "tradeAmount": amount,
            "paymentMethod": "OPAY_WALLET_AUTO_DEDUCT",
            "tradeStatus": "SUCCESS",
            "gatewayRefCode": store.next_id("GW"),
            "errorMessage": None,
            "tradeTime": now_iso(),
        }
    )
    timelines = store.read_table("policy_status_timeline")
    timelines.append(
        {
            "timelineId": store.next_id("tl"),
            "policyId": policy_id,
            "actionType": "INITIAL_ENROLL",
            "status": "PENDING_ENROLLMENT",
            "coverageStartDate": policy["currentCycleStart"],
            "coverageEndDate": policy["currentCycleEnd"],
            "continuousStaySnapshot": months,
            "createdAt": now_iso(),
        }
    )

    store.write_table("enrollee_profile", enrollees)
    store.write_table("policy_master", policies)
    store.write_table("policy_billing_schedule", schedules)
    store.write_table("policy_payment_transaction", txns)
    store.write_table("policy_status_timeline", timelines)
    timetravel.set_last_op(
        "ENROLL",
        f"Created policy {policy_id} PENDING_ENROLLMENT payable={amount}",
        {
            "policy_master": [policy],
            "enrollee_profile": [enrollees[-1]],
            "policy_billing_schedule": [schedules[-1]],
            "policy_payment_transaction": [txns[-1]],
            "policy_status_timeline": [timelines[-1]],
        },
    )
    return {"policy": policy, "payableAmount": amount, "membershipNo": membership}


@app.get("/api/pricing/preview")
def pricing_preview(planCode: str, paymentMode: str, personId: str | None = None) -> dict:
    plan = get_plan(planCode)
    if paymentMode not in MODE_MONTHS:
        raise HTTPException(400, "Invalid paymentMode")
    list_price = plan.get(
        {
            "MONTHLY": "monthlyPrice",
            "QUARTERLY": "quarterlyPrice",
            "BIANNUAL": "biannualPrice",
            "ANNUAL": "annualPrice",
        }[paymentMode]
    )
    payable = first_period_amount(plan, paymentMode)
    first_period_eligible = True
    if personId:
        policies = store.read_table("policy_master")
        if any(
            p["personId"] == personId
            and p["planCode"] == planCode
            and p["status"] == "ACTIVE"
            for p in policies
        ):
            payable = list_price
            first_period_eligible = False
    return {
        "planCode": planCode,
        "paymentMode": paymentMode,
        "listPrice": list_price,
        "payableAmount": payable,
        "recurringAmount": list_price,
        "firstPeriodEligible": first_period_eligible,
        "rule": "MONTHLY first period free (0); else (months-1)*monthlyPrice",
    }


# ---------- covers ----------
@app.get("/api/plans/{plan_code}/covers")
def list_covers(plan_code: str) -> list:
    rows = store.read_table("plan_cover_config")
    return sorted(
        [c for c in rows if c.get("planCode") == plan_code],
        key=lambda x: x.get("sortOrder", 99),
    )


# ---------- hospitals ----------
@app.get("/api/hospitals")
def list_hospitals(
    planCode: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    lga: Optional[str] = Query(None),
) -> list:
    rows = store.read_table("hospitals")
    if planCode:
        rows = [h for h in rows if planCode in h.get("planCodes", [])]
    if state:
        rows = [h for h in rows if h.get("state") == state]
    if lga:
        rows = [h for h in rows if h.get("lga") == lga]
    return rows


# ---------- static web ----------
@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB / "index.html")


app.mount("/data/seed", StaticFiles(directory=str(ROOT / "data" / "seed")), name="seed")
app.mount("/css", StaticFiles(directory=str(WEB / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(WEB / "js")), name="js")
app.mount("/assets", StaticFiles(directory=str(WEB / "assets")), name="assets")
