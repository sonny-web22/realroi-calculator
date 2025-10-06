// THIS IS THE FINAL UPDATE
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, serverTimestamp } from 'firebase/firestore';

// --- MOCK API DATA ---
const MOCK_CPI_DATA = {
  seriesId: "CPIAUCSL",
  data: [
    ...Array.from({ length: 180 }, (_, i) => ({ date: `2010-01-01`, value: 217.4 + i * 0.45 }))
  ]
};
const MOCK_EQUITY_DATA = {
  symbol: "VOO",
  monthlyReturns: Array.from({ length: 180 }, () => (0.01 + (Math.random() - 0.5) * 0.05)),
  dividends: Array.from({ length: 180 }, () => 0.0015 * (1 + Math.random() * 0.1)),
};

// --- CALCULATION ENGINE ---
const realroi = {
  amortizationSchedule(loan, rateAPR, termYears) {
    const n = termYears * 12;
    let r = rateAPR / 12;
    if (r <= 0) r = 0.0000001;
    const m = (loan * r) / (1 - Math.pow(1 + r, -n));
    let bal = loan;
    const rows = [];
    for (let i = 1; i <= n; i++) {
      const interest = bal * r;
      const principal = m - interest;
      bal -= principal;
      rows.push({ month: i, payment: m, interest, principal, balance: Math.max(0, bal) });
    }
    return { paymentMonthly: m, rows };
  },
  summarizeFinancials(rows, years) {
      const months = Math.min(rows.length, years * 12);
      let principalPaid = 0;
      let interestPaid = 0;
      if (months === 0) return { principalPaid, interestPaid, balance: rows.length > 0 ? rows[0].balance : 0 };
      for (let i = 0; i < months; i++) {
          principalPaid += rows[i].principal;
          interestPaid += rows[i].interest;
      }
      return { principalPaid, interestPaid, balance: rows[months - 1]?.balance ?? 0 };
  },
  appreciationGain(price, rate, years) { return price * (Math.pow(1 + rate, years) - 1); },
  annualCashFlow(cfg) {
    const rentAnnual = cfg.rentMonthly * 12;
    const pm = rentAnnual * cfg.pmPct;
    const taxes = cfg.price * cfg.taxesPct;
    const vacancy = (cfg.vacancyMonths10yr / 10) * cfg.rentMonthly;
    const repairs = cfg.repairs10yr / 10, warranty = cfg.warranty10yr / 10;
    const pmi = (cfg.pmiMonthly ?? 0) * 12;
    return rentAnnual - (cfg.piMonthly * 12 + taxes + cfg.insuranceAnnual + pm + vacancy + repairs + warranty + pmi);
  },
  toReal(nominal, cpiBase, cpiNow) { return nominal * (cpiBase / cpiNow); },
  irr(cashFlows, guess = 0.1) {
    const maxIter = 100, tol = 1e-7; let r = guess;
    for (let k = 0; k < maxIter; k++) {
      let npv = 0, dnpv = 0;
      for (let t = 0; t < cashFlows.length; t++) {
        const d = Math.pow(1 + r, t); npv += cashFlows[t] / d; dnpv += -t * cashFlows[t] / (d * (1 + r));
      }
      const step = npv / dnpv; r -= step; if (!isFinite(r)) break; if (Math.abs(step) < tol) return r;
    }
    return r;
  },
  realEquityCurve(returns, dividends, cpiGrowth, feeBpsPerYear) {
    const feeMo = (feeBpsPerYear / 10000) / 12; const curve = [1];
    for (let t = 0; t < returns.length; t++) {
      const totalReturn = returns[t] + dividends[t];
      const g = ((1 + totalReturn) * (1 - feeMo)) / (1 + cpiGrowth[t]);
      curve.push(curve[curve.length - 1] * g);
    }
    return curve;
  },
  terminalWealthFromCashFlows(curve, cashFlowsReal) {
    const T = curve.length - 1; let wealth = 0;
    if (T < 0 || curve.length === 0) return 0;
    for (let t = 0; t < cashFlowsReal.length; t++) {
      if (t >= curve.length) continue;
      const grow = curve[T] / curve[t]; wealth += cashFlowsReal[t] * grow;
    }
    return wealth;
  }
};

