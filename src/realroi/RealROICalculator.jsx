// RealROICalculator.tsx — drop-in page/component for Next.js (App Router or Pages)
// - Tailwind for styling
// - Recharts for the bar chart
// - No external state mgmt; all client-side
// Usage (App Router):
//   app/realroi/page.tsx   -> export default RealROICalculator
// Usage (Pages Router):
//   pages/realroi.tsx       -> export default RealROICalculator
// -------------------------------------------------------------


'use client';
import React, { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis, ResponsiveContainer } from 'recharts';

// ---------------------------
// Types (removed for build compatibility)
// ---------------------------

// (formerly ModelInputs type definition, now omitted because JSX can’t parse it)


  startRentMonthly: number;     // e.g., 1800
  rentGrowthAnnual: number;     // e.g., 0.03
  pmFlatMonthly: number;        // e.g., 119


  vacancyMonthsPer10yr: number;   // e.g., 3
  placementCountPer10yr: number;  // e.g., 3


  includeSafetyNet: boolean;
  safetyNetAmount: number;        // e.g., 5000


  horizonYears: number;          // 10 / 25 / 30 / any


  landPct: number;              // 0.20
  reclassPct: number;           // 0.25 of improvements eligible for 5/7/15
  bonusPct: number;             // 1.00 = 100% bonus (illustrative)
  taxBracket: number;           // e.g., 0.24
  magi: number;                 // e.g., 120000
  otherPassiveIncome: number;     // e.g., 0 or 20000
  studyFee: number;             // CS study fee
  useCostSeg: boolean;          // Toggle to include immediate used deduction in net
  repsOrSTR: boolean;           // If true, ignore special allowance cap (for demo)


  spAnnualReturn: number;         // S&P total-return annualized (user-controlled)
};


// ---------------------------
// Helpers
// ---------------------------


function currency(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}


function npv(rate: number, cashflows: number[]): number {
  return cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
}


function irrBisection(cashflows: number[], low = -0.9, high = 5.0, tol = 1e-8, maxIter = 10000): number | null {
  let fLow = npv(low, cashflows);
  let fHigh = npv(high, cashflows);
  if (fLow * fHigh > 0) return null;
  for (let i = 0; i < maxIter; i++) {
    const mid = (low + high) / 2;
    const fMid = npv(mid, cashflows);
    if (Math.abs(fMid) < tol) return mid;
    if (fLow * fMid < 0) {
      high = mid; fHigh = fMid;
    } else {
      low = mid; fLow = fMid;
    }
  }
  return null;
}


// evenly-spaced integers excluding 0 and months-1 if possible
function spacedMonths(count: number, months: number): number[] {
  if (count <= 0) return [];
  const step = Math.floor(months / (count + 1));
  const arr: number[] = [];
  for (let i = 1; i <= count; i++) arr.push(Math.min(step * i, months - 1));
  return arr;
}


// ---------------------------
// Core Model (FIXED STOCKS LOGIC)
// ---------------------------


