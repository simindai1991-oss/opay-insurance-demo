# Extra / demo-only fields

Marked **【EXTRA】** relative to the original 7-table design.

## InsurancePlanConfig 【EXTRA】
- `category` — HEALTH | ACCIDENT | MOTOR
- `listThumbnail` — list card image URL or emoji placeholder key
- `shortDescription` — list subtitle
- `promoLabel` — e.g. "Free for 1st month"
- `sortOrder` — list ordering
- `benefitSummary` — string[] for detail bullets
- `waitingPeriodNotes` — short copy for T0/T3/T6
- `brochureName` — product brochure / T&C display name (terms note link text)
- `brochureUrl` — brochure URL (open in new tab; no in-app mock required)
- `covers` — `{ name, limitText }[]` for My Policy Detail Covers list

## UserInsuredPerson 【EXTRA】
- `photoUrl` — optional avatar

## PolicyMaster 【EXTRA】
- `pendingUntil` — ISO timestamp; enrollment UI flips after this (demo 5s)

## hospitals.json 【EXTRA】 (new collection, not in original 7 tables)
- `hospitalId`, `planCodes[]`, `name`, `address`, `city`, `lat`, `lng`, `tier`

## meta.json 【EXTRA】
- `demoUserId` — current mock OPay user
- `demoNow` — optional simulated clock (ISO); null = real now
- `renewPaymentSuccess` — when true, time-travel auto-renew debit succeeds; false ⇒ fail
- `lastOp` — latest mutation trace for debug panel (`action`, `summary`, `affected`)