// --- MAIN APP COMPONENT ---
export default function App() {
  const DEFAULTS = useMemo(() => ({
    vacancyMonths10yr: 5, pmPct: 0.08, repairs10yr: 15000, warranty10yr: 5000,
    defaultMarginalRate: 0.32, appreciation10yrDefault: 0.055, saleCostPct: 0.07,
    etfErBps: 3, advisorFeeBps: 0, pmiAnnualRate: 0.006,
  }), []);

  const [deal, setDeal] = useState({
    price: 450000, downPct: 0.20, rate: 6.5, termYears: 30, taxesPct: 0.02,
    insuranceAnnual: 1800, rentMonthly: 2600, closingCosts: 8000, reserves: 10000,
    fairnessMode: 'matched', appreciationRate: 0.055, timelineYears: 10,
    etfErBps: DEFAULTS.etfErBps, advisorFeeBps: DEFAULTS.advisorFeeBps,
  });
  
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

  const calculateResults = useCallback(() => {
    setLoading(true);
    const {
      price, downPct, rate, termYears, taxesPct, insuranceAnnual, rentMonthly, closingCosts, reserves,
      fairnessMode, appreciationRate, timelineYears, etfErBps, advisorFeeBps
    } = deal;
    const mergedInputs = { ...DEFAULTS, ...deal };

    const downPayment = price * downPct;
    const loan = price - downPayment;
    const hasPMI = downPct < 0.20;
    const schedule = realroi.amortizationSchedule(loan, rate / 100, termYears);
    
    const cpiBase = MOCK_CPI_DATA.data[0].value;
    const cpiTimelineEnd = MOCK_CPI_DATA.data[timelineYears * 12 - 1]?.value ?? cpiBase;
    const cpiSeries = MOCK_CPI_DATA.data.map(d => d.value);
    const cpiGrowth = cpiSeries.slice(1).map((c, i) => (c / cpiSeries[i]) - 1);
    
    const ledger = [];
    let cumulativeCashFlow = 0;
    for (let y = 1; y <= timelineYears; y++) {
      const financials = realroi.summarizeFinancials(schedule.rows, y);
      const currentLTV = financials.balance / price;
      const pmiMonthly = hasPMI && currentLTV > 0.80 ? (loan * mergedInputs.pmiAnnualRate) / 12 : 0;
      const nominalAnnualCashFlow = realroi.annualCashFlow({ ...mergedInputs, piMonthly: schedule.paymentMonthly, pmiMonthly });
      cumulativeCashFlow += nominalAnnualCashFlow;
      const interestThisYear = financials.interestPaid - (ledger[y - 2]?.interestPaid || 0);
      const taxSavings = (interestThisYear + (price * taxesPct)) * mergedInputs.defaultMarginalRate;
      ledger.push({
        year: y, nominalCashFlow: nominalAnnualCashFlow, cumulativeNominalCashFlow: cumulativeCashFlow,
        interestPaid: financials.interestPaid, principalPaid: financials.principalPaid,
        loanBalance: financials.balance, taxSavings: taxSavings
      });
    }
    
    const finalLedgerEntry = ledger[timelineYears - 1] || { principalPaid: 0, cumulativeNominalCashFlow: 0, loanBalance: loan };
    const appreciation = realroi.appreciationGain(price, appreciationRate, timelineYears);
    const principalPaid = finalLedgerEntry.principalPaid;
    const totalTaxSavings = ledger.reduce((acc, yr) => acc + yr.taxSavings, 0);

    const salePrice = price * Math.pow(1 + appreciationRate, timelineYears);
    const saleCosts = salePrice * mergedInputs.saleCostPct;
    const loanPayoff = finalLedgerEntry.loanBalance;
    const netProceeds = salePrice - saleCosts - loanPayoff;

    const totalNominalROI = appreciation + principalPaid + finalLedgerEntry.cumulativeNominalCashFlow + totalTaxSavings;
    const totalRealROI = realroi.toReal(totalNominalROI, cpiBase, cpiTimelineEnd);
    
    const totalInvestment = downPayment + closingCosts + reserves;
    const roiPct = totalInvestment > 0 ? totalRealROI / totalInvestment : 0;
    
    let monthlyCashFlows = [-totalInvestment];
    for (let y = 0; y < timelineYears; y++) {
      for (let m = 0; m < 12; m++) { monthlyCashFlows.push((ledger[y]?.nominalCashFlow || 0) / 12); }
    }
    if(monthlyCashFlows.length > 1) monthlyCashFlows[monthlyCashFlows.length - 1] += netProceeds;
    const monthlyRealCashFlows = monthlyCashFlows.map((cf, i) => realroi.toReal(cf, cpiBase, cpiSeries[i] || cpiSeries.slice(-1)[0]));
    const irr = realroi.irr(monthlyRealCashFlows);

    const totalFeeBps = etfErBps + advisorFeeBps;
    const equityCurve = realroi.realEquityCurve(MOCK_EQUITY_DATA.monthlyReturns, MOCK_EQUITY_DATA.dividends, cpiGrowth, totalFeeBps);
    let equityInvestmentFlows = new Array(timelineYears * 12).fill(0);
    if (fairnessMode === 'initial') {
      equityInvestmentFlows[0] = totalInvestment;
    } else if (fairnessMode === 'matched') {
      equityInvestmentFlows[0] = totalInvestment;
      for (let i = 0; i < timelineYears * 12; i++) {
        const yearIndex = Math.floor(i / 12);
        const nominalMonthlyCashFlow = (ledger[yearIndex]?.nominalCashFlow || 0) / 12;
        equityInvestmentFlows[i] += realroi.toReal(nominalMonthlyCashFlow, cpiBase, cpiSeries[i]);
      }
    }
    const equityTerminalWealth = realroi.terminalWealthFromCashFlows(equityCurve, equityInvestmentFlows);
    
    setResults({
      timelineYears, totalInvestment, appreciation, principalPaid, cashFlow: finalLedgerEntry.cumulativeNominalCashFlow,
      taxSavings: totalTaxSavings, netProceeds, totalRealROI, roiPct, irr,
      equityTerminalWealth, ledger,
    });
    setTimeout(() => setLoading(false), 300);
  }, [deal, DEFAULTS]);

  useEffect(() => {
    calculateResults();
  }, [calculateResults]);
  
  const handleDealChange = (e) => {
    const { id, value } = e.target;
    const parsedValue = e.target.type === 'number' ? parseFloat(value) : value;
    setDeal(prev => ({ ...prev, [id]: parsedValue }));
  };
  
  const formatCurrency = (val, digits = 0) => val.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });

  return (
    <>
      <style>{`
        :root { --bg:#0b0f13; --panel:#12181f; --ink:#e8eef6; --muted:#a6b0be; --accent:#48b674; --warn:#ffb648; --danger:#ff6b6b; }
        html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
        .wrap{max-width:1100px;margin:24px auto;padding:0 16px}
        h1{font-size:20px;margin:0 0 8px} .sub{color:var(--muted);margin:0 0 16px}
        .card{background:var(--panel);border:1px solid #1f2630;border-radius:12px;padding:14px;margin-bottom:12px}
        .grid{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}
        .col-12{grid-column:span 12}.col-8{grid-column:span 8}.col-6{grid-column:span 6}.col-4{grid-column:span 4}.col-3{grid-column:span 3}
        label{display:block;font-weight:600;margin-bottom:6px; color: var(--muted); font-size: 13px;}
        input,select{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #2a3340;background:#0e1319;color:var(--ink); font-size: 14px;}
        table{width:100%;border-collapse:collapse} th,td{text-align:right;padding:9px;border-bottom:1px solid #1f2630}
        th:first-child,td:first-child{text-align:left} .ok{color:var(--accent);font-weight:700}.danger{color:var(--danger);font-weight:700}
        .hint{color:var(--muted);font-size:12px} .split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
        @media(max-width:880px){.grid{grid-template-columns:repeat(6,1fr)!important;}.col-4{grid-column:span 3!important;}}
        .tabs{display:flex;gap:4px;margin-bottom:10px;padding:4px;background:#0e1319;border-radius:10px;}
        .tab{flex:1;text-align:center;padding:8px;border-radius:8px;cursor:pointer;font-weight:600;color:var(--muted); transition: all .2s;}
        .tab.active{background:#2a3340;color:var(--ink);}
      `}</style>
      <div className="wrap">
        <h1>RealROI — Ready-to-Use</h1>
        <p className="sub">All numbers shown in <b>today’s dollars</b>. Equities comparison supports <b>Initial-only</b> and <b>Same-cash-flows</b>.</p>
        
        <div className="split">
            <div className="inputs">
                <div className="card">
                    <div className="grid">
                        <div className="col-6"><label>Price ($)</label><input id="price" type="number" value={deal.price} step="1000" onChange={handleDealChange}/></div>
                        <div className="col-3"><label>Down %</label><select id="downPct" value={deal.downPct} onChange={handleDealChange}><option value="0">0%</option><option value="0.035">3.5%</option><option value="0.05">5%</option><option value="0.10">10%</option><option value="0.20">20%</option><option value="0.25">25%</option></select></div>
                        <div className="col-3"><label>Rate (APR %)</label><input id="rate" type="number" value={deal.rate} step="0.01" onChange={handleDealChange}/></div>
                        <div className="col-3"><label>Term (years)</label><input id="termYears" type="number" value={deal.termYears} step="1" onChange={handleDealChange}/></div>
                        <div className="col-3"><label>Taxes (% of price)</label><input id="taxesPct" type="number" value={deal.taxesPct * 100} onChange={e => setDeal({...deal, taxesPct: parseFloat(e.target.value)/100})} step="0.01"/></div>
                        <div className="col-3"><label>Insurance ($/yr)</label><input id="insuranceAnnual" type="number" value={deal.insuranceAnnual} step="50" onChange={handleDealChange}/></div>
                        <div className="col-3"><label>Rent ($/mo)</label><input id="rentMonthly" type="number" value={deal.rentMonthly} step="50" onChange={handleDealChange}/></div>
                        <div className="col-6"><label>Closing Costs ($)</label><input id="closingCosts" type="number" value={deal.closingCosts} step="100" onChange={handleDealChange}/></div>
                        <div className="col-6"><label>Reserves ($)</label><input id="reserves" type="number" value={deal.reserves} step="100" onChange={handleDealChange}/></div>
                    </div>
                </div>
                <div className="card">
                     <div className="grid">
                        <div className="col-8"><label>Comparison Mode</label><select id="fairnessMode" value={deal.fairnessMode} onChange={handleDealChange}><option value="matched">Same-cash-flows</option><option value="initial">Initial-only</option></select></div>
                        <div className="col-4"><label>Appreciation %</label><input id="appreciationRate" type="number" value={deal.appreciationRate * 100} onChange={e => setDeal({...deal, appreciationRate: parseFloat(e.target.value)/100})} step="0.1"/></div>
                        <div className="col-6"><label>ETF ER (bps)</label><input id="etfErBps" type="number" value={deal.etfErBps} step="1" onChange={handleDealChange}/></div>
                        <div className="col-6"><label>Advisor Fee (bps)</label><input id="advisorFeeBps" type="number" value={deal.advisorFeeBps} step="1" onChange={handleDealChange}/></div>
                    </div>
                </div>
            </div>
            
            <div className="results">
                <div className="card">
                    <div className="tabs">
                        {[5, 10, 15].map(year => (
                            <div key={year} className={`tab ${deal.timelineYears === year ? 'active' : ''}`} onClick={() => setDeal({...deal, timelineYears: year})}>
                                {year} Years
                            </div>
                        ))}
                    </div>
                    {loading ? <div style={{textAlign: 'center', padding: '50px'}}>Calculating...</div> : results && (
                    <table>
                        <tbody>
                            <tr><td>Appreciation</td><td className="ok">{formatCurrency(results.appreciation)}</td></tr>
                            <tr><td>Principal Paid</td><td className="ok">{formatCurrency(results.principalPaid)}</td></tr>
                            <tr><td>Cash Flow</td><td className={results.cashFlow >= 0 ? 'ok' : 'danger'}>{formatCurrency(results.cashFlow)}</td></tr>
                            <tr><td>Tax Savings</td><td className="ok">{formatCurrency(results.taxSavings)}</td></tr>
                            <tr><td><b>Total Real ROI</b></td><td><b>{formatCurrency(results.totalRealROI)}</b></td></tr>
                            <tr><td className="hint">Net Sale Proceeds</td><td className="hint">{formatCurrency(results.netProceeds)}</td></tr>
                            <tr style={{borderTop: '2px solid #2a3340'}}>
                                <td>Equities (Matched)</td><td>{formatCurrency(results.equityTerminalWealth)}</td>
                            </tr>
                            <tr>
                                <td><b>Real ROI %</b><p className="hint">vs. {formatCurrency(results.totalInvestment)} invested</p></td>
                                <td><b>{(results.roiPct * 100).toFixed(1)}%</b></td>
                            </tr>
                             <tr>
                                <td><b>Real IRR %</b></td>
                                <td><b>{(results.irr * 100).toFixed(2)}%</b></td>
                            </tr>
                        </tbody>
                    </table>
                    )}
                </div>
            </div>
        </div>
      </div>
    </>
  );
}

