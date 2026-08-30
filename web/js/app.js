const MODE_MONTHS = { MONTHLY: 1, QUARTERLY: 3, BIANNUAL: 6, ANNUAL: 12 };
const MODE_LABEL = {
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  BIANNUAL: 'Bi-annually',
  ANNUAL: 'Annually',
};

const App = {
  state: {
    plans: [],
    policies: [],
    persons: [],
    plan: null,
    policy: null,
    covers: [],
    paymentMode: 'MONTHLY',
    personId: null,
    hospitalsFrom: 'detail',
    hospitalNearby: false,
    hospitalState: '',
    hospitalLga: '',
    hospitalPlanCode: null,
    coversFrom: 'policy',
    policyFrom: 'home',
    payable: 0,
    recurring: 0,
    coverageStart: null,
    coverageEnd: null,
    preview: null,
    payModalAction: 'enroll',
    payModalPolicyId: null,
    editingPersonId: null,
  },

  channelDisclaimer() {
    return `Insurance covers and policies are provided by OPay and partner MFB, with all policies underwritten by third-party partners through the OPay App.`;
  },

  paymentModeNote() {
    return `First period: monthly free (₦0); other modes waive 1 month. Prepaying for longer billing cycles helps build continuous stay faster. Restore and re-activation are charged at full cycle price.`;
  },

  renderPersonChips(persons) {
    return `<div class="person-list">
      ${persons
        .map(
          (person) => `
        <div class="person-chip ${this.state.personId === person.personId ? 'on' : ''}">
          <div class="person-chip-body" onclick="App.pickPerson('${person.personId}')">
            <div>
              <div><strong>${person.firstName} ${person.lastName}</strong> · ${person.relationType}</div>
              <div class="muted">NIN ${person.nin}</div>
            </div>
          </div>
          ${
            person.relationType !== 'SELF'
              ? `<button type="button" class="person-edit-btn" onclick="App.openEditDrawer('${person.personId}')">Edit</button>`
              : ''
          }
        </div>`
        )
        .join('')}
    </div>`;
  },

  async init() {
    await DemoApi.ready();
    this.setupModeBadge();
    document.getElementById('btn-pay').onclick = () => this.openPayModal();
    document.getElementById('btn-pay-confirm').onclick = () => this.confirmPay();
    await this.refresh();
    await Debug.init();
    this.go('home');
  },

  setupModeBadge() {
    const badge = document.getElementById('mode-badge');
    const mode = DemoApi.getMode();
    const override = DemoApi.getModeOverride();
    if (DemoApi.canToggleMode()) {
      badge.textContent = override ? `mode: ${mode} *` : `mode: ${mode} ↕`;
      badge.classList.add('clickable');
      badge.title = 'Click: switch api ↔ static · Shift+click: auto-detect';
      badge.onclick = (e) => this.switchDemoMode(e.shiftKey);
    } else {
      badge.textContent = `mode: ${mode}`;
      badge.classList.remove('clickable');
      badge.removeAttribute('title');
      badge.onclick = null;
    }
  },

  switchDemoMode(clearOverride) {
    if (!DemoApi.canToggleMode()) return;
    if (clearOverride) {
      DemoApi.clearModeOverride();
      this.toast('Mode: auto-detect — reloading…');
    } else {
      const next = DemoApi.toggleModeOverride();
      this.toast(`Mode: ${next} — reloading…`);
    }
    setTimeout(() => location.reload(), 350);
  },

  toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2200);
  },

  go(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const map = {
      home: 'view-home',
      policies: 'view-policies',
      detail: 'view-detail',
      processing: 'view-processing',
      policy: 'view-policy',
      txns: 'view-txns',
      timeline: 'view-timeline',
      hospitals: 'view-hospitals',
      'covers-detail': 'view-covers-detail',
    };
    document.getElementById(map[name]).classList.add('active');
  },

  displayStatus(status) {
    if (status === 'PENDING_ENROLLMENT') return 'Processing';
    return status;
  },

  statusPill(status) {
    const cls = {
      ACTIVE: 'pill-active',
      PENDING_ENROLLMENT: 'pill-pending',
      PENDING_RENEWAL: 'pill-pending',
      SUSPENDED: 'pill-suspended',
      EXPIRED: 'pill-expired',
      TERMINATED: 'pill-terminated',
    }[status] || 'pill-expired';
    return `<span class="pill ${cls}">${this.displayStatus(status)}</span>`;
  },

  thumbEmoji(key) {
    return ({ rose: '🌹', super: '💚', hygeia: '🏥', reliance: '🩺', aiico: '🛡️' }[key] || '📋');
  },

  planHeroWatermark(key) {
    return ({ rose: '🌹', super: '✚', hygeia: '⚕️', reliance: '🩺', aiico: '🛡️' }[key] || '📋');
  },

  planActiveCount(planCode) {
    return this.state.policies.filter((p) => p.planCode === planCode && p.status === 'ACTIVE').length;
  },

  activeCountLabel(n) {
    return n === 1 ? '1 active' : `${n} active`;
  },

  haversineKm(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  },

  cycleLabel(mode) {
    return ({ MONTHLY: 'month', QUARTERLY: 'quarter', BIANNUAL: 'half-year', ANNUAL: 'year' })[mode] || 'cycle';
  },

  planHeroCard(plan) {
    const wm = this.planHeroWatermark(plan.listThumbnail);
    return `
      <div class="card plan-hero">
        <div class="plan-hero-watermark" aria-hidden="true">${wm}</div>
        <div class="plan-hero-content">
          <h2 style="margin:0">${plan.planName}</h2>
          <div class="muted">Provided by ${plan.underwriterCode}</div>
          <div class="row" style="margin-top:14px">
            <div><div class="muted">Annual limit</div><strong>${plan.annualLimitText}</strong></div>
            <div style="text-align:right"><div class="muted">Monthly</div><strong style="color:var(--opay-dark)">${Pricing.formatNaira(plan.monthlyPrice)}</strong></div>
          </div>
        </div>
      </div>`;
  },

  personName(personId) {
    const person = this.state.persons.find((x) => x.personId === personId);
    return person ? `${person.firstName} ${person.lastName}` : personId;
  },

  renderCoversList(covers, { showDetailsLink = false, planCode = '' } = {}) {
    if (!covers.length) return `<div class="muted">No cover configuration for this plan.</div>`;
    return `<ul class="covers-list">
      ${covers
        .map(
          (c) => `
        <li class="cover-item">
          <div class="cover-row">
            <span class="left">
              <span class="dot"></span>
              <span>
                <strong>${c.coverName}</strong>
                <span class="cover-sub">${c.effectiveRuleSubtitle || ''}</span>
              </span>
            </span>
            <span class="right">${c.limitText || ''}</span>
          </div>
        </li>`
        )
        .join('')}
    </ul>
    ${
      showDetailsLink
        ? `<button class="link-btn" style="margin-top:8px" onclick="App.openCoversDetail('${planCode}')">View all cover details →</button>`
        : ''
    }`;
  },

  continuousStayHtml(p) {
    if (p.status === 'EXPIRED') {
      return `<div class="detail-kv detail-kv-stack">
        <span class="k">Continuous stay</span>
        <span class="v-stack">
          <span>0 month(s)</span>
          <span class="stay-note">Continuous stay interrupted</span>
        </span>
      </div>`;
    }
    return `<div class="detail-kv"><span class="k">Continuous stay</span><span>${p.continuousStayMonths} month(s)</span></div>`;
  },

  renderTimelineInline(rows) {
    if (!rows.length) return `<div class="muted" style="margin-top:8px">No status history yet.</div>`;
    const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return `<div class="timeline-inline">
      ${sorted
        .slice(0, 5)
        .map(
          (t) => `
        <div class="timeline-inline-item">
          <div class="row">
            <strong>${t.actionType}</strong>
            ${this.statusPill(t.status)}
          </div>
          <div class="muted">${t.createdAt}</div>
        </div>`
        )
        .join('')}
    </div>`;
  },

  async refresh() {
    this.state.plans = await DemoApi.getPlans();
    this.state.policies = await DemoApi.getPolicies();
    this.state.persons = await DemoApi.getPersons();
    const def = this.state.persons.find((p) => p.isDefault) || this.state.persons[0];
    this.state.personId = this.state.personId || (def && def.personId);
    this.renderHome();
    await Debug.refresh();
  },

  renderHome() {
    const buy = document.getElementById('home-buy');
    const activeCount = this.state.policies.filter((p) => p.status === 'ACTIVE').length;
    const totalCount = this.state.policies.length;

    buy.innerHTML = `
      <div class="card summary-card">
        <div class="row"><strong>My Insurance Policies</strong></div>
        <div class="active-count">${activeCount} Active</div>
        ${
          totalCount
            ? `<button type="button" class="summary-link" onclick="App.openPolicies()">
                You are covered, manage your ${totalCount} polic${totalCount === 1 ? 'y' : 'ies'} ›
              </button>`
            : `<div class="promo">You're unprotected, get protected now</div>`
        }
      </div>
      <div class="section-title"><strong>Available plans</strong></div>
      ${this.state.plans
        .map((p) => {
          const n = this.planActiveCount(p.planCode);
          const tag = n ? `<span class="policy-tag">${this.activeCountLabel(n)}</span>` : '';
          return `
        <div class="card product" onclick="App.openPlan('${p.planCode}')">
          <div class="thumb">${this.thumbEmoji(p.listThumbnail)}</div>
          <div>
            <div class="product-title-row"><h3>${p.planName}</h3>${tag}</div>
            <div class="muted">${p.shortDescription || ''}</div>
            <div class="row" style="margin-top:8px">
              <span class="promo">${p.promoLabel || ''}</span>
              <button class="get-btn" onclick="event.stopPropagation();App.openPlan('${p.planCode}')">Get</button>
            </div>
          </div>
        </div>`;
        })
        .join('')}
      <p class="channel-footer">${this.channelDisclaimer()}</p>
    `;
  },

  openPolicies() {
    const el = document.getElementById('policies-body');
    el.innerHTML = this.state.policies.length
      ? this.state.policies
          .map((p) => {
            const plan = this.state.plans.find((x) => x.planCode === p.planCode);
            return `
          <div class="card" onclick="App.openPolicy('${p.policyId}','policies')" style="cursor:pointer">
            <div class="row">
              <strong>${(plan && plan.planName) || p.planCode}</strong>
              ${this.statusPill(p.status)}
            </div>
            <div class="muted" style="margin-top:6px">${this.personName(p.personId)}</div>
            <div class="muted">${p.policyNumber} · ${MODE_LABEL[p.paymentMode] || p.paymentMode}</div>
            <div class="muted">Validity ${p.currentCycleStart} → ${p.currentCycleEnd}</div>
          </div>`;
          })
          .join('')
      : `<div class="card muted">No policies yet. Buy a plan to get started.</div>`;
    this.go('policies');
  },

  coveragePreview(mode) {
    const start = new Date();
    const months = MODE_MONTHS[mode] || 1;
    const end = new Date(start);
    end.setMonth(end.getMonth() + months);
    end.setDate(end.getDate() - 1);
    const ymd = (d) => d.toISOString().slice(0, 10);
    return { start: ymd(start), end: ymd(end) };
  },

  async openPlan(code) {
    this.state.plan = await DemoApi.getPlan(code);
    this.state.covers = await DemoApi.getCovers(code);
    this.state.paymentMode = (this.state.plan.supportedPaymentModes || ['MONTHLY'])[0];
    await this.renderDetail();
    this.go('detail');
  },

  planPoliciesSection(plan, planPolicies) {
    if (!planPolicies.length) return '';
    return `
      <div class="card card-compact">
        <strong class="compact-title">My policies</strong>
        ${planPolicies
          .map((p) => {
            const amount = Pricing.listPrice(plan, p.paymentMode);
            const freq = MODE_LABEL[p.paymentMode] || p.paymentMode;
            let action = '';
            if (p.status === 'SUSPENDED') {
              action = `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();App.openRestoreModal('${p.policyId}')">Pay Now</button>`;
            } else if (p.status === 'EXPIRED') {
              action = `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();App.openReactivateModal('${p.policyId}')">Re-active</button>`;
            } else if (p.status === 'ACTIVE') {
              action = `<div class="next-debit"><span class="muted">Next debit</span><strong>${p.nextBillingDate}</strong></div>`;
            }
            return `
          <div class="my-policy-compact">
            <div class="my-policy-compact-main">
              <div class="name">${this.personName(p.personId)}</div>
              <div class="meta">${this.statusPill(p.status)} · ${freq} · ${Pricing.formatNaira(amount)}</div>
            </div>
            ${action ? `<div class="my-policy-compact-action">${action}</div>` : ''}
          </div>`;
          })
          .join('')}
      </div>`;
  },

  async renderDetail() {
    const p = this.state.plan;
    const covers = this.state.covers.length ? this.state.covers : await DemoApi.getCovers(p.planCode);
    this.state.covers = covers;
    const modes = p.supportedPaymentModes || ['MONTHLY'];
    const preview = await DemoApi.pricingPreview(p.planCode, this.state.paymentMode);
    const cov = this.coveragePreview(this.state.paymentMode);
    this.state.preview = preview;
    this.state.payable = preview.payableAmount;
    this.state.recurring = preview.recurringAmount || preview.listPrice;
    this.state.coverageStart = cov.start;
    this.state.coverageEnd = cov.end;
    const persons = this.state.persons;
    const brochure = p.brochureName || 'Product Terms & Conditions';
    const brochureUrl = p.brochureUrl || '#';
    const planPolicies = this.state.policies.filter((x) => x.planCode === p.planCode);

    document.getElementById('detail-body').innerHTML = `
      ${this.planHeroCard(p)}

      ${this.planPoliciesSection(p, planPolicies)}

      <div class="card">
        <div class="card-head-row">
          <strong>Covers</strong>
          <button class="link-btn" onclick="App.openCoversDetail('${p.planCode}','detail')">Details</button>
        </div>
        ${this.renderCoversList(covers)}
      </div>

      <div class="card">
        <strong>Payment mode</strong>
        <div class="mode-tabs">
          ${modes
            .map((m) => {
              return `<button class="${this.state.paymentMode === m ? 'on' : ''}" onclick="App.setMode('${m}')">${MODE_LABEL[m] || m}</button>`;
            })
            .join('')}
        </div>
        <div class="row"><span class="muted">Pay now</span><strong style="color:var(--opay-dark)">${Pricing.formatNaira(preview.payableAmount)}</strong></div>
        <div class="row" style="margin-top:6px"><span class="muted">Then each cycle</span><strong>${Pricing.formatNaira(this.state.recurring)}</strong></div>
        <p class="muted payment-mode-note">${this.paymentModeNote()}</p>
      </div>

      <div class="card insured-section">
        <div class="row insured-section-head">
          <strong>Insured person</strong>
          <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" onclick="App.openDrawer()">+ Family</button>
        </div>
        ${this.renderPersonChips(persons)}
      </div>

      <div class="card">
        <strong>Hospital Network</strong>
        <p class="muted" style="margin:8px 0">${p.providerNetworkSummary}</p>
        <button class="btn btn-ghost btn-block" onclick="App.openHospitals('${p.planCode}','detail')">Find hospitals</button>
      </div>

      <div class="terms-note">
        By continuing, you authorize OPay wallet auto-debit for renewals and agree to
        <a href="${brochureUrl}" target="_blank" rel="noopener">${brochure}</a>.
        Premiums paid are non-refundable for used periods.
      </div>
    `;

    document.getElementById('btn-pay').textContent =
      preview.payableAmount === 0 ? 'Continue (₦0 first month)' : `Continue · ${Pricing.formatNaira(preview.payableAmount)}`;
  },

  async setMode(m) {
    this.state.paymentMode = m;
    await this.renderDetail();
  },

  pickPerson(id) {
    this.state.personId = id;
    this.renderDetail();
  },

  openDrawer() {
    document.getElementById('drawer-overlay').classList.add('show');
    document.getElementById('drawer').classList.add('show');
  },
  closeDrawer() {
    document.getElementById('drawer-overlay').classList.remove('show');
    document.getElementById('drawer').classList.remove('show');
  },

  openEditDrawer(personId) {
    const person = this.state.persons.find((p) => p.personId === personId);
    if (!person || person.relationType === 'SELF') return;
    this.state.editingPersonId = personId;
    document.getElementById('e-first').value = person.firstName;
    document.getElementById('e-last').value = person.lastName;
    document.getElementById('e-nin').value = person.nin;
    document.getElementById('e-phone').value = person.phone || '';
    document.getElementById('e-dob').value = person.dob || '';
    document.getElementById('e-gender').value = String(person.gender || 1);
    document.getElementById('edit-overlay').classList.add('show');
    document.getElementById('edit-drawer').classList.add('show');
  },

  closeEditDrawer() {
    document.getElementById('edit-overlay').classList.remove('show');
    document.getElementById('edit-drawer').classList.remove('show');
    this.state.editingPersonId = null;
  },

  async submitEditFamily() {
    try {
      const id = this.state.editingPersonId;
      if (!id) return;
      const body = {
        firstName: document.getElementById('e-first').value.trim(),
        lastName: document.getElementById('e-last').value.trim(),
        nin: document.getElementById('e-nin').value.trim(),
        phone: document.getElementById('e-phone').value.trim(),
        dob: document.getElementById('e-dob').value,
        gender: Number(document.getElementById('e-gender').value),
      };
      if (!body.firstName || !body.lastName || !body.nin || !body.dob) {
        this.toast('Please fill required fields');
        return;
      }
      await DemoApi.updatePerson(id, body);
      this.state.persons = await DemoApi.getPersons();
      this.closeEditDrawer();
      if (this.state.plan) await this.renderDetail();
      await Debug.refresh();
      this.toast('Member updated for future enrollments');
    } catch (e) {
      this.toast(e.message || String(e));
    }
  },

  async submitFamily() {
    try {
      const body = {
        relationType: document.getElementById('f-relation').value,
        firstName: document.getElementById('f-first').value.trim(),
        lastName: document.getElementById('f-last').value.trim(),
        nin: document.getElementById('f-nin').value.trim(),
        phone: document.getElementById('f-phone').value.trim(),
        dob: document.getElementById('f-dob').value,
        gender: Number(document.getElementById('f-gender').value),
        isDefault: false,
      };
      if (!body.firstName || !body.lastName || !body.nin || !body.dob) {
        this.toast('Please fill required fields');
        return;
      }
      const person = await DemoApi.createPerson(body);
      this.state.persons = await DemoApi.getPersons();
      this.state.personId = person.personId;
      this.closeDrawer();
      await this.renderDetail();
      await Debug.refresh();
      this.toast('Family member saved');
    } catch (e) {
      this.toast(e.message || String(e));
    }
  },

  async openPayModal() {
    if (!this.state.personId) {
      this.toast('Select an insured person');
      return;
    }
    this.state.payModalAction = 'enroll';
    this.state.payModalPolicyId = null;
    this.showPayModalContent({
      title: 'Confirm payment',
      payable: this.state.payable,
      recurring: this.state.recurring,
      mode: this.state.paymentMode,
      extraLines: [
        ['Coverage start', this.state.coverageStart],
        ['Coverage end', this.state.coverageEnd],
      ],
    });
  },

  async openRestoreModal(policyId) {
    const p = await DemoApi.getPolicy(policyId);
    const plan = this.state.plans.find((x) => x.planCode === p.planCode) || (await DemoApi.getPlan(p.planCode));
    const payable = Pricing.listPrice(plan, p.paymentMode);
    const recurring = payable;
    this.state.payModalAction = 'payNow';
    this.state.payModalPolicyId = policyId;
    this.showPayModalContent({
      title: 'Restore coverage',
      payable,
      recurring,
      mode: p.paymentMode,
    });
  },

  async openReactivateModal(policyId) {
    const p = await DemoApi.getPolicy(policyId);
    const plan = this.state.plans.find((x) => x.planCode === p.planCode) || (await DemoApi.getPlan(p.planCode));
    const payable = Pricing.listPrice(plan, p.paymentMode);
    const recurring = payable;
    this.state.payModalAction = 'reactivate';
    this.state.payModalPolicyId = policyId;
    this.showPayModalContent({
      title: 'Re-activate policy',
      payable,
      recurring,
      mode: p.paymentMode,
    });
  },

  showPayModalContent({ title, payable, recurring, mode, extraLines = [] }) {
    document.querySelector('#pay-modal .row strong').textContent = title;
    document.getElementById('pay-modal-body').innerHTML = `
      <div class="pay-line"><span class="muted">Debit now</span><strong>${Pricing.formatNaira(payable)}</strong></div>
      ${extraLines.map(([k, v]) => `<div class="pay-line"><span class="muted">${k}</span><strong>${v}</strong></div>`).join('')}
      <div class="pay-line"><span class="muted">Each cycle charge</span><strong>${Pricing.formatNaira(recurring)} / ${this.cycleLabel(mode)}</strong></div>
    `;
    document.getElementById('pay-overlay').classList.add('show');
    document.getElementById('pay-modal').classList.add('show');
  },

  closePayModal() {
    document.getElementById('pay-overlay').classList.remove('show');
    document.getElementById('pay-modal').classList.remove('show');
  },

  async confirmPay() {
    this.closePayModal();
    const action = this.state.payModalAction || 'enroll';
    const policyId = this.state.payModalPolicyId;

    if (action === 'payNow' && policyId) {
      const stayOnPolicy = !!(this.state.policy && this.state.policy.policyId === policyId);
      await this.executePayNow(policyId, stayOnPolicy);
      return;
    }
    if (action === 'reactivate' && policyId) {
      const stayOnPolicy = !!(this.state.policy && this.state.policy.policyId === policyId);
      await this.executeReactivate(policyId, stayOnPolicy);
      return;
    }

    try {
      this.go('processing');
      document.getElementById('processing-title').textContent = 'Processing payment…';
      document.getElementById('processing-sub').textContent = 'Wallet debit · writing billing tables';

      const payMs = window.DEMO_CONFIG.payProcessingMs || 2000;
      const activateMs = window.DEMO_CONFIG.activatePendingMs || 5000;

      await new Promise((r) => setTimeout(r, payMs));
      const res = await DemoApi.enroll({
        planCode: this.state.plan.planCode,
        personId: this.state.personId,
        paymentMode: this.state.paymentMode,
        autoRenewEnabled: true,
      });
      this.state.policy = res.policy;
      await this.refresh();
      await this.renderPolicy(res.policy.policyId);
      this.toast('Submitted to insurer');

      setTimeout(async () => {
        this.state.policy = await DemoApi.activatePending(res.policy.policyId);
        await this.refresh();
        if (this.state.policy && this.state.policy.policyId === res.policy.policyId) {
          await this.renderPolicy(res.policy.policyId);
        }
        this.toast('Policy Active');
      }, activateMs);
    } catch (e) {
      this.toast(e.message || String(e));
      this.go('detail');
    }
  },

  async openPolicy(id, from) {
    this.state.policyFrom = from || 'home';
    await this.renderPolicy(id);
  },

  backFromPolicy() {
    if (this.state.policyFrom === 'policies') {
      this.openPolicies();
    } else {
      this.go('home');
    }
  },

  async renderPolicy(id) {
    const p = await DemoApi.getPolicy(id);
    this.state.policy = p;
    const plan = this.state.plans.find((x) => x.planCode === p.planCode) || (await DemoApi.getPlan(p.planCode));
    const covers = await DemoApi.getCovers(p.planCode);
    const timelineRows = await DemoApi.timeline(id);
    const person = this.state.persons.find((x) => x.personId === p.personId);
    const processing = p.status === 'PENDING_ENROLLMENT';
    const renewDisabled = p.status === 'EXPIRED';

    let headAction = '';
    if (p.status === 'SUSPENDED') {
      headAction = `<button class="btn btn-primary btn-block btn-sm" style="margin-top:12px" onclick="App.openRestoreModal('${p.policyId}')">Restore Now</button>`;
    } else if (p.status === 'EXPIRED') {
      headAction = `<button class="btn btn-primary btn-block btn-sm" style="margin-top:12px" onclick="App.openReactivateModal('${p.policyId}')">Re-active Now</button>`;
    }

    document.getElementById('policy-body').innerHTML = `
      <div class="card policy-head ${headAction ? 'policy-head-action' : ''}">
        <div class="row">
          <h2>${plan.planName}</h2>
          ${this.statusPill(p.status)}
        </div>
        <div class="sub">Provided By <strong>${plan.underwriterCode}</strong></div>
        <div class="copy-row muted">Policy No.: <strong style="color:#111">${p.policyNumber}</strong>
          <button class="icon-btn" style="width:28px;height:28px" onclick="App.copyText('${p.policyNumber}')"><i class="ph ph-copy"></i></button>
        </div>
        ${processing ? `<p class="muted" style="margin-top:10px;color:#92400e">Insurer is processing enrollment… status will become Active shortly.</p>` : ''}
        ${headAction}
      </div>

      <div class="card auto-renew-card ${renewDisabled ? 'disabled' : ''}">
        <div>
          <strong>Auto-Renewal</strong>
          <div class="muted">Wallet auto-debit on each billing date</div>
        </div>
        <button class="switch ${p.autoRenewEnabled ? 'on' : ''}" ${renewDisabled ? 'disabled' : ''}
          onclick="App.toggleAutoRenew()"><span></span></button>
      </div>

      <div class="card">
        <div class="svc-grid svc-grid-4">
          <button onclick="App.openTxns()"><div class="ico"><i class="ph ph-clock-countdown"></i></div>Payment Record</button>
          <button onclick="App.toast('Claim mock not in scope')"><div class="ico"><i class="ph ph-file-text"></i></div>Claim</button>
          <button onclick="App.openHospitals('${p.planCode}','policy')"><div class="ico"><i class="ph ph-hospital"></i></div>Hospitals</button>
          <button onclick="App.toast('Telemedicine mock')"><div class="ico"><i class="ph ph-heartbeat"></i></div>Telemedicine</button>
        </div>
      </div>

      <div class="card">
        <strong>Details</strong>
        <div class="detail-kv"><span class="k">Insured</span><span>${person ? `${person.firstName} ${person.lastName}`.toUpperCase() : p.personId}</span></div>
        <div class="detail-kv"><span class="k">Duration</span><span>${p.currentCycleStart} - ${p.currentCycleEnd}</span></div>
        ${this.continuousStayHtml(p)}
        <div class="detail-kv"><span class="k">Payment</span><span>${MODE_LABEL[p.paymentMode] || p.paymentMode} · ${Pricing.formatNaira(Pricing.listPrice(plan, p.paymentMode))}</span></div>
      </div>

      <div class="card">
        <div class="card-head-row">
          <strong>Covers</strong>
          <button class="link-btn" onclick="App.openCoversDetail('${p.planCode}','policy')">Details</button>
        </div>
        ${this.renderCoversList(covers)}
        <div class="timeline-card">
          <strong>Timeline</strong>
          ${this.renderTimelineInline(timelineRows)}
        </div>
      </div>

      <p class="disclaimer">
        Policies are sold by OPay / partner MFB and underwritten by third-party partners (e.g. ${plan.underwriterCode}).
        This screen is a demo simulation.
      </p>
    `;
    this.go('policy');
  },

  async openCoversDetail(planCode, from) {
    this.state.coversFrom = from || 'policy';
    const covers = await DemoApi.getCovers(planCode);
    const plan = this.state.plans.find((x) => x.planCode === planCode) || (await DemoApi.getPlan(planCode));
    document.getElementById('covers-detail-body').innerHTML = `
      <div class="card">
        <h2 style="margin:0 0 4px">${plan.planName}</h2>
        <div class="muted">Benefit schedule & waiting rules</div>
      </div>
      ${covers
        .map(
          (c) => `
        <div class="card cover-detail-item">
          <h3>${c.coverName}</h3>
          <div class="meta">${c.effectiveRuleSubtitle || ''}${c.limitText ? ` · ${c.limitText}` : ''}</div>
          <p>${c.detailedDescription || c.briefDescription || ''}</p>
        </div>`
        )
        .join('') || `<div class="card muted">No covers configured.</div>`}
    `;
    this.go('covers-detail');
  },

  backFromCovers() {
    this.go(this.state.coversFrom === 'detail' ? 'detail' : 'policy');
  },

  copyText(t) {
    if (!t) return;
    navigator.clipboard.writeText(t).then(() => this.toast('Copied')).catch(() => this.toast(t));
  },

  async toggleAutoRenew() {
    const p = this.state.policy;
    if (p.status === 'EXPIRED') return;
    try {
      const updated = await DemoApi.setAutoRenew(p.policyId, !p.autoRenewEnabled);
      this.state.policy = updated;
      await this.renderPolicy(p.policyId);
      await Debug.refresh();
      this.toast(`Auto-renew ${updated.autoRenewEnabled ? 'ON' : 'OFF'}`);
    } catch (e) {
      this.toast(e.message || String(e));
    }
  },

  async payNowPolicy() {
    await this.openRestoreModal(this.state.policy.policyId);
  },

  async executePayNow(policyId, stayOnPolicy) {
    try {
      this.go('processing');
      document.getElementById('processing-title').textContent = 'Processing payment…';
      document.getElementById('processing-sub').textContent = 'Restoring suspended coverage';
      await new Promise((r) => setTimeout(r, window.DEMO_CONFIG.payProcessingMs || 2000));
      const p = await DemoApi.payNow(policyId);
      await this.refresh();
      if (stayOnPolicy) {
        await this.renderPolicy(p.policyId);
      } else if (this.state.plan) {
        await this.renderDetail();
        this.go('detail');
      }
      await Debug.refresh();
      this.toast('Payment successful — policy active');
    } catch (e) {
      this.toast(e.message || String(e));
      this.go(stayOnPolicy ? 'policy' : 'detail');
    }
  },

  async executeReactivate(policyId, stayOnPolicy) {
    try {
      this.go('processing');
      document.getElementById('processing-title').textContent = 'Re-activating…';
      document.getElementById('processing-sub').textContent = 'Updating coverage and continuous stay months';
      await new Promise((r) => setTimeout(r, window.DEMO_CONFIG.payProcessingMs || 2000));
      const p = await DemoApi.reactivate(policyId);
      await this.refresh();
      if (stayOnPolicy) {
        await this.renderPolicy(p.policyId);
      } else if (this.state.plan) {
        await this.renderDetail();
        this.go('detail');
      } else {
        await this.renderPolicy(p.policyId);
      }
      await Debug.refresh();
      this.toast('Re-activated');
    } catch (e) {
      this.toast(e.message || String(e));
      this.go(stayOnPolicy ? 'policy' : this.state.plan ? 'detail' : 'policy');
    }
  },

  async payNowFromDetail(policyId, stayOnPolicy) {
    await this.openRestoreModal(policyId);
  },

  async reactivatePolicy(policyId) {
    await this.openReactivateModal(policyId);
  },

  async openTxns() {
    const rows = await DemoApi.transactions(this.state.policy.policyId);
    document.getElementById('txns-body').innerHTML = rows.length
      ? rows
          .map(
            (t) => `
        <div class="card">
          <div class="row"><strong>${Pricing.formatNaira(t.tradeAmount)}</strong>
            <span class="pill ${t.tradeStatus === 'SUCCESS' ? 'pill-active' : t.tradeStatus === 'FAILED' ? 'pill-suspended' : 'pill-pending'}">${t.tradeStatus}</span>
          </div>
          <div class="muted">${t.tradeTime}</div>
          <div class="muted">${t.paymentMethod}${t.gatewayRefCode ? ' · ' + t.gatewayRefCode : ''}</div>
          ${t.errorMessage ? `<div style="color:var(--danger);font-size:12px;margin-top:4px">${t.errorMessage}</div>` : ''}
        </div>`
          )
          .join('')
      : `<div class="card muted">No transactions</div>`;
    this.go('txns');
  },

  async openTimeline() {
    const rows = await DemoApi.timeline(this.state.policy.policyId);
    const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    document.getElementById('timeline-body').innerHTML = `
      <div class="timeline">
        ${sorted
          .map(
            (t) => `
          <div class="item">
            <strong>${t.actionType}</strong> ${this.statusPill(t.status)}
            <div class="muted">${t.createdAt}</div>
            <div class="muted">Cover ${t.coverageStartDate} → ${t.coverageEndDate}</div>
            <div class="muted">Stay snapshot: ${t.continuousStaySnapshot}</div>
          </div>`
          )
          .join('')}
      </div>`;
    this.go('timeline');
  },

  async openHospitals(planCode, from) {
    this.state.hospitalsFrom = from || 'detail';
    this.state.hospitalPlanCode = planCode;
    this.state.hospitalNearby = false;
    this.state.hospitalState = '';
    this.state.hospitalLga = '';
    await this.renderHospitals();
    this.go('hospitals');
  },

  async renderHospitals() {
    const planCode = this.state.hospitalPlanCode;
    const allRows = await DemoApi.hospitals(planCode, {});
    const states = [...new Set(allRows.map((h) => h.state).filter(Boolean))].sort();
    const lgas = [
      ...new Set(
        allRows.filter((h) => !this.state.hospitalState || h.state === this.state.hospitalState).map((h) => h.lga).filter(Boolean)
      ),
    ].sort();

    let rows = allRows;
    const loc = window.DEMO_CONFIG.demoLocation || { lat: 6.5244, lng: 3.3792, label: 'Lagos (demo)' };
    const radius = window.DEMO_CONFIG.nearbyRadiusKm || 50;

    if (this.state.hospitalNearby) {
      rows = allRows
        .map((h) => ({ ...h, distanceKm: this.haversineKm(loc, h) }))
        .filter((h) => h.distanceKm <= radius)
        .sort((a, b) => a.distanceKm - b.distanceKm);
    } else {
      const filters = {};
      if (this.state.hospitalState) filters.state = this.state.hospitalState;
      if (this.state.hospitalLga) filters.lga = this.state.hospitalLga;
      rows = await DemoApi.hospitals(planCode, filters);
    }

    const first = rows[0] || allRows[0];
    const mapCenter = this.state.hospitalNearby ? loc : first ? { lat: first.lat, lng: first.lng } : loc;
    const mapSrc = `https://maps.google.com/maps?q=${mapCenter.lat},${mapCenter.lng}&z=12&output=embed`;

    document.getElementById('hospitals-body').innerHTML = `
      <div class="filter-crumbs">
        <button type="button" class="crumb ${this.state.hospitalNearby ? 'on' : ''}" onclick="App.selectHospitalNearby()">Nearby</button>
        <label class="crumb crumb-select ${this.state.hospitalState ? 'on' : ''}">
          <select onchange="App.setHospitalState(this.value)" ${this.state.hospitalNearby ? '' : ''}>
            <option value="" ${!this.state.hospitalState ? 'selected' : ''}>State</option>
            ${states.map((s) => `<option value="${s}" ${this.state.hospitalState === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
        <label class="crumb crumb-select ${this.state.hospitalLga ? 'on' : ''}">
          <select onchange="App.setHospitalLga(this.value)">
            <option value="" ${!this.state.hospitalLga ? 'selected' : ''}>LGA</option>
            ${lgas.map((l) => `<option value="${l}" ${this.state.hospitalLga === l ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="map-box">
        <iframe title="mock-map" loading="lazy" src="${mapSrc}"></iframe>
      </div>
      ${
        rows.length
          ? rows
              .map(
                (h) => `
        <div class="card">
          <div class="row">
            <strong>${h.name}</strong>
            <span>${h.distanceKm != null ? `<span class="dist-badge">${h.distanceKm.toFixed(1)} km</span>` : `<span class="muted">Tier ${h.tier}</span>`}</span>
          </div>
          <div class="muted">${h.address}, ${h.city}${h.state ? ', ' + h.state : ''}${h.lga ? ' · ' + h.lga : ''}</div>
          <button class="btn btn-ghost" style="margin-top:8px;padding:8px 12px;font-size:12px"
            onclick="App.focusMap(${h.lat},${h.lng})">Show on map</button>
        </div>`
              )
              .join('')
          : `<div class="card muted">No hospitals match your filters.</div>`
      }`;
  },

  async selectHospitalNearby() {
    this.state.hospitalNearby = true;
    this.state.hospitalState = '';
    this.state.hospitalLga = '';
    await this.renderHospitals();
  },

  async setHospitalState(state) {
    this.state.hospitalNearby = false;
    this.state.hospitalState = state;
    this.state.hospitalLga = '';
    await this.renderHospitals();
  },

  async setHospitalLga(lga) {
    this.state.hospitalNearby = false;
    this.state.hospitalLga = lga;
    await this.renderHospitals();
  },

  focusMap(lat, lng) {
    const box = document.querySelector('#hospitals-body .map-box');
    box.innerHTML = `<iframe title="mock-map" loading="lazy" src="https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed"></iframe>`;
  },

  backFromHospitals() {
    this.go(this.state.hospitalsFrom === 'policy' ? 'policy' : 'detail');
  },

  async resetDemo() {
    if (!confirm('Reset all demo data to seed?')) return;
    await DemoApi.reset();
    this.state.personId = null;
    this.state.policy = null;
    this.state.plan = null;
    await this.refresh();
    this.go('home');
    this.toast('Demo reset');
  },
};

const Debug = {
  dump: null,
  renewOn: true,
  busy: false,

  async init() {
    const sel = document.getElementById('dbg-table');
    const tables = [
      'meta',
      'insurance_plan_config',
      'plan_cover_config',
      'user_insured_person',
      'enrollee_profile',
      'policy_master',
      'policy_status_timeline',
      'policy_billing_schedule',
      'policy_payment_transaction',
      'hospitals',
    ];
    sel.innerHTML = tables.map((t) => `<option value="${t}">${t}</option>`).join('');
    sel.onchange = () => this.renderTable();
    await this.refresh();
  },

  setBusy(on) {
    ['dbg-adv-1', 'dbg-adv-7', 'dbg-adv-30'].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = on;
    });
    const status = document.getElementById('dbg-travel-status');
    if (status) status.textContent = on ? 'Processing time travel…' : '';
  },

  async refresh() {
    try {
      this.dump = await DemoApi.dump();
      const meta = this.dump.meta || (await DemoApi.getMeta());
      this.renewOn = meta.renewPaymentSuccess !== false;
      const sw = document.getElementById('dbg-renew-switch');
      sw.classList.toggle('on', this.renewOn);
      document.getElementById('dbg-renew-hint').textContent = this.renewOn
        ? 'ON = auto-renew payments succeed'
        : 'OFF = auto-renew debit fails (→ SUSPENDED / EXPIRED)';
      document.getElementById('dbg-now').textContent = `demoNow: ${meta.demoNow || '(wall clock)'}`;
      const last = meta.lastOp || (await DemoApi.lastOp());
      document.getElementById('dbg-last-op').textContent = last ? JSON.stringify(last, null, 2) : '—';
      this.renderTable();
    } catch (e) {
      document.getElementById('dbg-last-op').textContent = String(e);
    }
  },

  renderTable() {
    if (!this.dump) return;
    const name = document.getElementById('dbg-table').value;
    document.getElementById('dbg-table-view').textContent = JSON.stringify(this.dump[name], null, 2);
  },

  async refreshDump() {
    await this.refresh();
    App.toast('Debug refreshed');
  },

  async advance(days) {
    if (this.busy) return;
    this.busy = true;
    this.setBusy(true);
    try {
      const res = await DemoApi.timeTravel(days);
      await App.refresh();
      if (App.state.policy) await App.renderPolicy(App.state.policy.policyId);
      if (App.state.plan && document.getElementById('view-detail').classList.contains('active')) {
        await App.renderDetail();
      }
      await this.refresh();
      App.toast(`+${days}d · ${res.events.length} events`);
    } catch (e) {
      App.toast(e.message || String(e));
    } finally {
      this.busy = false;
      this.setBusy(false);
    }
  },

  async toggleRenew() {
    if (this.busy) return;
    this.renewOn = !this.renewOn;
    await DemoApi.setRenewSuccess(this.renewOn);
    await this.refresh();
    App.toast(`Renew success ${this.renewOn ? 'ON' : 'OFF'}`);
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