function runModel(i: ModelInputs) {
  const months = i.horizonYears * 12;


  // Appreciation annual rate from 10-year +80% (or whatever user sets)
  const apprAnnual = Math.pow(1 + i.appreciationCum10yr, 1 / 10) - 1;
  const apprCum = Math.pow(1 + apprAnnual, i.horizonYears) - 1;


  // Principal paydown scales linearly with years
  const principalPaydown = i.principalPaydown10yr * (i.horizonYears / 10);


  // Vacancy & placement scaling
  const vacCount = Math.round(i.vacancyMonthsPer10yr * (i.horizonYears / 10));
  const placementCount = Math.round(i.placementCountPer10yr * (i.horizonYears / 10));


  // Monthly rents with annual step growth
  const rents: number[] = Array.from({ length: months }, (_, m) => i.startRentMonthly * Math.pow(1 + i.rentGrowthAnnual, Math.floor(m / 12)));


  // Apply vacancy
  const vacancyMonths = spacedMonths(vacCount, months);
  const rentsAdj = rents.slice();
  vacancyMonths.forEach((vm) => (rentsAdj[vm] = 0));


  // Placement fee months: include month 0 if placementCount>0; then after vacancies; fill if needed
  const placementMonths: number[] = [];
  if (placementCount > 0) placementMonths.push(0);
  const need = Math.max(0, placementCount - 1);
  vacancyMonths.slice(0, need).forEach((vm) => placementMonths.push(Math.min(vm + 1, months - 1)));
  while (placementMonths.length < placementCount) {
    placementMonths.push(Math.min(placementMonths.length * Math.floor(months / Math.max(1, placementCount)), months - 1));
  }


  // Fees = one month of prevailing rent at that month (pre-vacancy schedule)
  const placementFees: number[] = Array.from({ length: months }, () => 0);
  placementMonths.forEach((fm) => (placementFees[fm] = rents[fm] || i.startRentMonthly));


  // PM monthly flat
  const pmCosts: number[] = Array.from({ length: months }, () => i.pmFlatMonthly);


  const totalRentCollected = rentsAdj.reduce((a, b) => a + b, 0);
  const totalPM = pmCosts.reduce((a, b) => a + b, 0);
  const totalPlacement = placementFees.reduce((a, b) => a + b, 0);
  const carryingTotal = totalPM + totalPlacement + (i.includeSafetyNet ? i.safetyNetAmount : 0);


  // Real estate base net
  const reBaseNet = (i.purchasePrice * apprCum + principalPaydown + totalRentCollected) - carryingTotal - i.downPayment;


  // Cost seg sweet spot (illustrative only; not tax advice)
  const improvementBasis = i.purchasePrice * (1 - i.landPct);
  const bonusEligible = improvementBasis * i.reclassPct * i.bonusPct;
  const remainingImpr = improvementBasis - improvementBasis * i.reclassPct;
  const slYear1 = remainingImpr / 27.5; // 1 year of straight-line on remainder


  // Pub 925 special allowance cap (non-REPS): $25k phased out 100k→150k MAGI
  let specialAllowance = 0;
  if (i.magi <= 100_000) specialAllowance = 25_000;
  else if (i.magi >= 150_000) specialAllowance = 0;
  else specialAllowance = Math.max(0, 25_000 - 0.5 * (i.magi - 100_000));


  const immediateCap = i.repsOrSTR ? Infinity : (specialAllowance + i.otherPassiveIncome);
  const immediateAvailable = bonusEligible + slYear1;
  const immediateUsed = Math.min(immediateAvailable, immediateCap);
  const immediateTaxSavings = immediateUsed * i.taxBracket; // pre-recapture, assumes usability


  const reWithCostSeg = i.useCostSeg ? reBaseNet + immediateTaxSavings : reBaseNet;


  // STOCKS FIX: Stocks comparison mirrors only the initial capital (Down Payment + Safety Net).
  const monthlyRate = Math.pow(1 + i.spAnnualReturn, 1 / 12) - 1;
  
  const stocksContrib = i.downPayment + (i.includeSafetyNet ? i.safetyNetAmount : 0);
  let stocksFV = stocksContrib * Math.pow(1 + monthlyRate, months);
  
  const stocksNet = stocksFV - stocksContrib;


  // IRR on property: cash flows include monthly net operating cash and terminal value
  const cfs: number[] = [];
  cfs.push(- (i.downPayment + (i.includeSafetyNet ? i.safetyNetAmount : 0)));
  for (let m = 0; m < months; m++) {
    const op = rentsAdj[m] - pmCosts[m] - placementFees[m];
    cfs.push(op);
  }
  // terminal wealth at end month: appreciation + principal
  cfs[cfs.length - 1] += (i.purchasePrice * apprCum + principalPaydown);
  const monthlyIRR = irrBisection(cfs);
  const annualIRR = monthlyIRR != null ? (Math.pow(1 + monthlyIRR, 12) - 1) : null;


  const outOfPocket = i.downPayment + carryingTotal;
  const multipleBase = reBaseNet / outOfPocket;
  const multipleCS = reWithCostSeg / outOfPocket;


  return {
    rentsAdj, pmCosts, placementFees,
    totalRentCollected, totalPM, totalPlacement, carryingTotal,
    reBaseNet, reWithCostSeg,
    improvementBasis, bonusEligible, remainingImpr, slYear1,
    specialAllowance, immediateAvailable, immediateCap, immediateUsed, immediateTaxSavings,
    stocksContrib, stocksNet,
    apprAnnual, apprCum, principalPaydown,
    annualIRR,
    outOfPocket, multipleBase, multipleCS,
  };
}


