/** First-period payable: MONTHLY=0; else (N-1)*monthlyPrice */
window.Pricing = {
  MODE_MONTHS: { MONTHLY: 1, QUARTERLY: 3, BIANNUAL: 6, ANNUAL: 12 },
  firstPeriodAmount(plan, mode) {
    const n = this.MODE_MONTHS[mode];
    if (!n) throw new Error('Invalid mode');
    if (mode === 'MONTHLY') return 0;
    return (n - 1) * Number(plan.monthlyPrice || 0);
  },
  listPrice(plan, mode) {
    const map = {
      MONTHLY: 'monthlyPrice',
      QUARTERLY: 'quarterlyPrice',
      BIANNUAL: 'biannualPrice',
      ANNUAL: 'annualPrice',
    };
    return Number(plan[map[mode]] || 0);
  },
  formatNaira(n) {
    return `₦${Number(n).toLocaleString('en-NG')}`;
  },
};
