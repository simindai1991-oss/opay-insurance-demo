/** Dual-mode API: Local FastAPI OR seed JSON + localStorage */
(function () {
  const TABLES = [
    'meta',
    'insurance_plan_config',
    'user_insured_person',
    'enrollee_profile',
    'policy_master',
    'policy_status_timeline',
    'policy_billing_schedule',
    'policy_payment_transaction',
    'hospitals',
    'plan_cover_config',
  ];

  const cfg = () => window.DEMO_CONFIG;
  const MODE_MONTHS = { MONTHLY: 1, QUARTERLY: 3, BIANNUAL: 6, ANNUAL: 12 };
  const LIST_KEY = {
    MONTHLY: 'monthlyPrice',
    QUARTERLY: 'quarterlyPrice',
    BIANNUAL: 'biannualPrice',
    ANNUAL: 'annualPrice',
  };

  function isLocalDev() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  }

  function getModeOverride() {
    if (!isLocalDev()) return null;
    const v = localStorage.getItem(cfg().modeOverrideKey);
    return v === 'api' || v === 'static' ? v : null;
  }

  function setModeOverride(mode) {
    localStorage.setItem(cfg().modeOverrideKey, mode);
    window.__DEMO_MODE_RESOLVED = mode;
  }

  function clearModeOverride() {
    localStorage.removeItem(cfg().modeOverrideKey);
    window.__DEMO_MODE_RESOLVED = undefined;
  }

  function resolveMode() {
    const override = getModeOverride();
    if (override) return override;
    const m = cfg().mode;
    if (m === 'api' || m === 'static') return m;
    return window.__DEMO_MODE_RESOLVED || 'static';
  }

  async function detectMode() {
    const override = getModeOverride();
    if (override) {
      window.__DEMO_MODE_RESOLVED = override;
      return override;
    }
    if (cfg().mode !== 'auto') {
      window.__DEMO_MODE_RESOLVED = cfg().mode;
      return cfg().mode;
    }
    try {
      const r = await fetch((cfg().apiBase || '') + '/api/health', { cache: 'no-store' });
      if (r.ok) {
        window.__DEMO_MODE_RESOLVED = 'api';
        return 'api';
      }
    } catch (_) {}
    window.__DEMO_MODE_RESOLVED = 'static';
    return 'static';
  }

  function lsGet() {
    const raw = localStorage.getItem(cfg().storageKey);
    return raw ? JSON.parse(raw) : null;
  }
  function lsSet(db) {
    localStorage.setItem(cfg().storageKey, JSON.stringify(db));
  }

  async function loadSeedTable(name) {
    const r = await fetch(`${cfg().seedBase}/${name}.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Seed missing: ${name}`);
    return r.json();
  }

  async function ensureStaticDb() {
    let db = lsGet();
    if (db && db.__version === 4) return db;
    db = { __version: 4 };
    for (const t of TABLES) db[t] = await loadSeedTable(t);
    lsSet(db);
    return db;
  }

  function nextId(prefix) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 900 + 100)}`;
  }

  function nowIso(db) {
    if (db.meta && db.meta.demoNow) return db.meta.demoNow;
    return new Date().toISOString();
  }

  function parseDate(s) {
    if (!s) return new Date();
    if (s.length === 10) return new Date(s + 'T12:00:00');
    return new Date(s);
  }

  function addMonths(date, months) {
    const d = new Date(date);
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);
    if (d.getDate() < day) d.setDate(0);
    return d;
  }

  function ymd(d) {
    return d.toISOString().slice(0, 10);
  }

  function firstPeriodAmount(plan, mode) {
    return window.Pricing.firstPeriodAmount(plan, mode);
  }

  function cloneMetaSnapshot(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    const { lastOp, ...rest } = meta;
    return structuredClone(rest);
  }

  function sanitizeAffected(affected) {
    if (!affected || typeof affected !== 'object') return affected;
    const out = {};
    for (const [key, val] of Object.entries(affected)) {
      if (key === 'meta' && Array.isArray(val)) {
        out.meta = val.map((m) => cloneMetaSnapshot(m));
      } else if (Array.isArray(val)) {
        out[key] = val.map((item) => (item && typeof item === 'object' ? structuredClone(item) : item));
      } else {
        out[key] = val;
      }
    }
    return out;
  }

  function setLastOp(db, action, summary, affected) {
    db.meta.lastOp = {
      at: new Date().toISOString(),
      action,
      summary,
      affected: sanitizeAffected(affected),
    };
  }

  async function apiFetch(path, options) {
    const r = await fetch((cfg().apiBase || '') + path, {
      headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
      ...options,
    });
    if (!r.ok) {
      let msg = r.statusText;
      try {
        const j = await r.json();
        msg = j.detail || JSON.stringify(j);
      } catch (_) {}
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    if (r.status === 204) return null;
    return r.json();
  }

  function markExpired(db, p, until, events, reason) {
    const before = Number(p.continuousStayMonths || 0);
    p.status = 'EXPIRED';
    p.continuousStayMonths = 0;
    p.autoRenewEnabled = false;
    p.updatedAt = until.toISOString();
    db.policy_status_timeline.push({
      timelineId: nextId('tl'),
      policyId: p.policyId,
      actionType: 'POLICY_EXPIRED',
      status: 'EXPIRED',
      coverageStartDate: p.currentCycleStart,
      coverageEndDate: p.currentCycleEnd,
      continuousStaySnapshot: 0,
      createdAt: until.toISOString(),
    });
    events.push(`${p.policyId}: →EXPIRED (${reason}, stay reset ${before}→0)`);
  }

  function processDue(db, until) {
    const events = [];
    const success = db.meta.renewPaymentSuccess !== false;
    const plans = Object.fromEntries(db.insurance_plan_config.map((p) => [p.planCode, p]));

    for (const p of db.policy_master) {
      if (!['ACTIVE', 'SUSPENDED', 'PENDING_RENEWAL'].includes(p.status)) continue;

      if (!p.autoRenewEnabled) {
        if (parseDate(p.currentCycleEnd) < until && p.status !== 'EXPIRED') {
          markExpired(db, p, until, events, 'auto-renew off');
        }
        continue;
      }

      for (let guard = 0; guard < 24; guard++) {
        const nextBill = parseDate(p.nextBillingDate);
        if (ymd(nextBill) > ymd(until)) break;
        if (['EXPIRED', 'TERMINATED'].includes(p.status)) break;
        const plan = plans[p.planCode];
        if (!plan) break;
        const mode = p.paymentMode;
        const months = MODE_MONTHS[mode];
        const amount = Number(plan[LIST_KEY[mode]]);
        const period =
          Math.max(0, ...db.policy_billing_schedule.filter((s) => s.policyId === p.policyId).map((s) => s.periodNumber)) +
          1;
        let covStart = new Date(parseDate(p.currentCycleEnd));
        covStart.setDate(covStart.getDate() + 1);
        const covEnd = addMonths(covStart, months);
        covEnd.setDate(covEnd.getDate() - 1);
        const schId = nextId('sch');
        const sch = {
          scheduleId: schId,
          policyId: p.policyId,
          periodNumber: period,
          paymentMode: mode,
          coverageStartDate: ymd(covStart),
          coverageEndDate: ymd(covEnd),
          expectedAmount: amount,
          dueDate: ymd(nextBill),
          status: 'PROCESSING',
          createdAt: until.toISOString(),
        };
        db.policy_billing_schedule.push(sch);

        if (success) {
          sch.status = 'PAID';
          db.policy_payment_transaction.push({
            transactionId: nextId('txn'),
            scheduleId: schId,
            policyId: p.policyId,
            tradeAmount: amount,
            paymentMethod: 'OPAY_WALLET_AUTO_DEDUCT',
            tradeStatus: 'SUCCESS',
            gatewayRefCode: nextId('GW'),
            errorMessage: null,
            tradeTime: until.toISOString(),
          });
          p.status = 'ACTIVE';
          p.currentCycleStart = ymd(covStart);
          p.currentCycleEnd = ymd(covEnd);
          p.nextBillingDate = ymd(covEnd);
          p.continuousStayMonths = Number(p.continuousStayMonths || 0) + months;
          p.updatedAt = until.toISOString();
          db.policy_status_timeline.push({
            timelineId: nextId('tl'),
            policyId: p.policyId,
            actionType: 'AUTO_RENEW',
            status: 'ACTIVE',
            coverageStartDate: p.currentCycleStart,
            coverageEndDate: p.currentCycleEnd,
            continuousStaySnapshot: p.continuousStayMonths,
            createdAt: until.toISOString(),
          });
          events.push(`${p.policyId}: renew SUCCESS stay=${p.continuousStayMonths}`);
        } else {
          sch.status = 'FAILED';
          db.policy_payment_transaction.push({
            transactionId: nextId('txn'),
            scheduleId: schId,
            policyId: p.policyId,
            tradeAmount: amount,
            paymentMethod: 'OPAY_WALLET_AUTO_DEDUCT',
            tradeStatus: 'FAILED',
            gatewayRefCode: null,
            errorMessage: 'Insufficient Balance (demo fail switch)',
            tradeTime: until.toISOString(),
          });
          const retry = new Date(nextBill);
          retry.setDate(retry.getDate() + 1);
          p.nextBillingDate = ymd(retry);
          if (ymd(until) > p.currentCycleEnd) {
            p.status = 'SUSPENDED';
            const daysPast =
              (until - parseDate(p.currentCycleEnd)) / (24 * 3600 * 1000);
            db.policy_status_timeline.push({
              timelineId: nextId('tl'),
              policyId: p.policyId,
              actionType: 'AUTO_RENEW',
              status: 'SUSPENDED',
              coverageStartDate: p.currentCycleStart,
              coverageEndDate: p.currentCycleEnd,
              continuousStaySnapshot: p.continuousStayMonths,
              createdAt: until.toISOString(),
            });
            if (daysPast >= 7) {
              markExpired(db, p, until, events, 'renew fail grace exhausted');
              break;
            }
            events.push(`${p.policyId}: renew FAIL → SUSPENDED`);
          } else {
            events.push(`${p.policyId}: renew FAIL (in cover)`);
          }
          break;
        }
      }
    }
    return events;
  }

  const Static = {
    async getMeta() {
      const db = await ensureStaticDb();
      return db.meta;
    },
    async getPlans() {
      const db = await ensureStaticDb();
      return (db.insurance_plan_config || [])
        .filter((p) => p.isActive !== false)
        .sort((a, b) => (a.sortOrder || 99) - (b.sortOrder || 99));
    },
    async getPlan(code) {
      const plans = await this.getPlans();
      const p = plans.find((x) => x.planCode === code);
      if (!p) throw new Error('Plan not found');
      return p;
    },
    async getPersons() {
      const db = await ensureStaticDb();
      return db.user_insured_person.filter((p) => p.userId === db.meta.demoUserId);
    },
    async createPerson(body) {
      const db = await ensureStaticDb();
      if (db.user_insured_person.some((p) => p.nin === body.nin)) throw new Error('NIN already exists');
      if (body.isDefault) db.user_insured_person.forEach((p) => (p.isDefault = false));
      const person = { personId: nextId('person'), userId: db.meta.demoUserId, ...body };
      db.user_insured_person.push(person);
      setLastOp(db, 'CREATE_PERSON', `Added ${person.firstName} ${person.lastName}`, {
        user_insured_person: [person],
      });
      lsSet(db);
      return person;
    },
    async updatePerson(id, body) {
      const db = await ensureStaticDb();
      const p = db.user_insured_person.find((x) => x.personId === id);
      if (!p) throw new Error('Person not found');
      if (db.user_insured_person.some((x) => x.nin === body.nin && x.personId !== id)) {
        throw new Error('NIN already exists');
      }
      Object.assign(p, body);
      setLastOp(db, 'UPDATE_PERSON', `Updated ${p.firstName} ${p.lastName} (new enrollments only)`, {
        user_insured_person: [structuredClone(p)],
      });
      lsSet(db);
      return p;
    },
    async getCovers(planCode) {
      const db = await ensureStaticDb();
      return (db.plan_cover_config || [])
        .filter((c) => c.planCode === planCode)
        .sort((a, b) => (a.sortOrder || 99) - (b.sortOrder || 99));
    },
    async getPolicies() {
      const db = await ensureStaticDb();
      return db.policy_master.filter((p) => p.userId === db.meta.demoUserId);
    },
    async getPolicy(id) {
      const db = await ensureStaticDb();
      const p = db.policy_master.find((x) => x.policyId === id);
      if (!p) throw new Error('Policy not found');
      return p;
    },
    async timeline(id) {
      const db = await ensureStaticDb();
      return db.policy_status_timeline
        .filter((t) => t.policyId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async transactions(id) {
      const db = await ensureStaticDb();
      return db.policy_payment_transaction
        .filter((t) => t.policyId === id)
        .sort((a, b) => b.tradeTime.localeCompare(a.tradeTime));
    },
    async setAutoRenew(id, enabled) {
      const db = await ensureStaticDb();
      const p = db.policy_master.find((x) => x.policyId === id);
      if (!p) throw new Error('Policy not found');
      if (['EXPIRED', 'TERMINATED'].includes(p.status)) throw new Error('Cannot toggle auto-renew on ended policy');
      p.autoRenewEnabled = enabled;
      p.updatedAt = nowIso(db);
      setLastOp(db, 'AUTO_RENEW_TOGGLE', `${id} autoRenew=${enabled}`, { policy_master: [structuredClone(p)] });
      lsSet(db);
      return p;
    },
    async activatePending(id) {
      const db = await ensureStaticDb();
      const p = db.policy_master.find((x) => x.policyId === id);
      if (!p) throw new Error('Policy not found');
      if (p.status !== 'PENDING_ENROLLMENT') return p;
      p.status = 'ACTIVE';
      p.pendingUntil = null;
      p.updatedAt = nowIso(db);
      const tl = {
        timelineId: nextId('tl'),
        policyId: id,
        actionType: 'INITIAL_ENROLL',
        status: 'ACTIVE',
        coverageStartDate: p.currentCycleStart,
        coverageEndDate: p.currentCycleEnd,
        continuousStaySnapshot: p.continuousStayMonths,
        createdAt: nowIso(db),
      };
      db.policy_status_timeline.push(tl);
      setLastOp(db, 'ACTIVATE', `Policy ${id} ACTIVE`, {
        policy_master: [structuredClone(p)],
        policy_status_timeline: [tl],
      });
      lsSet(db);
      return p;
    },
    async enroll(body) {
      const db = await ensureStaticDb();
      const plan = db.insurance_plan_config.find((p) => p.planCode === body.planCode);
      if (!plan) throw new Error('Plan not found');
      const person = db.user_insured_person.find((p) => p.personId === body.personId);
      if (!person) throw new Error('Person not found');
      const blocked = db.policy_master.some(
        (p) =>
          p.personId === body.personId &&
          p.planCode === body.planCode &&
          ['ACTIVE', 'PENDING_ENROLLMENT', 'PENDING_RENEWAL', 'SUSPENDED'].includes(p.status)
      );
      if (blocked) throw new Error('Duplicate enrollment blocked for this person/plan');

      const amount = firstPeriodAmount(plan, body.paymentMode);
      const start = parseDate(nowIso(db));
      const months = MODE_MONTHS[body.paymentMode];
      const end = addMonths(start, months);
      end.setDate(end.getDate() - 1);
      const pendingUntil = new Date(Date.now() + (cfg().activatePendingMs || 5000)).toISOString();
      const enrolleeId = nextId('enr');
      const membership = `${plan.underwriterCode.slice(0, 3).toUpperCase()}-${nextId('M').slice(-6)}`;
      const enrollee = {
        enrolleeId,
        personId: body.personId,
        userId: person.userId,
        underwriterCode: plan.underwriterCode,
        membershipNo: membership,
        cifNumber: nextId('CIF'),
        firstEnrolledDate: ymd(start),
      };
      db.enrollee_profile.push(enrollee);
      const policyId = nextId('pol');
      const policy = {
        policyId,
        userId: person.userId,
        personId: body.personId,
        enrolleeId,
        planCode: body.planCode,
        policyNumber: membership,
        paymentMode: body.paymentMode,
        policyYearStart: ymd(start),
        policyYearEnd: ymd(addMonths(start, 12)),
        currentCycleStart: ymd(start),
        currentCycleEnd: ymd(end),
        nextBillingDate: ymd(end),
        status: 'PENDING_ENROLLMENT',
        continuousStayMonths: months,
        autoRenewEnabled: body.autoRenewEnabled !== false,
        pendingUntil,
        createdAt: nowIso(db),
        updatedAt: nowIso(db),
      };
      db.policy_master.push(policy);
      const schId = nextId('sch');
      const sch = {
        scheduleId: schId,
        policyId,
        periodNumber: 1,
        paymentMode: body.paymentMode,
        coverageStartDate: policy.currentCycleStart,
        coverageEndDate: policy.currentCycleEnd,
        expectedAmount: amount,
        dueDate: policy.currentCycleStart,
        status: 'PAID',
        createdAt: nowIso(db),
      };
      db.policy_billing_schedule.push(sch);
      const txn = {
        transactionId: nextId('txn'),
        scheduleId: schId,
        policyId,
        tradeAmount: amount,
        paymentMethod: 'OPAY_WALLET_AUTO_DEDUCT',
        tradeStatus: 'SUCCESS',
        gatewayRefCode: nextId('GW'),
        errorMessage: null,
        tradeTime: nowIso(db),
      };
      db.policy_payment_transaction.push(txn);
      const tl = {
        timelineId: nextId('tl'),
        policyId,
        actionType: 'INITIAL_ENROLL',
        status: 'PENDING_ENROLLMENT',
        coverageStartDate: policy.currentCycleStart,
        coverageEndDate: policy.currentCycleEnd,
        continuousStaySnapshot: months,
        createdAt: nowIso(db),
      };
      db.policy_status_timeline.push(tl);
      setLastOp(db, 'ENROLL', `Created ${policyId} payable=${amount}`, {
        policy_master: [policy],
        enrollee_profile: [enrollee],
        policy_billing_schedule: [sch],
        policy_payment_transaction: [txn],
        policy_status_timeline: [tl],
      });
      lsSet(db);
      return { policy, payableAmount: amount, membershipNo: membership };
    },
    async reactivate(id, paymentMode) {
      const db = await ensureStaticDb();
      const p = db.policy_master.find((x) => x.policyId === id);
      if (!p) throw new Error('Policy not found');
      if (!['EXPIRED', 'TERMINATED'].includes(p.status)) {
        throw new Error('Policy is not eligible for reactivate');
      }
      const plan = db.insurance_plan_config.find((x) => x.planCode === p.planCode);
      const mode = paymentMode || p.paymentMode;
      const months = MODE_MONTHS[mode];
      const amount = window.Pricing.listPrice(plan, mode);
      const start = parseDate(nowIso(db));
      const end = addMonths(start, months);
      end.setDate(end.getDate() - 1);
      p.status = 'ACTIVE';
      p.paymentMode = mode;
      p.continuousStayMonths = Number(p.continuousStayMonths || 0) + months;
      p.autoRenewEnabled = true;
      p.currentCycleStart = ymd(start);
      p.currentCycleEnd = ymd(end);
      p.nextBillingDate = p.currentCycleEnd;
      p.updatedAt = nowIso(db);
      const schId = nextId('sch');
      const period =
        Math.max(0, ...db.policy_billing_schedule.filter((s) => s.policyId === id).map((s) => s.periodNumber)) + 1;
      const sch = {
        scheduleId: schId,
        policyId: id,
        periodNumber: period,
        paymentMode: mode,
        coverageStartDate: p.currentCycleStart,
        coverageEndDate: p.currentCycleEnd,
        expectedAmount: amount,
        dueDate: p.currentCycleStart,
        status: 'PAID',
        createdAt: nowIso(db),
      };
      db.policy_billing_schedule.push(sch);
      const txn = {
        transactionId: nextId('txn'),
        scheduleId: schId,
        policyId: id,
        tradeAmount: amount,
        paymentMethod: 'OPAY_WALLET_AUTO_DEDUCT',
        tradeStatus: 'SUCCESS',
        gatewayRefCode: nextId('GW'),
        errorMessage: null,
        tradeTime: nowIso(db),
      };
      db.policy_payment_transaction.push(txn);
      const tl = {
        timelineId: nextId('tl'),
        policyId: id,
        actionType: 'RE_ACTIVATE',
        status: 'ACTIVE',
        coverageStartDate: p.currentCycleStart,
        coverageEndDate: p.currentCycleEnd,
        continuousStaySnapshot: p.continuousStayMonths,
        createdAt: nowIso(db),
      };
      db.policy_status_timeline.push(tl);
      setLastOp(db, 'RE_ACTIVATE', `Policy ${id} reactivated stay=${p.continuousStayMonths}`, {
        policy_master: [structuredClone(p)],
        policy_billing_schedule: [sch],
        policy_payment_transaction: [txn],
        policy_status_timeline: [tl],
      });
      lsSet(db);
      return p;
    },
    async payNow(id) {
      const db = await ensureStaticDb();
      const p = db.policy_master.find((x) => x.policyId === id);
      if (!p) throw new Error('Policy not found');
      if (p.status !== 'SUSPENDED') throw new Error('Pay now is only available for suspended policies');
      const plan = db.insurance_plan_config.find((x) => x.planCode === p.planCode);
      const mode = p.paymentMode;
      const months = MODE_MONTHS[mode];
      const amount = Number(plan[LIST_KEY[mode]]);
      const start = parseDate(nowIso(db));
      const end = addMonths(start, months);
      end.setDate(end.getDate() - 1);
      p.status = 'ACTIVE';
      p.currentCycleStart = ymd(start);
      p.currentCycleEnd = ymd(end);
      p.nextBillingDate = p.currentCycleEnd;
      p.continuousStayMonths = Number(p.continuousStayMonths || 0) + months;
      p.updatedAt = nowIso(db);
      const schId = nextId('sch');
      const period =
        Math.max(0, ...db.policy_billing_schedule.filter((s) => s.policyId === id).map((s) => s.periodNumber)) + 1;
      const sch = {
        scheduleId: schId,
        policyId: id,
        periodNumber: period,
        paymentMode: mode,
        coverageStartDate: p.currentCycleStart,
        coverageEndDate: p.currentCycleEnd,
        expectedAmount: amount,
        dueDate: p.currentCycleStart,
        status: 'PAID',
        createdAt: nowIso(db),
      };
      db.policy_billing_schedule.push(sch);
      const txn = {
        transactionId: nextId('txn'),
        scheduleId: schId,
        policyId: id,
        tradeAmount: amount,
        paymentMethod: 'OPAY_WALLET_AUTO_DEDUCT',
        tradeStatus: 'SUCCESS',
        gatewayRefCode: nextId('GW'),
        errorMessage: null,
        tradeTime: nowIso(db),
      };
      db.policy_payment_transaction.push(txn);
      const tl = {
        timelineId: nextId('tl'),
        policyId: id,
        actionType: 'MANUAL_PAY',
        status: 'ACTIVE',
        coverageStartDate: p.currentCycleStart,
        coverageEndDate: p.currentCycleEnd,
        continuousStaySnapshot: p.continuousStayMonths,
        createdAt: nowIso(db),
      };
      db.policy_status_timeline.push(tl);
      setLastOp(db, 'PAY_NOW', `Policy ${id} paid ${amount} → ACTIVE`, {
        policy_master: [structuredClone(p)],
        policy_billing_schedule: [sch],
        policy_payment_transaction: [txn],
        policy_status_timeline: [tl],
      });
      lsSet(db);
      return p;
    },
    async hospitals(planCode, filters = {}) {
      const db = await ensureStaticDb();
      let rows = db.hospitals || [];
      if (planCode) rows = rows.filter((h) => (h.planCodes || []).includes(planCode));
      if (filters.state) rows = rows.filter((h) => h.state === filters.state);
      if (filters.lga) rows = rows.filter((h) => h.lga === filters.lga);
      return rows;
    },
    async reset() {
      localStorage.removeItem(cfg().storageKey);
      await ensureStaticDb();
      return { ok: true };
    },
    async pricingPreview(planCode, paymentMode) {
      const plan = await this.getPlan(planCode);
      return {
        planCode,
        paymentMode,
        listPrice: window.Pricing.listPrice(plan, paymentMode),
        payableAmount: firstPeriodAmount(plan, paymentMode),
        recurringAmount: window.Pricing.listPrice(plan, paymentMode),
      };
    },
    async dump() {
      const db = await ensureStaticDb();
      const out = {};
      for (const t of TABLES) out[t] = db[t];
      return out;
    },
    async lastOp() {
      const db = await ensureStaticDb();
      return db.meta.lastOp;
    },
    async setRenewSuccess(enabled) {
      const db = await ensureStaticDb();
      db.meta.renewPaymentSuccess = enabled;
      setLastOp(db, 'RENEW_SWITCH', `renewPaymentSuccess=${enabled}`, { meta: [db.meta] });
      lsSet(db);
      return db.meta;
    },
    async timeTravel(days) {
      const db = await ensureStaticDb();
      const base = parseDate(nowIso(db));
      const events = [];
      let cursor = new Date(base);
      for (let i = 0; i < days; i++) {
        cursor.setDate(cursor.getDate() + 1);
        events.push(...processDue(db, new Date(cursor)));
      }
      db.meta.demoNow = cursor.toISOString();
      setLastOp(db, 'TIME_TRAVEL', `Advanced +${days}d → ${ymd(cursor)}; ${events.length} events`, {
        events,
        meta: [db.meta],
        policy_master: db.policy_master,
        policy_billing_schedule: db.policy_billing_schedule,
        policy_payment_transaction: db.policy_payment_transaction,
        policy_status_timeline: db.policy_status_timeline,
      });
      lsSet(db);
      return { demoNow: db.meta.demoNow, events };
    },
  };

  const Api = {
    getMeta: () => apiFetch('/api/meta'),
    getPlans: () => apiFetch('/api/plans'),
    getPlan: (code) => apiFetch(`/api/plans/${encodeURIComponent(code)}`),
    getCovers: (code) => apiFetch(`/api/plans/${encodeURIComponent(code)}/covers`),
    getPersons: () => apiFetch('/api/persons'),
    createPerson: (body) => apiFetch('/api/persons', { method: 'POST', body: JSON.stringify(body) }),
    updatePerson: (id, body) =>
      apiFetch(`/api/persons/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    getPolicies: () => apiFetch('/api/policies'),
    getPolicy: (id) => apiFetch(`/api/policies/${encodeURIComponent(id)}`),
    timeline: (id) => apiFetch(`/api/policies/${encodeURIComponent(id)}/timeline`),
    transactions: (id) => apiFetch(`/api/policies/${encodeURIComponent(id)}/transactions`),
    setAutoRenew: (id, enabled) =>
      apiFetch(`/api/policies/${encodeURIComponent(id)}/auto-renew`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    activatePending: (id) =>
      apiFetch(`/api/policies/${encodeURIComponent(id)}/activate-pending`, { method: 'POST', body: '{}' }),
    enroll: (body) => apiFetch('/api/enroll', { method: 'POST', body: JSON.stringify(body) }),
    reactivate: (id, paymentMode) =>
      apiFetch(`/api/policies/${encodeURIComponent(id)}/reactivate`, {
        method: 'POST',
        body: JSON.stringify({ paymentMode }),
      }),
    payNow: (id) =>
      apiFetch(`/api/policies/${encodeURIComponent(id)}/pay-now`, { method: 'POST', body: '{}' }),
    hospitals: (planCode, filters = {}) => {
      const q = new URLSearchParams();
      if (planCode) q.set('planCode', planCode);
      if (filters.state) q.set('state', filters.state);
      if (filters.lga) q.set('lga', filters.lga);
      const qs = q.toString();
      return apiFetch('/api/hospitals' + (qs ? `?${qs}` : ''));
    },
    reset: () => apiFetch('/api/demo/reset', { method: 'POST', body: '{}' }),
    pricingPreview: async (planCode, paymentMode) => {
      const r = await apiFetch(
        `/api/pricing/preview?planCode=${encodeURIComponent(planCode)}&paymentMode=${encodeURIComponent(paymentMode)}`
      );
      const plan = await apiFetch(`/api/plans/${encodeURIComponent(planCode)}`);
      r.recurringAmount = window.Pricing.listPrice(plan, paymentMode);
      return r;
    },
    dump: () => apiFetch('/api/debug/dump'),
    lastOp: () => apiFetch('/api/debug/last-op'),
    setRenewSuccess: (enabled) =>
      apiFetch('/api/demo/renew-success', { method: 'POST', body: JSON.stringify({ enabled }) }),
    timeTravel: (days) => apiFetch('/api/demo/time-travel', { method: 'POST', body: JSON.stringify({ days }) }),
  };

  function client() {
    return resolveMode() === 'api' ? Api : Static;
  }

  window.DemoApi = {
    detectMode,
    getMode: resolveMode,
    isLocalDev,
    canToggleMode: isLocalDev,
    getModeOverride,
    setModeOverride,
    clearModeOverride,
    toggleModeOverride() {
      const next = resolveMode() === 'api' ? 'static' : 'api';
      setModeOverride(next);
      return next;
    },
    async ready() {
      await detectMode();
      if (resolveMode() === 'static') await ensureStaticDb();
    },
    getMeta: (...a) => client().getMeta(...a),
    getPlans: (...a) => client().getPlans(...a),
    getPlan: (...a) => client().getPlan(...a),
    getCovers: (...a) => client().getCovers(...a),
    getPersons: (...a) => client().getPersons(...a),
    createPerson: (...a) => client().createPerson(...a),
    updatePerson: (...a) => client().updatePerson(...a),
    getPolicies: (...a) => client().getPolicies(...a),
    getPolicy: (...a) => client().getPolicy(...a),
    timeline: (...a) => client().timeline(...a),
    transactions: (...a) => client().transactions(...a),
    setAutoRenew: (...a) => client().setAutoRenew(...a),
    activatePending: (...a) => client().activatePending(...a),
    enroll: (...a) => client().enroll(...a),
    reactivate: (...a) => client().reactivate(...a),
    payNow: (...a) => client().payNow(...a),
    hospitals: (...a) => client().hospitals(...a),
    reset: (...a) => client().reset(...a),
    pricingPreview: (...a) => client().pricingPreview(...a),
    dump: (...a) => client().dump(...a),
    lastOp: (...a) => client().lastOp(...a),
    setRenewSuccess: (...a) => client().setRenewSuccess(...a),
    timeTravel: (...a) => client().timeTravel(...a),
  };
})();