// ---------------------------
// UI Component
// ---------------------------


export default function RealROICalculator() {
  const [inputs, setInputs] = useState<ModelInputs>({
    purchasePrice: 300_000,
    downPayment: 60_000,
    appreciationCum10yr: 0.80,
    principalPaydown10yr: 48_000,


    startRentMonthly: 1_800,
    rentGrowthAnnual: 0.03,
    pmFlatMonthly: 119,


    vacancyMonthsPer10yr: 3,
    placementCountPer10yr: 3,


    includeSafetyNet: false,
    safetyNetAmount: 5_000,


    horizonYears: 10,


    landPct: 0.20,
    reclassPct: 0.25,
    bonusPct: 1.0,
    taxBracket: 0.24,
    magi: 120_000,
    otherPassiveIncome: 0,
    studyFee: 9_000,
    useCostSeg: false,
    repsOrSTR: false,


    spAnnualReturn: 0.1465,
  });


  const r = useMemo(() => runModel(inputs), [inputs]);


  const data = [
    { key: 'Real Estate — base (pre-tax)', value: r.reBaseNet },
    { key: 'Real Estate — with cost seg (used now)', value: r.reWithCostSeg },
    { key: 'Stocks — same cash timing', value: r.stocksNet },
  ];


  function Num({ v }: { v: number }) { return <span className="font-semibold">{currency(v)}</span>; }


  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="text-2xl md:text-3xl font-bold mb-2">Real ROI Calculator</h1>
        <p className="text-sm text-neutral-600 mb-6">A simple, auditable model that matches real cash timing. Adjust horizon and S&P return for 10 / 25 / 30-year windows. Cost seg shows only the <em>immediately usable</em> deduction under Pub 925 rules (non‑REPS) or unlimited if REPS/STR is toggled.</p>


        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Controls */}
          <div className="lg:col-span-1 space-y-6">
            <section className="bg-white rounded-2xl shadow p-4">
              <h2 className="font-semibold mb-3">Deal</h2>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Purchase price" value={inputs.purchasePrice} onChange={(v)=>setInputs({...inputs, purchasePrice:v})} />
                <Field label="Down payment" value={inputs.downPayment} onChange={(v)=>setInputs({...inputs, downPayment:v})} />
                <Field label="Appreciation +10yr (cum)" step={0.01} value={inputs.appreciationCum10yr} onChange={(v)=>setInputs({...inputs, appreciationCum10yr:v})} helper="e.g., 0.80 = +80% total over 10 years" />
                <Field label="Principal paydown +10yr" value={inputs.principalPaydown10yr} onChange={(v)=>setInputs({...inputs, principalPaydown10yr:v})} />
                <Field label="Horizon (years)" value={inputs.horizonYears} onChange={(v)=>setInputs({...inputs, horizonYears:v})} />
              </div>
            </section>


            <section className="bg-white rounded-2xl shadow p-4">
              <h2 className="font-semibold mb-3">Operations</h2>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start rent / mo" value={inputs.startRentMonthly} onChange={(v)=>setInputs({...inputs, startRentMonthly:v})} />
                <Field label="Rent growth (annual)" step={0.001} value={inputs.rentGrowthAnnual} onChange={(v)=>setInputs({...inputs, rentGrowthAnnual:v})} />
                <Field label="PM flat / mo" value={inputs.pmFlatMonthly} onChange={(v)=>setInputs({...inputs, pmFlatMonthly:v})} />
                <Field label="Vacancy per 10yr (mo)" value={inputs.vacancyMonthsPer10yr} onChange={(v)=>setInputs({...inputs, vacancyMonthsPer10yr:v})} />
                <Field label="Placements per 10yr (×)" value={inputs.placementCountPer10yr} onChange={(v)=>setInputs({...inputs, placementCountPer10yr:v})} />
                <Toggle label="Safety net reserve" checked={inputs.includeSafetyNet} onChange={(b)=>setInputs({...inputs, includeSafetyNet:b})} />
                {inputs.includeSafetyNet && (
                  <Field label="Safety net amount" value={inputs.safetyNetAmount} onChange={(v)=>setInputs({...inputs, safetyNetAmount:v})} />
                )}
              </div>
            </section>


            <section className="bg-white rounded-2xl shadow p-4">
              <h2 className="font-semibold mb-3">Cost Seg & Taxes</h2>
              <div className="grid grid-cols-2 gap-3">
                <Toggle label="Use cost seg (add immediate used deduction)" checked={inputs.useCostSeg} onChange={(b)=>setInputs({...inputs, useCostSeg:b})} />
                <Toggle label="REPS / STR (ignore cap)" checked={inputs.repsOrSTR} onChange={(b)=>setInputs({...inputs, repsOrSTR:b})} />
                <Field label="Land %" step={0.01} value={inputs.landPct} onChange={(v)=>setInputs({...inputs, landPct:v})} />
                <Field label="Reclass % of impr" step={0.01} value={inputs.reclassPct} onChange={(v)=>setInputs({...inputs, reclassPct:v})} />
                <Field label="Bonus % (eligible)" step={0.01} value={inputs.bonusPct} onChange={(v)=>setInputs({...inputs, bonusPct:v})} />
                <Field label="Tax bracket" step={0.01} value={inputs.taxBracket} onChange={(v)=>setInputs({...inputs, taxBracket:v})} />
                <Field label="MAGI" value={inputs.magi} onChange={(v)=>setInputs({...inputs, magi:v})} />
                <Field label="Other passive income (Yr-1)" value={inputs.otherPassiveIncome} onChange={(v)=>setInputs({...inputs, otherPassiveIncome:v})} />
                <Field label="Study fee" value={inputs.studyFee} onChange={(v)=>setInputs({...inputs, studyFee:v})} />
              </div>
              <p className="text-xs text-neutral-500 mt-2">Non‑REPS special allowance cap: {currency(r.specialAllowance)} (Pub 925 phase‑out @ $100k–$150k MAGI). Immediate used deduction = min(available, cap+passive).</p>
            </section>


            <section className="bg-white rounded-2xl shadow p-4">
              <h2 className="font-semibold mb-3">S&P Benchmark</h2>
              <div className="grid grid-cols-2 gap-3">
                <Field label="S&P annualized return" step={0.0001} value={inputs.spAnnualReturn} onChange={(v)=>setInputs({...inputs, spAnnualReturn:v})} helper="Set to 10yr, 25yr, or 30yr CAGR as needed." />
              </div>
              <div className="flex gap-2 mt-2 text-xs">
                <button className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200" onClick={()=>setInputs({...inputs, spAnnualReturn:0.1465, horizonYears:10})}>10y 14.65%</button>
                <button className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200" onClick={()=>setInputs({...inputs, spAnnualReturn:0.09, horizonYears:25})}>25y 9% (placeholder)</button>
                <button className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200" onClick={()=>setInputs({...inputs, spAnnualReturn:0.095, horizonYears:30})}>30y 9.5% (placeholder)</button>
              </div>
            </section>
          </div>


          {/* Results */}
          <div className="lg:col-span-2 space-y-6">
            <section className="bg-white rounded-2xl shadow p-4">
              <h2 className="font-semibold mb-4">Headlines</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Metric label="Real Estate — base (pre-tax)" value={r.reBaseNet} />
                <Metric label="Real Estate — with cost seg (used now)" value={r.reWithCostSeg} />
                <Metric label="Stocks — same cash timing" value={r.stocksNet} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                <KV label="Out-of-pocket" value={currency(r.outOfPocket)} />
                <KV label="Multiple (base)" value={r.multipleBase.toFixed(2) + '×'} />
                <KV label="Multiple (with CS)" value={r.multipleCS.toFixed(2) + '×'} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                <KV label="Appreciation annual" value={(r.apprAnnual*100).toFixed(2) + '%/yr'} />
                <KV label="Principal paydown (scaled)" value={currency(r.principalPaydown)} />
                <KV label="IRR (annual)" value={r.annualIRR != null ? (r.annualIRR*100).toFixed(1) + '%/yr' : '—'} />
              </div>
            </section>


            <section className="bg-white rounded-2xl shadow p-4">
              <h2 className="font-semibold mb-4">Bar Chart — Net Gain over Contributions</h2>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="key" hide/>
                    <YAxis tickFormatter={(v)=>'$'+(v/1000).toFixed(0)+'k'} />
                    <Tooltip formatter={(v: any)=>currency(Number(v))} />
                    <Bar dataKey="value" fill="#4f46e5" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="text-xs text-neutral-500 mt-2">Stocks mirror only initial capital (down payment + safety net), not rents or recurring fees. Property IRR includes monthly ops and terminal value (appreciation + principal).</div>
            </section>


            <section className="bg-white rounded-2xl shadow p-4">
              <h2 className="font-semibold mb-3">Cost Seg — Year‑1 Usability</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                <KV label="Improvement basis (80%)" value={currency(inputs.purchasePrice * (1 - inputs.landPct))} />
                <KV label="Bonus-eligible (reclass×bonus)" value={currency(r.bonusEligible)} />
                <KV label="Year‑1 SL on remainder" value={currency(r.slYear1)} />
                <KV label="Immediate available" value={currency(r.immediateAvailable)} />
                <KV label="Immediate cap (Pub 925 + passive)" value={r.immediateCap === Infinity ? 'Unlimited (REPS/STR)' : currency(r.immediateCap)} />
                <KV label="Immediate used (capped)" value={currency(r.immediateUsed)} />
                <KV label="Tax savings now (@bracket)" value={currency(r.immediateTaxSavings)} />
              </div>
              <p className="text-xs text-neutral-500 mt-2">Breakeven immediate deduction for a study fee {currency(inputs.studyFee)} at {Math.round(inputs.taxBracket*100)}% bracket is {currency(inputs.studyFee/inputs.taxBracket)}. Anything you can’t use Year‑1 becomes a suspended passive loss unless you’re REPS/STR or offset with passive income.</p>
            </section>


            <section className="bg-white rounded-2xl shadow p-4 text-xs text-neutral-500">
              <p>Notes: Cost segregation reclassifies parts of the building to shorter lives; you don’t stack SL and CS on the same dollars. Bonus depreciation percentage depends on placed‑in‑service date and rules in effect. Accelerated items are generally §1245 recapture at ordinary rates on disposition; building SL is unrecaptured §1250 up to 25%. This is an educational model; confirm tax treatment with your CPA.</p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}


// ---------------------------
// Small UI helpers
// ---------------------------


function Field({ label, value, onChange, step=1, helper }: { label: string; value: number; onChange: (v:number)=>void; step?: number; helper?: string }) {
  return (
    <label className="block text-sm">
      <div className="mb-1 text-neutral-700">{label}</div>
      <input type="number" step={step} value={value}
        onChange={(e)=>onChange(parseFloat(e.target.value))}
        className="w-full rounded-xl border border-neutral-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      {helper && <div className="mt-1 text-xs text-neutral-500">{helper}</div>}
    </label>
  );
}


function Toggle({ label, checked, onChange }: { label:string; checked:boolean; onChange:(b:boolean)=>void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e)=>onChange(e.target.checked)} className="h-4 w-4"/>
      <span>{label}</span>
    </label>
  );
}


function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-lg md:text-xl font-semibold">{currency(value)}</div>
    </div>
  );
}


function KV({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-neutral-100 p-3 bg-neutral-50">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}